import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

describe("PaperclipRunnerToolAuthority", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const companyId = "00000000-0000-4000-8000-000000000101";
  const agentId = "00000000-0000-4000-8000-000000000102";
  const issueId = "00000000-0000-4000-8000-000000000103";
  const runId = "00000000-0000-4000-8000-000000000104";

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-runner-tools-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Runner tools", issuePrefix: "RNT" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runner agent",
      adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" },
      runtimeConfig: {},
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RNT-1",
      title: "Exercise real runner tools",
      status: "in_progress",
      workMode: "standard",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
  });

  afterAll(async () => {
    await temporary?.cleanup();
  });

  it("advertises only real bindings and reads the bound task", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    expect(authority.definitions().map((tool) => tool.name)).toEqual(["get_task_context", "report_progress"]);
    await expect(authority.execute({ tool: "get_task_context", callId: "context", arguments: {} }))
      .resolves.toMatchObject({ activeTask: { id: issueId, identifier: "RNT-1" }, actor: { id: agentId } });
    await expect(authority.execute({ tool: "finish_task", callId: "hidden", arguments: {} }))
      .rejects.toThrow("paperclip_runner_tool_not_advertised");
  });

  it("writes progress through the real issue service and replays idempotently", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    const call = {
      tool: "report_progress",
      callId: "progress",
      arguments: { body: "Runner progress", idempotencyKey: "progress-1" },
    };
    const first = await authority.execute(call);
    const replay = await authority.execute({ ...call, callId: "progress-replay" });
    expect(replay).toEqual(first);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId)))
      .toHaveLength(1);
    await expect(authority.execute({
      ...call,
      arguments: { body: "Changed", idempotencyKey: "progress-1" },
    })).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
  });

  it("fails closed once the run is no longer active", async () => {
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    await expect(authority.execute({ tool: "get_task_context", callId: "late", arguments: {} }))
      .rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
  });
});
