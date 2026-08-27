// Process-level fatal-error handler for `uncaughtException` and
// `unhandledRejection`.
//
// The server registers neither handler today, so Node ends the process on
// either event by default (its built-in crash behavior). Registering a
// handler cancels that default, so this module must call `process.exit(1)`
// on every path — the normal path, the path where the telemetry flush
// rejects, and the path where the flush times out. `sentry.ts` documents the
// same hazard for `unhandledRejection` and keeps `mode: "strict"` for the
// same reason; this module does not weaken that setting.
//
// This module adds measurement only. It reports one classifier — whether the
// crash matches the known Postgres driver null-socket write defect — and one
// denominator (every fatal error, matched or not). It does not change the
// crash-and-restart behavior, and it does not guard against the defect.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TelemetryClient } from "@paperclipai/shared/telemetry";
import { captureException } from "./sentry.js";
import { getTelemetryClient } from "./telemetry.js";
import { logger } from "./middleware/logger.js";

const FLUSH_TIMEOUT_MS = 2_000;

export type FatalErrorSource = "uncaught_exception" | "unhandled_rejection";

// Both V8 message spellings for a read of a property on `null`. The wording
// changed between an older V8 (`Cannot read property 'write' of null`) and a
// newer V8 (`Cannot read properties of null (reading 'write')`).
const NULL_WRITE_MESSAGE_PATTERN =
  /Cannot read propert(?:y 'write' of null|ies of null \(reading 'write'\))/;

// Matches the frame, not an absolute path, so the check survives any
// install-path prefix (a package-store path, a different path separator).
const NEXT_WRITE_FRAME_PATTERN = /\bnextWrite\b.*postgres[\\/]src[\\/]connection\.js/;

/**
 * Verdict-only fingerprint for the known Postgres driver defect: `postgres`
 * reserves a physical connection for a transaction. When the database
 * backend closes that connection, `nextWrite` still calls `socket.write` on
 * the now-null socket. This matches on three facts together — the error
 * class, the message, and the crashing frame — so an unrelated `TypeError`
 * never counts.
 */
export function isDriverNullSocketWriteCrash(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "TypeError") return false;
  if (!NULL_WRITE_MESSAGE_PATTERN.test(error.message)) return false;
  const stack = error.stack ?? "";
  return stack.split("\n").some((line) => NEXT_WRITE_FRAME_PATTERN.test(line));
}

/**
 * Reads the installed `postgres` driver's own declared version, without
 * importing or running the package. The server does not depend on
 * `postgres` directly — `@paperclipai/db` does — so this walks through that
 * package's own dependency graph, the same install the crash came from.
 * Returns "unknown" when the version cannot be read. The field is a
 * fixed-cardinality dimension: it never carries a raw path or an error.
 */
function readPostgresDriverVersion(): string {
  try {
    const requireFromHere = createRequire(import.meta.url);
    const dbEntry = requireFromHere.resolve("@paperclipai/db");
    const requireFromDb = createRequire(dbEntry);
    let dir = dirname(requireFromDb.resolve("postgres"));
    for (;;) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (parsed.name === "postgres" && typeof parsed.version === "string") {
          return parsed.version;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to the sentinel below.
  }
  return "unknown";
}

/**
 * Emits the measurement event with a dynamic event name and dimension set.
 * The generated telemetry catalogue has no generator in this repository (see
 * `generated/paperclip-telemetry.ts`), so this follows the shipped
 * `codex.credential_health` precedent — `trackDynamic`, registered in
 * `EVENT_RETENTION_CLASS` — instead of `client.track()`.
 *
 * Emits only fixed-cardinality classifiers. Never the error message, the
 * stack, query text, a connection URL, a host name, or a database name.
 */
function trackProcessFatalError(
  client: TelemetryClient,
  dims: {
    source: FatalErrorSource;
    errorCode: string;
    driverNullSocketWrite: boolean;
    postgresDriverVersion: string;
  },
): void {
  client.trackDynamic("process.fatal_error", {
    source: dims.source,
    error_code: dims.errorCode,
    driver_null_socket_write: dims.driverNullSocketWrite,
    postgres_driver_version: dims.postgresDriverVersion,
  });
}

/**
 * Awaits `client.flush()` up to `timeoutMs`, then resolves either way. Never
 * rejects: a fatal-error handler that itself throws or hangs would turn a
 * crash into a silent, undefined-state survival, the exact outcome this
 * module exists to prevent.
 *
 * The flush keeps running in the background after a timeout wins the race.
 * Attaching both branches of `.then` here, instead of leaving the promise
 * dangling, keeps a late rejection from firing as a second, unhandled
 * rejection.
 */
function flushWithTimeout(client: TelemetryClient, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    client.flush().then(finish, finish);
  });
}

/**
 * Handles one fatal error end to end: local log, Sentry report, the
 * measurement event, a bounded telemetry flush, then process exit. Exported
 * so a test can drive it directly with a fake `unhandledRejection` reason or
 * a fake telemetry client, instead of dispatching a real process event.
 */
export async function handleFatalError(error: unknown, source: FatalErrorSource): Promise<void> {
  const rootError = error instanceof Error ? error : new Error(String(error));
  try {
    logger.fatal({ err: rootError, source }, "fatal error; process exiting");
    captureException(rootError);
    const client = getTelemetryClient();
    if (client) {
      trackProcessFatalError(client, {
        source,
        errorCode: rootError.name,
        driverNullSocketWrite: isDriverNullSocketWriteCrash(rootError),
        postgresDriverVersion: readPostgresDriverVersion(),
      });
      await flushWithTimeout(client, FLUSH_TIMEOUT_MS);
    }
  } catch {
    // An observability failure must never change the exit path below.
  } finally {
    process.exit(1);
  }
}

/**
 * Registers the process-level fatal-error handlers. Node ends the process on
 * an uncaught exception or an unhandled rejection today because the server
 * registers neither handler. This function measures the crash, then ends the
 * process itself on every path — see the module comment above.
 */
export function registerFatalErrorHandlers(): void {
  process.on("uncaughtException", (error) => {
    void handleFatalError(error, "uncaught_exception");
  });
  process.on("unhandledRejection", (reason) => {
    void handleFatalError(reason, "unhandled_rejection");
  });
}
