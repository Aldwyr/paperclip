import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, runCredentialRevocations } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { isRunScopedCredentialRevoked, revokeRunScopedCredential } from "../services/run-credential-revocation.js";
import type { Db } from "@paperclipai/db";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-scoped credential revocation durability tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Import the middleware and its error handler together, on demand, instead of
// once at the top of the file. A test below calls `vi.resetModules()` to
// simulate a host restart; pairing a freshly reloaded `actorMiddleware` with
// a stale, statically imported `errorHandler` would compare an `HttpError`
// thrown by the fresh module against the OLD module's class reference, and
// `instanceof` would wrongly say no.
async function buildApp(db: Db) {
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

describeEmbeddedPostgres("run-scoped credential revocation durability", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-cred-revocation-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "run-cred-revocation-secret";
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
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(companyId: string) {
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function seedAgent(input: { companyId: string; agentId: string }) {
    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }

  async function seedRun(input: { companyId: string; agentId: string; runId: string }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "running",
    });
  }

  async function seedCompanyAgentRun(input: { companyId: string; agentId: string; runId: string }) {
    await seedCompany(input.companyId);
    await seedAgent(input);
    await seedRun(input);
  }

  it("denies an old, unexpired token after the module boundary rebuilds against the same database", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await seedCompanyAgentRun({ companyId, agentId, runId });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");
    expect(token).toBeTruthy();

    const before = await request(await buildApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);
    expect(before.status).toBe(200);

    await revokeRunScopedCredential(db, { companyId, runId });

    // Simulate a host restart: clear the module registry, so the app built
    // next re-imports the whole auth path fresh and no in-process state from
    // the revoke call above can leak into the check below. Only the database
    // survives.
    vi.resetModules();
    const after = await request(await buildApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.error).toContain("revoked");
  });

  it("still authenticates a run that was never revoked", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await seedCompanyAgentRun({ companyId, agentId, runId });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const revoked = await isRunScopedCredentialRevoked(db, { companyId, runId });
    expect(revoked).toBe(false);

    const res = await request(await buildApp(db)).get("/actor").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("scopes a revocation to its own company and run, leaving a different company or run unaffected", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const otherCompanyAgentId = randomUUID();
    const revokedRunId = randomUUID();
    const liveRunId = randomUUID();
    const otherCompanyRunId = randomUUID();
    await seedCompany(companyId);
    await seedAgent({ companyId, agentId });
    await seedAgent({ companyId, agentId: otherAgentId });
    await seedRun({ companyId, agentId, runId: revokedRunId });
    await seedRun({ companyId, agentId: otherAgentId, runId: liveRunId });
    await seedCompanyAgentRun({
      companyId: otherCompanyId,
      agentId: otherCompanyAgentId,
      runId: otherCompanyRunId,
    });

    await revokeRunScopedCredential(db, { companyId, runId: revokedRunId });
    // Idempotent: revoking the same company/run again is a no-op, not a conflict error.
    await revokeRunScopedCredential(db, { companyId, runId: revokedRunId });

    expect(await isRunScopedCredentialRevoked(db, { companyId, runId: revokedRunId })).toBe(true);
    expect(await isRunScopedCredentialRevoked(db, { companyId, runId: liveRunId })).toBe(false);
    // Same run id, different company: a revocation never crosses a company boundary.
    expect(await isRunScopedCredentialRevoked(db, { companyId: otherCompanyId, runId: revokedRunId })).toBe(false);
    expect(await isRunScopedCredentialRevoked(db, { companyId: otherCompanyId, runId: otherCompanyRunId })).toBe(
      false,
    );
  });
});

describe("isRunScopedCredentialRevoked fails closed on a lookup fault", () => {
  it("denies the request when the durable lookup throws", async () => {
    const brokenDb = {
      select: () => {
        throw new Error("connection to database lost");
      },
    } as unknown as Parameters<typeof isRunScopedCredentialRevoked>[0];

    const revoked = await isRunScopedCredentialRevoked(brokenDb, {
      companyId: randomUUID(),
      runId: randomUUID(),
    });

    expect(revoked).toBe(true);
  });
});
