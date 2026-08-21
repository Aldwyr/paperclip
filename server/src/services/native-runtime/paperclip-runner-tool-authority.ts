import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issueApprovals, issueComments, issues } from "@paperclipai/db";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../../vendor/paperclip-runner/index.js";
import { agentService } from "../agents.js";
import { approvalService } from "../approvals.js";
import { documentService } from "../documents.js";
import { issueService } from "../issues.js";

const IMPLEMENTED_OPERATIONS = new Set([
  "get_task_context", "get_task_history", "search_tasks", "report_progress",
  "list_documents", "read_document", "list_document_revisions",
  "list_agents", "get_agent", "list_approvals", "get_approval", "get_approval_context",
]);

type Binding = {
  companyId: string;
  issueId: string;
  runId: string;
  agentId: string;
};

type ToolReceipt = {
  operationId: string;
  input: unknown;
  result: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export class PaperclipRunnerToolAuthority {
  constructor(readonly db: Db, readonly binding: Binding) {}

  definitions(): Array<Record<string, unknown>> {
    return CAPABILITY_SEMANTIC_TOOL_CATALOG
      .filter((descriptor) => IMPLEMENTED_OPERATIONS.has(descriptor.operationId))
      .map((descriptor) => ({
        name: descriptor.operationId,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
      }));
  }

  async execute(call: { tool: string; callId: string; arguments: unknown }): Promise<unknown> {
    if (!IMPLEMENTED_OPERATIONS.has(call.tool)) throw new Error("paperclip_runner_tool_not_advertised");
    const context = await this.#boundContext();
    const input = record(call.arguments);
    switch (call.tool) {
      case "get_task_context": return {
        company: { id: this.binding.companyId },
        actor: context.actor,
        activeTask: context.issue,
        run: { id: this.binding.runId },
      };
      case "get_task_history": {
        const limit = boundedLimit(input.limit);
        const comments = await this.db.select().from(issueComments)
          .where(eq(issueComments.issueId, this.binding.issueId));
        return { comments: comments.slice(-limit) };
      }
      case "search_tasks": {
        const tasks = await issueService(this.db).list(this.binding.companyId);
        const query = typeof input.query === "string" ? input.query.toLowerCase() : "";
        const statuses = Array.isArray(input.statuses) ? new Set(input.statuses.filter((value): value is string => typeof value === "string")) : null;
        return { tasks: tasks.filter((task) =>
          (!query || `${task.identifier} ${task.title} ${task.description ?? ""}`.toLowerCase().includes(query))
          && (!statuses || statuses.size === 0 || statuses.has(task.status))
        ).slice(0, boundedLimit(input.limit)) };
      }
      case "list_documents":
        return { documents: await documentService(this.db).listIssueDocuments(this.binding.issueId) };
      case "read_document": {
        const document = await documentService(this.db).getIssueDocumentByKey(this.binding.issueId, requiredString(input.key));
        if (!document) throw new Error("paperclip_runner_document_not_found");
        return { document };
      }
      case "list_document_revisions":
        return { revisions: await documentService(this.db).listIssueDocumentRevisions(this.binding.issueId, requiredString(input.key)) };
      case "list_agents":
        return { actors: (await agentService(this.db).list(this.binding.companyId)).map(redactedActor) };
      case "get_agent": {
        const actor = await agentService(this.db).getById(requiredString(input.actorId));
        if (!actor || actor.companyId !== this.binding.companyId) throw new Error("paperclip_runner_agent_not_found");
        return { actor: redactedActor(actor) };
      }
      case "list_approvals":
        return { approvals: await approvalService(this.db).list(this.binding.companyId) };
      case "get_approval": {
        const approval = await this.#approval(requiredString(input.approvalId));
        return { approval };
      }
      case "get_approval_context": {
        const approval = await this.#approval(requiredString(input.approvalId));
        const tasks = await this.db.select({ issue: issues }).from(issueApprovals)
          .innerJoin(issues, eq(issues.id, issueApprovals.issueId))
          .where(eq(issueApprovals.approvalId, approval.id));
        return { approval, tasks: tasks.map((row) => row.issue) };
      }
      case "report_progress": return this.#reportProgress(call.callId, call.arguments);
      default: throw new Error("paperclip_runner_tool_not_bound");
    }
  }

  async #approval(id: string) {
    const approval = await approvalService(this.db).getById(id);
    if (!approval || approval.companyId !== this.binding.companyId) throw new Error("paperclip_runner_approval_not_found");
    return approval;
  }

  async #boundContext() {
    const [row] = await this.db.select({ issue: issues, actor: agents, run: heartbeatRuns })
      .from(heartbeatRuns)
      .innerJoin(issues, eq(issues.id, this.binding.issueId))
      .innerJoin(agents, eq(agents.id, this.binding.agentId))
      .where(and(
        eq(heartbeatRuns.id, this.binding.runId),
        eq(heartbeatRuns.companyId, this.binding.companyId),
        eq(heartbeatRuns.agentId, this.binding.agentId),
        eq(issues.companyId, this.binding.companyId),
        eq(issues.assigneeAgentId, this.binding.agentId),
        eq(issues.executionRunId, this.binding.runId),
        eq(agents.companyId, this.binding.companyId),
      ))
      .limit(1);
    if (!row || row.run.runtimeMode !== "native" || row.run.status !== "running") {
      throw new Error("paperclip_runner_tool_binding_not_authorized");
    }
    return row;
  }

  async #reportProgress(callId: string, value: unknown): Promise<unknown> {
    const input = record(value);
    const body = typeof input.body === "string" ? input.body.trim() : "";
    const idempotencyKey = typeof input.idempotencyKey === "string" ? input.idempotencyKey.trim() : "";
    if (!body || !idempotencyKey) throw new Error("paperclip_runner_tool_input_invalid");
    return this.db.transaction(async (tx) => {
      const [run] = await tx.select().from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, this.binding.runId), eq(heartbeatRuns.companyId, this.binding.companyId)))
        .for("update").limit(1);
      if (!run || run.status !== "running" || run.agentId !== this.binding.agentId) {
        throw new Error("paperclip_runner_tool_binding_not_authorized");
      }
      const resultJson = record(run.resultJson);
      const receipts = record(resultJson.semanticToolReceipts);
      const prior = receipts[idempotencyKey] as ToolReceipt | undefined;
      if (prior !== undefined) {
        if (prior.operationId !== "report_progress" || canonicalJson(prior.input) !== canonicalJson(input)) {
          throw new Error("paperclip_runner_tool_idempotency_conflict");
        }
        return prior.result;
      }
      const comment = await issueService(this.db).addComment(
        this.binding.issueId,
        body,
        { agentId: this.binding.agentId, runId: this.binding.runId },
        { authorizationReason: "paperclip_runner_protocol" },
        tx,
      );
      const result = { commentId: comment.id, issueId: this.binding.issueId, disposition: "applied" };
      receipts[idempotencyKey] = { operationId: "report_progress", input, result } satisfies ToolReceipt;
      await tx.update(heartbeatRuns).set({
        resultJson: { ...resultJson, semanticToolReceipts: receipts },
        updatedAt: new Date(),
      }).where(eq(heartbeatRuns.id, this.binding.runId));
      return result;
    });
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("paperclip_runner_tool_input_invalid");
  return value.trim();
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value)
    ? Math.max(1, Math.min(value, 100))
    : 50;
}

function redactedActor(actor: {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title?: string | null;
  status: string;
  reportsTo?: string | null;
}) {
  return {
    id: actor.id,
    companyId: actor.companyId,
    name: actor.name,
    role: actor.role,
    title: actor.title ?? null,
    status: actor.status,
    reportsTo: actor.reportsTo ?? null,
  };
}
