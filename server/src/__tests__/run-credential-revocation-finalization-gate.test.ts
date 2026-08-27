import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  runCredentialRevocations,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { isRunScopedCredentialRevoked } from "../services/run-credential-revocation.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService, type HeartbeatEnvironmentRuntime } from "../services/heartbeat.ts";

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

    await db.delete(runCredentialRevocations);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
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

  async function seedPendingRevocationRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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
    // The run stands in for one whose duplex control channel was lost: its
    // teardown already tried and failed to durably revoke the run-scoped
    // credential, so its context snapshot carries the pending marker the
    // finalization gate checks before it lets a terminal status land.
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "assignment",
      startedAt: new Date(),
      contextSnapshot: { runCredentialRevocationPending: true },
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

  it("holds the run open through a revocation-write failure, then finalizes once a retry lands the row and rejects the live token", async () => {
    const { companyId, runId, token } = await seedPendingRevocationRun();

    // The first durable revocation insert fails, the way a transient database
    // fault would. The finalization gate must not let a terminal status land
    // without the revocation row.
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

  it("does not touch the revocation table for a run with no pending marker", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
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

    const heartbeat = heartbeatService(db, { environmentRuntime: fakeEnvironmentRuntime });
    const result = await heartbeat.terminalizeRunOnLeaseRelease(await runRow(runId));

    // A run that never lost its duplex channel finalizes exactly as before:
    // the gate is a no-op when the pending marker is absent.
    expect(result.status).toBe("interrupted");
    expect(await isRunScopedCredentialRevoked(db, { companyId, runId })).toBe(false);
  });
});
