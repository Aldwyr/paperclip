import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  runCredentialRevocations,
  workspaceOperations,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { isRunScopedCredentialRevoked } from "../services/run-credential-revocation.js";
import { DUPLEX_CHANNEL_LOST_ERROR_CODE } from "@paperclipai/adapter-utils/bridge-transport-contract";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

// Drives the real finalization gate at the end of `executeRun`, not a
// reproduction of it: the adapter reports a lost duplex channel, exactly the
// signal the gate keys on. Everything before that point in `executeRun` is
// real production code; only the adapter's `execute` call is a test double,
// so the run cannot depend on a real sandbox process.
const mockDuplexChannelLostAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorMessage: "sandbox duplex control channel lost",
    errorCode: DUPLEX_CHANNEL_LOST_ERROR_CODE,
    summary: "Adapter reported a lost duplex channel.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockDuplexChannelLostAdapterExecute,
    })),
  };
});

import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-credential-revocation finalization-gate tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Wraps a real drizzle `Db` and makes the first `failures` inserts into
// `runCredentialRevocations` reject, then lets every later call (on that
// table or any other) go through untouched. This forces the durable
// revocation write to fail the way a transient database fault would, without
// touching any other table, so the test can prove the finalization gate
// reacts to exactly that failure and recovers once the write starts landing
// again.
function withFailingRevocationInsert(realDb: Db, failures: number): Db {
  let remaining = failures;
  return new Proxy(realDb, {
    get(target, prop, receiver) {
      if (prop === "insert") {
        return (table: unknown) => {
          if (table === runCredentialRevocations && remaining > 0) {
            remaining -= 1;
            return {
              values: () => ({
                onConflictDoNothing: () =>
                  Promise.reject(new Error("simulated durable revocation insert fault")),
              }),
            };
          }
          return (target.insert as (t: unknown) => unknown)(table);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Db;
}

describeEmbeddedPostgres("run-credential revocation gates terminal run finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-cred-revocation-gate-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "run-cred-revocation-gate-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  afterEach(async () => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;

    mockDuplexChannelLostAdapterExecute.mockClear();
    runningProcesses.clear();
    // A wakeup dispatches its run execution fire-and-forget, so drain every
    // in-flight execution before the deletes below, or a late write can race
    // them and trip a foreign-key check.
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(runCredentialRevocations);
    await db.delete(activityLog);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(companySkills);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function buildApp() {
    const { actorMiddleware } = await import("../middleware/auth.js");
    const { errorHandler } = await import("../middleware/error-handler.js");
    const app = express();
    app.use(actorMiddleware(db, { deploymentMode: "local_trusted" }));
    app.get("/actor", (req, res) => {
      res.json(req.actor);
    });
    app.use(errorHandler);
    return app;
  }

  async function seedRunningRun(prefix: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `${prefix}${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
      contextSnapshot: {},
    });

    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");
    expect(token).toBeTruthy();

    return { companyId, agentId, runId, token: token! };
  }

  async function runRow(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0]!);
  }

  const fakeEnvironmentRuntime = {
    releaseRunLeases: async () => [],
  } as unknown as HeartbeatEnvironmentRuntime;

  it("holds a running run open through a revocation-write failure, then finalizes once a retry lands the row and rejects the live token", async () => {
    const { companyId, runId, token } = await seedRunningRun("G");

    // Drive the real finalization backstop, not a seeded marker. The first
    // durable revocation insert fails, the way a transient database fault
    // would. The gate must not let a terminal status land without the
    // revocation row.
    const faultyDb = withFailingRevocationInsert(db, 1);
    const heartbeatWithFaultyDb = heartbeatService(faultyDb, { environmentRuntime: fakeEnvironmentRuntime });

    const runBeforeRetry = await runRow(runId);
    const resultAfterFailure = await heartbeatWithFaultyDb.terminalizeRunOnLeaseRelease(runBeforeRetry);

    // The run did not reach a finalized terminal state.
    expect(resultAfterFailure.status).toBe("running");
    const dbRowAfterFailure = await runRow(runId);
    expect(dbRowAfterFailure.status).toBe("running");

    // The revocation row does not exist yet, and the token this run issued is
    // still accepted — the exact window the fix must not let outlive the run.
    expect(await isRunScopedCredentialRevoked(db, { companyId, runId })).toBe(false);
    const acceptedBeforeRecovery = await request(await buildApp())
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);
    expect(acceptedBeforeRecovery.status).toBe(200);

    // Database access recovers. A later pass over the same still-running run
    // (the production lease-release boundary, or the stale-run recovery
    // sweep) retries the same durable write using a healthy connection.
    const heartbeatWithRecoveredDb = heartbeatService(db, { environmentRuntime: fakeEnvironmentRuntime });
    const runForRetry = await runRow(runId);
    const resultAfterRetry = await heartbeatWithRecoveredDb.terminalizeRunOnLeaseRelease(runForRetry);

    // The retry durably created the revocation row, and only then did the run
    // reach a terminal status.
    expect(await isRunScopedCredentialRevoked(db, { companyId, runId })).toBe(true);
    expect(resultAfterRetry.status).toBe("interrupted");
    const dbRowAfterRetry = await runRow(runId);
    expect(dbRowAfterRetry.status).toBe("interrupted");

    // The original, still-unexpired token is now rejected.
    const rejectedAfterRecovery = await request(await buildApp())
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);
    expect(rejectedAfterRecovery.status).toBe(401);
    expect(rejectedAfterRecovery.body.error).toContain("revoked");
  });

  it("holds a run open through a revocation-write failure at the primary finalization gate, driven end to end from a real adapter result", async () => {
    // Drive the real production path: heartbeat.wakeup queues a run and
    // dispatches executeRun, which calls the (mocked) adapter, reads back a
    // lost-duplex-channel error code, and reaches the finalization gate at
    // the same point a live sandbox teardown would. Only the adapter call
    // itself is a test double; the gate, the write, and the run-status update
    // around it are all real.
    const companyId = randomUUID();
    const agentId = randomUUID();
    const triggeringUserId = `manual-${randomUUID()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `J${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true } },
      permissions: {},
    });

    // The teardown in the same executeRun call retries the same write once
    // more, immediately, through the lease-release backstop (see the
    // `finally` block around heartbeat.ts:17091-17101). Fail both attempts,
    // so only the primary finalization gate — not that immediate retry — is
    // under test here: a hold that survives just the first fault would also
    // pass with the gate itself deleted.
    const faultyDb = withFailingRevocationInsert(db, 2);
    // No environmentRuntime override here: unlike the direct-call tests
    // above, this test drives the real lease-acquire path too, so it needs
    // the service's real default runtime, not the release-only fake.
    const heartbeatWithFaultyDb = heartbeatService(faultyDb);

    const run = await heartbeatWithFaultyDb.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
      requestedByActorId: triggeringUserId,
    });
    expect(run).not.toBeNull();
    await heartbeatWithFaultyDb.drainActiveRunExecutions();

    // The adapter reported a lost duplex channel, and both durable
    // revocation-write attempts failed. The run must stay open, not reach a
    // terminal status.
    expect(mockDuplexChannelLostAdapterExecute).toHaveBeenCalledTimes(1);
    const rowAfterFailure = await runRow(run!.id);
    expect(["queued", "running"]).toContain(rowAfterFailure.status);
    expect(await isRunScopedCredentialRevoked(db, { companyId, runId: run!.id })).toBe(false);
  });

  it("does not write a revocation row for a run that already reached a terminal status on the normal path", async () => {
    // A healthy run finalizes through the primary path and never reaches this
    // backstop while still "running" or "queued". Seed the row already
    // terminal, the way the normal path leaves it, and prove the backstop
    // makes no revocation write for it.
    const { companyId, runId } = await seedRunningRun("H");
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, runId));

    const heartbeat = heartbeatService(db, { environmentRuntime: fakeEnvironmentRuntime });
    const result = await heartbeat.terminalizeRunOnLeaseRelease(await runRow(runId));

    expect(result.status).toBe("succeeded");
    expect(await isRunScopedCredentialRevoked(db, { companyId, runId })).toBe(false);
  });
});
