import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, documents, heartbeatRuns, issueComments, issueThreadInteractions, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { documentService } from "../documents.js";
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
    expect(authority.definitions()).toHaveLength(14);
    expect(authority.definitions().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "get_task_context", "get_task_history", "search_tasks", "report_progress",
      "request_human_input",
      "list_documents", "read_document", "list_document_revisions", "write_document",
      "list_agents", "get_agent", "list_approvals", "get_approval", "get_approval_context",
    ]));
    await expect(authority.execute({ tool: "get_task_context", callId: "context", arguments: {} }))
      .resolves.toMatchObject({ activeTask: { id: issueId, identifier: "RNT-1" }, actor: { id: agentId } });
    await expect(authority.execute({ tool: "finish_task", callId: "hidden", arguments: {} }))
      .rejects.toThrow("paperclip_runner_tool_not_advertised");
  });

  it("advertises structured human input in ask mode", () => {
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId,
      runId,
      workMode: "ask",
    });
    expect(authority.definitions().map((tool) => tool.name)).toContain("request_human_input");
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
    const progressActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(progressActivity).toHaveLength(1);
    expect(progressActivity[0]).toMatchObject({
      action: "issue.comment_added",
      actorType: "agent",
      actorId: agentId,
      agentId,
      runId,
      entityType: "issue",
      entityId: issueId,
      details: expect.objectContaining({
        bodySnippet: "Runner progress",
        identifier: "RNT-1",
        issueTitle: "Exercise real runner tools",
        source: "paperclip_runner_protocol",
      }),
    });
    await expect(authority.execute({
      ...call,
      arguments: { body: "Changed", idempotencyKey: "progress-1" },
    })).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
  });

  it("creates checkbox interactions through the real interaction service", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    await expect(authority.execute({
      tool: "request_human_input",
      callId: "ask-checkbox",
      arguments: {
        idempotencyKey: "favorite-animals",
        interactionKind: "checkbox",
        title: "Favorite zoo animals",
        prompt: "Which zoo animals are your favorites?",
        continuationPolicy: "wake_assignee",
        payload: {
          options: [
            { id: "giraffes", label: "Giraffes" },
            { id: "lions", label: "Lions" },
          ],
        },
      },
    })).resolves.toMatchObject({
      interaction: { kind: "request_checkbox_confirmation", status: "pending" },
    });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.issueId, issueId)))
      .toHaveLength(1);
  });

  it("writes a real revisioned document and replays the mutation receipt", async () => {
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    const call = {
      tool: "write_document",
      callId: "write-plan",
      arguments: {
        idempotencyKey: "write-plan-1",
        key: "plan",
        title: "Execution plan",
        body: "Use the real document service.",
        // OpenCode serializes nullable string inputs as the literal "null".
        // The protocol boundary must treat that as document creation.
        baseRevisionId: "null",
        changeSummary: "Initial plan",
      },
    };
    const first = await authority.execute(call);
    const replay = await authority.execute({ ...call, callId: "write-plan-replay" });
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      disposition: "applied",
      created: true,
      document: { key: "plan", body: "Use the real document service." },
    });
    expect(await db.select().from(documents).where(eq(documents.companyId, companyId))).toHaveLength(1);
    const documentActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId));
    expect(documentActivity.filter((entry) => entry.action === "issue.document_created")).toEqual([
      expect.objectContaining({
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId,
        entityType: "issue",
        details: expect.objectContaining({
          key: "plan",
          source: "paperclip_runner_protocol",
        }),
      }),
    ]);
    await expect(authority.execute({
      ...call,
      arguments: { ...call.arguments, body: "Conflicting retry." },
    })).rejects.toThrow("paperclip_runner_tool_idempotency_conflict");
  });

  it("creates and wakes one durable implementation child after plan acceptance", async () => {
    const planningIssueId = "00000000-0000-4000-8000-000000000105";
    const planningRunId = "00000000-0000-4000-8000-000000000106";
    await db.insert(issues).values({
      id: planningIssueId,
      companyId,
      issueNumber: 2,
      identifier: "RNT-2",
      title: "Plan then implement",
      status: "in_progress",
      workMode: "planning",
      assigneeAgentId: agentId,
    });
    await db.update(issues).set({ issueNumber: 1 }).where(eq(issues.id, issueId));
    await db.update(companies).set({ issueCounter: 2 }).where(eq(companies.id, companyId));
    await db.insert(heartbeatRuns).values({
      id: planningRunId,
      companyId,
      agentId,
      status: "running",
      runtimeMode: "native",
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { issueId: planningIssueId },
    });
    await db.update(issues).set({ executionRunId: planningRunId }).where(eq(issues.id, planningIssueId));
    const written = await documentService(db).upsertIssueDocument({
      issueId: planningIssueId,
      key: "plan",
      title: "Approved plan",
      format: "markdown",
      body: "Implement and test the utility.",
      baseRevisionId: null,
      changeSummary: "Initial plan",
      createdByAgentId: agentId,
      createdByRunId: planningRunId,
    });
    const planningAuthority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId: planningIssueId,
      runId: planningRunId,
      workMode: "planning",
    });
    const requested = await planningAuthority.execute({
      tool: "request_human_input",
      callId: "approve-plan",
      arguments: {
        idempotencyKey: `confirmation:${planningIssueId}:plan:${written.document.latestRevisionId}`,
        interactionKind: "confirmation",
        title: "Approve the plan",
        prompt: "Approve this exact plan revision?",
        payload: {},
        targetRevisionId: written.document.latestRevisionId,
        continuationPolicy: "wake_assignee_on_accept",
      },
    });
    expect(requested).toMatchObject({
      interaction: {
        kind: "request_confirmation",
        status: "pending",
        payload: {
          target: {
            type: "issue_document",
            issueId: planningIssueId,
            key: "plan",
            revisionId: written.document.latestRevisionId,
          },
        },
      },
    });
    await db.update(issueThreadInteractions).set({
      status: "accepted",
      resolvedByUserId: "test-user",
      resolvedAt: new Date(),
      result: { outcome: "accepted" } as never,
    }).where(eq(issueThreadInteractions.issueId, planningIssueId));
    const wakes: Array<{ agentId: string; options: Record<string, unknown> }> = [];
    const authority = new PaperclipRunnerToolAuthority(db, {
      companyId,
      agentId,
      issueId: planningIssueId,
      runId: planningRunId,
      workMode: "planning",
      acceptedPlanContinuation: true,
      enqueueWakeup: async (wakeAgentId, options) => {
        wakes.push({ agentId: wakeAgentId, options });
        return null;
      },
    });
    expect(authority.definitions().map((tool) => tool.name)).toContain("create_task");

    const result = await authority.execute({
      tool: "create_task",
      callId: "create-implementation-child",
      arguments: {
        idempotencyKey: "approved-plan-child",
        title: "Implement the approved plan",
        description: "Implement and test the utility from the accepted parent plan.",
      },
    });

    expect(result).toMatchObject({
      disposition: "applied",
      acceptedPlanRevisionId: written.document.latestRevisionId,
      childIssue: {
        parentId: planningIssueId,
        workMode: "standard",
        status: "todo",
        assigneeAgentId: agentId,
      },
    });
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentId,
      options: {
        reason: "issue_assigned",
        payload: { parentIssueId: planningIssueId },
      },
    });
    expect(await db.select().from(issues).where(eq(issues.parentId, planningIssueId)))
      .toHaveLength(1);
  });

  it("fails closed once the run is no longer active", async () => {
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId });
    await expect(authority.execute({ tool: "get_task_context", callId: "late", arguments: {} }))
      .rejects.toThrow("paperclip_runner_tool_binding_not_authorized");
  });
});
