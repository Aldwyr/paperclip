import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../../vendor/paperclip-runner/index.js";
import { issueService } from "../issues.js";

const IMPLEMENTED_OPERATIONS = new Set(["get_task_context", "report_progress"]);

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
    if (call.tool === "get_task_context") {
      return {
        company: { id: this.binding.companyId },
        actor: context.actor,
        activeTask: context.issue,
        run: { id: this.binding.runId },
      };
    }
    return this.#reportProgress(call.callId, call.arguments);
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
