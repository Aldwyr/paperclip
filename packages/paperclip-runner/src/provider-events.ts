import { createHash } from "node:crypto";
import type { AcpRuntimeEvent } from "acpx/runtime";

export const PROVIDER_EVENT_FAMILIES = [
  "plan", "tool_execution", "research", "delegation", "model_identity",
  "context", "artifact", "review", "hook", "memory", "safety", "terminal",
  "wait", "provider_notice",
] as const;

export type ProviderEventFamily = (typeof PROVIDER_EVENT_FAMILIES)[number];
export type ProviderEventAvailability = "available" | "unsupported" | "policy_disabled";

/**
 * Exhaustive inventory from the qualified Codex app-server ThreadItem schema.
 * Keeping this closed makes a provider upgrade fail visibly in the inventory
 * test instead of silently dropping a new native item shape.
 */
export const CODEX_THREAD_ITEM_CLASSIFICATION = {
  userMessage: "existing_transcript",
  hookPrompt: "hook",
  agentMessage: "existing_transcript",
  plan: "plan",
  reasoning: "existing_reasoning",
  commandExecution: "tool_execution",
  fileChange: "existing_workspace_change",
  mcpToolCall: "tool_execution",
  dynamicToolCall: "tool_execution",
  collabAgentToolCall: "delegation",
  subAgentActivity: "delegation",
  webSearch: "research",
  imageView: "artifact",
  sleep: "wait",
  imageGeneration: "artifact",
  enteredReviewMode: "review",
  exitedReviewMode: "review",
  contextCompaction: "context",
} as const satisfies Record<string, ProviderEventFamily | `existing_${string}`>;

export interface TypedEventFamilyCapability {
  family: ProviderEventFamily;
  version: 1;
  availability: ProviderEventAvailability;
  detailLevel: "summary" | "structured";
}

export type CanonicalProviderEventType =
  | "plan.updated"
  | "tool.execution.started" | "tool.execution.progressed" | "tool.execution.completed"
  | "research.started" | "research.progressed" | "research.completed"
  | "delegation.started" | "delegation.updated" | "delegation.completed"
  | "model.route.changed" | "model.verification.updated" | "context.compacted"
  | "artifact.viewed" | "artifact.generated" | "review.mode.changed"
  | "hook.started" | "hook.completed" | "memory.citation.referenced"
  | "safety.review.started" | "safety.review.completed" | "terminal.input.sent"
  | "wait.started" | "wait.completed" | "provider.notice.recorded";

export interface CanonicalProviderEvent {
  eventType: CanonicalProviderEventType;
  payload: Record<string, unknown>;
  itemId: string;
}

const MAX_OUTPUT = 64 * 1024;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function integer(value: unknown): number | null {
  return Number.isSafeInteger(value) ? Number(value) : null;
}

function safeId(value: string, fallback: string): string {
  const candidate = value.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 160);
  return /^[A-Za-z0-9]/.test(candidate) ? candidate : fallback;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function boundedOutput(value: string): Pick<Record<string, unknown>, "output" | "outputBytes" | "outputTruncated" | "outputDigest"> {
  const bytes = Buffer.byteLength(value);
  const output = Buffer.from(value).subarray(Math.max(0, bytes - MAX_OUTPUT)).toString("utf8");
  return { output, outputBytes: bytes, outputTruncated: bytes > MAX_OUTPUT, outputDigest: digest(value) };
}

function canonicalStatus(value: unknown, fallback: "running" | "completed" | "failed" | "cancelled" | "interrupted"): "running" | "completed" | "failed" | "cancelled" | "interrupted" {
  const status = text(value).toLowerCase().replaceAll("_", "-");
  if (status === "completed" || status === "success") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "canceled") return "cancelled";
  if (status === "interrupted" || status === "aborted") return "interrupted";
  if (status === "running" || status === "pending" || status === "in-progress") return "running";
  return fallback;
}

function planStepStatus(value: unknown): "pending" | "in_progress" | "completed" | "blocked" {
  const status = text(value).toLowerCase().replaceAll("-", "_");
  if (status === "in_progress" || status === "completed" || status === "blocked") return status;
  return "pending";
}

function operationFromActions(item: Record<string, unknown>): "read" | "search" | "list" | "execute" | "edit" | "unknown" {
  const action = record(Array.isArray(item.commandActions) ? item.commandActions[0] : undefined);
  const kind = text(action.type).toLowerCase();
  if (kind === "read") return "read";
  if (kind === "search") return "search";
  if (kind === "listfiles") return "list";
  return text(item.command) ? "execute" : "unknown";
}

function executionPayload(item: Record<string, unknown>, status: string): Record<string, unknown> {
  const id = safeId(text(item.id), "execution");
  const output = text(item.aggregatedOutput, text(item.output));
  const action = record(Array.isArray(item.commandActions) ? item.commandActions[0] : undefined);
  const target = text(action.path) || null;
  return {
    schema: "paperclip.tool.execution.v1",
    executionId: id,
    transport: text(item.type) === "mcpToolCall" ? "mcp" : text(item.type) === "dynamicToolCall" ? "dynamic" : "process",
    operation: text(item.type).includes("ToolCall") ? "unknown" : operationFromActions(item),
    name: text(item.tool, text(item.command)) || null,
    target: target?.startsWith("/") || target?.split("/").includes("..") ? null : target,
    namespace: text(item.server, text(item.namespace)) || null,
    readOnly: typeof item.readOnlyHint === "boolean" ? item.readOnlyHint : null,
    status,
    durationMs: integer(item.durationMs),
    exitCode: integer(item.exitCode),
    progress: null,
    ...boundedOutput(output),
  };
}

function planPayload(params: Record<string, unknown>, item: Record<string, unknown>, complete: boolean): Record<string, unknown> {
  const plan = Array.isArray(params.plan) ? params.plan : [];
  const textPlan = text(item.text);
  const steps = plan.length > 0
    ? plan.slice(0, 256).map((entry, index) => {
        const step = record(entry);
        return { stepId: `step-${index + 1}`, body: text(step.step).slice(0, 4000), status: planStepStatus(step.status) };
      })
    : textPlan.split("\n").filter(Boolean).slice(0, 256).map((body, index) => ({ stepId: `step-${index + 1}`, body: body.slice(0, 4000), status: "pending" }));
  return {
    schema: "paperclip.plan.updated.v1",
    planId: safeId(text(item.id, text(params.turnId)), "plan"),
    revision: Number.isSafeInteger(params.revision) ? Number(params.revision) : 1,
    explanation: text(params.explanation) || null,
    steps,
    complete,
    syncStatus: complete ? "pending" : "streaming",
    documentRevision: null,
  };
}

function researchSources(item: Record<string, unknown>, researchId: string): Array<Record<string, unknown>> {
  if (!Array.isArray(item.results)) return [];
  return item.results.slice(0, 64).flatMap((value, index) => {
    const result = record(value);
    const url = text(result.url).slice(0, 8192);
    if (!url.startsWith("http://") && !url.startsWith("https://")) return [];
    const fallbackId = `${researchId}:source:${index + 1}`;
    return [{
      sourceId: safeId(text(result.ref_id, text(result.refId, fallbackId)), fallbackId),
      title: text(result.title, url).slice(0, 4000),
      url,
      snippet: text(result.snippet).slice(0, 4000) || null,
    }];
  });
}

/** Maps qualified Codex app-server notifications to bounded canonical PRP events. */
export function canonicalProviderEventsFromCodex(method: string, paramsValue: unknown): CanonicalProviderEvent[] {
  const params = record(paramsValue);
  const item = record(params.item);
  const type = text(item.type);
  const itemId = safeId(text(item.id, text(params.itemId)), "provider-item");
  const completed = method === "item/completed";
  if ((method === "item/started" || completed) && type === "plan") {
    return [{ eventType: "plan.updated", payload: planPayload(params, item, completed), itemId }];
  }
  if (method === "turn/plan/updated") {
    return [{ eventType: "plan.updated", payload: planPayload(params, item, false), itemId: safeId(text(params.turnId), "plan") }];
  }
  if ((method === "item/started" || completed) && ["commandExecution", "mcpToolCall", "dynamicToolCall"].includes(type)) {
    return [{ eventType: completed ? "tool.execution.completed" : "tool.execution.started", payload: executionPayload(item, completed ? canonicalStatus(item.status, "completed") : "running"), itemId }];
  }
  if (method === "item/commandExecution/outputDelta" || method === "item/mcpToolCall/progress") {
    const delta = text(params.delta, text(params.message));
    return [{ eventType: "tool.execution.progressed", payload: { ...executionPayload({ ...item, id: itemId, output: delta }, "running"), progress: delta.slice(0, 4000) || null }, itemId }];
  }
  if ((method === "item/started" || completed) && type === "webSearch") {
    const action = record(item.action);
    const actionType = text(action.type, "other").replace("openPage", "open_page").replace("findInPage", "find_in_page");
    const url = text(action.url) || null;
    return [{ eventType: completed ? "research.completed" : "research.started", payload: { schema: "paperclip.research.v1", researchId: itemId, action: actionType, status: completed ? "completed" : "running", query: text(item.query, text(action.query)) || null, url: url?.startsWith("http://") || url?.startsWith("https://") ? url : null, pattern: text(action.pattern) || null, sources: completed ? researchSources(item, itemId) : [] }, itemId }];
  }
  if ((method === "item/started" || completed) && (type === "collabAgentToolCall" || type === "subAgentActivity")) {
    return [{ eventType: completed ? "delegation.completed" : "delegation.started", payload: { schema: "paperclip.delegation.v1", delegationId: itemId, action: text(item.tool, "spawnAgent").replace("spawnAgent", "spawn").replace("sendInput", "message").replace("resumeAgent", "resume").replace("closeAgent", "close"), status: completed ? "completed" : "running", children: [] }, itemId }];
  }
  if (method === "model/rerouted") {
    return [{ eventType: "model.route.changed", payload: { schema: "paperclip.model.route_changed.v1", routeId: safeId(text(params.turnId), "model-route"), provider: "openai", requestedModel: text(params.fromModel, "unknown"), fromModel: text(params.fromModel) || null, effectiveModel: text(params.toModel, "unknown"), reason: text(params.reason, "provider reroute").slice(0, 4000) }, itemId }];
  }
  if (method === "model/verification" || method === "model/safetyBuffering/updated") {
    return [{ eventType: "model.verification.updated", payload: { schema: "paperclip.model.verification.v1", verificationId: safeId(text(params.turnId), "model-verification"), status: params.showBufferingUi === true ? "running" : "completed", classes: Array.isArray(params.verifications) ? params.verifications.slice(0, 32) : [], buffering: params.showBufferingUi === true, summary: Array.isArray(params.reasons) ? params.reasons.join("; ").slice(0, 4000) : null }, itemId }];
  }
  if (method === "thread/compacted" || ((method === "item/completed" || method === "item/started") && type === "contextCompaction")) {
    return [{ eventType: "context.compacted", payload: { schema: "paperclip.context.compacted.v1", compactionId: itemId, reason: "provider", preTokens: null, postTokens: null, sameSession: true }, itemId }];
  }
  if ((method === "item/started" || completed) && type === "imageView") {
    const path = text(item.path).replaceAll("\\", "/");
    return [{ eventType: "artifact.viewed", payload: { schema: "paperclip.artifact.viewed.v1", artifactId: itemId, reference: path.startsWith("/") || path.split("/").includes("..") ? null : path, mediaType: "image/*", title: null }, itemId }];
  }
  if ((method === "item/started" || completed) && type === "imageGeneration") {
    const path = text(item.savedPath).replaceAll("\\", "/");
    return [{ eventType: "artifact.generated", payload: { schema: "paperclip.artifact.generated.v1", artifactId: itemId, status: completed ? text(item.status, "completed") : "running", reference: path.startsWith("/") || path.split("/").includes("..") ? null : path || null, mediaType: "image/*", registered: false, transparentBackground: typeof item.transparentBackground === "boolean" ? item.transparentBackground : null, failure: text(record(item.failure).message) || null }, itemId }];
  }
  if ((method === "item/started" || completed) && (type === "enteredReviewMode" || type === "exitedReviewMode")) {
    return [{ eventType: "review.mode.changed", payload: { schema: "paperclip.review.mode_changed.v1", reviewId: itemId, state: type === "enteredReviewMode" ? "entered" : "exited", scope: text(item.review) || null }, itemId }];
  }
  if (method === "hook/started" || method === "hook/completed") {
    const run = record(params.run);
    return [{ eventType: method === "hook/started" ? "hook.started" : "hook.completed", payload: { schema: "paperclip.hook.v1", hookId: safeId(text(run.id), "hook"), event: text(run.eventName, "unknown"), scope: text(run.scope, "provider"), status: method === "hook/started" ? "running" : text(run.status, "completed"), blocking: run.executionMode === "blocking", durationMs: integer(run.durationMs), summary: text(run.statusMessage) || null }, itemId: safeId(text(run.id), "hook") }];
  }
  if (completed && type === "agentMessage" && item.memoryCitation) {
    const citation = record(item.memoryCitation);
    const entries = Array.isArray(citation.entries) ? citation.entries : [];
    return entries.slice(0, 64).map((entry, index) => ({ eventType: "memory.citation.referenced" as const, payload: { schema: "paperclip.memory.citation.v1", citationId: `${itemId}:citation:${index + 1}`, messageItemId: itemId, label: text(record(entry).label, `Memory source ${index + 1}`).slice(0, 4000), available: false, reference: null }, itemId: `${itemId}:citation:${index + 1}` }));
  }
  if (method === "item/autoApprovalReview/started" || method === "item/autoApprovalReview/completed") {
    return [{ eventType: method.endsWith("started") ? "safety.review.started" : "safety.review.completed", payload: { schema: "paperclip.safety.review.v1", reviewId: safeId(text(params.reviewId), "safety-review"), targetExecutionId: text(params.targetItemId) || null, status: method.endsWith("started") ? "running" : "completed", decision: method.endsWith("started") ? "pending" : "unknown", summary: null }, itemId: safeId(text(params.reviewId), "safety-review") }];
  }
  if (method === "item/commandExecution/terminalInteraction") {
    return [{ eventType: "terminal.input.sent", payload: { schema: "paperclip.terminal.input_sent.v1", executionId: safeId(text(params.itemId), "execution"), origin: "agent", inputClass: "text", byteCount: Buffer.byteLength(text(params.stdin)) }, itemId: safeId(text(params.itemId), "execution") }];
  }
  if ((method === "item/started" || completed) && type === "sleep") {
    return [{ eventType: completed ? "wait.completed" : "wait.started", payload: { schema: "paperclip.wait.v1", waitId: itemId, reason: "timer", status: completed ? "completed" : "running", plannedDurationMs: integer(item.durationMs), elapsedDurationMs: completed ? integer(item.durationMs) : null }, itemId }];
  }
  if (["error", "warning", "guardianWarning", "deprecationNotice", "configWarning", "windows/worldWritableWarning"].includes(method)) {
    return [{ eventType: "provider.notice.recorded", payload: { schema: "paperclip.provider.notice.v1", noticeId: safeId(`${method}:${text(params.code, "notice")}`, "provider-notice"), severity: method === "error" ? "error" : "warning", category: method.replaceAll("/", "_").slice(0, 160), scope: method.includes("config") || method.includes("windows") ? "environment" : "turn", recoverable: method !== "error", userActionable: method === "error" || method === "warning", summary: text(params.message, "Provider notice").slice(0, 4000) }, itemId }];
  }
  return [];
}

/** Maps documented OpenCode structured message parts. Unrecognized parts are deliberately unsupported. */
export function canonicalProviderEventsFromOpenCodePart(partValue: unknown): CanonicalProviderEvent[] {
  const part = record(partValue);
  const type = text(part.type).toLowerCase();
  const itemId = safeId(text(part.id, text(part.callID, text(part.callId))), "opencode-part");
  const state = record(part.state);
  const status = canonicalStatus(state.status, "running");
  if (["tool", "tool-call", "tool_call", "bash", "command"].includes(type)) {
    const tool = text(part.tool, text(part.name, type));
    const output = text(state.output, text(part.output));
    const payload = {
      schema: "paperclip.tool.execution.v1",
      executionId: itemId,
      transport: type === "tool" || type.includes("tool") ? "built_in" : "process",
      operation: /read/i.test(tool) ? "read" : /search|grep|find/i.test(tool) ? "search" : /list|glob/i.test(tool) ? "list" : /edit|write|patch/i.test(tool) ? "edit" : "execute",
      name: tool || null,
      target: null,
      namespace: null,
      readOnly: /read|search|grep|find|list|glob/i.test(tool),
      status,
      durationMs: integer(state.time),
      exitCode: integer(state.exit),
      progress: status === "running" ? text(state.title).slice(0, 4000) || null : null,
      ...boundedOutput(output),
    };
    return [{ eventType: status === "running" ? "tool.execution.progressed" : "tool.execution.completed", payload, itemId }];
  }
  if (["websearch", "web_search"].includes(type)) {
    return [{ eventType: status === "running" ? "research.progressed" : "research.completed", payload: { schema: "paperclip.research.v1", researchId: itemId, action: "search", status: status === "interrupted" ? "cancelled" : status, query: text(part.query) || null, url: null, pattern: null, sources: [] }, itemId }];
  }
  if (["subtask", "task"].includes(type)) {
    return [{ eventType: status === "running" ? "delegation.updated" : "delegation.completed", payload: { schema: "paperclip.delegation.v1", delegationId: itemId, action: "spawn", status: status === "cancelled" ? "interrupted" : status, children: [] }, itemId }];
  }
  if (["compaction", "context-compaction"].includes(type)) {
    return [{ eventType: "context.compacted", payload: { schema: "paperclip.context.compacted.v1", compactionId: itemId, reason: "provider", preTokens: null, postTokens: null, sameSession: true }, itemId }];
  }
  return [];
}

/** Maps ACPX's bounded public runtime events; raw ACP JSON-RPC never enters PRP. */
export function canonicalProviderEventsFromAcpxRuntimeEvent(
  event: AcpRuntimeEvent,
  fallbackItemId: string,
): CanonicalProviderEvent[] {
  const runtimeType = text(record(event).type);
  if (!["text_delta", "status", "tool_call", "error", "done"].includes(runtimeType)) {
    return [{
      eventType: "provider.notice.recorded",
      payload: {
        schema: "paperclip.provider.notice.v1",
        noticeId: safeId(`${fallbackItemId}:${runtimeType || "unknown"}`, "acpx-unclassified-update"),
        severity: "warning",
        category: `unclassified_acp_${runtimeType || "unknown"}`.slice(0, 160),
        scope: "turn",
        recoverable: true,
        userActionable: false,
        summary: "The qualified ACP agent emitted an unclassified runtime update.",
      },
      itemId: fallbackItemId,
    }];
  }
  const itemId = safeId(
    event.type === "tool_call" ? text(event.toolCallId, fallbackItemId) : fallbackItemId,
    "acpx-item",
  );
  if (event.type === "tool_call") {
    const kind = text(event.kind).toLowerCase();
    const status = canonicalStatus(event.status, "running");
    const output = typeof event.rawOutput === "string"
      ? event.rawOutput
      : event.rawOutput === undefined
        ? ""
        : JSON.stringify(event.rawOutput);
    const operation = /read/.test(kind) ? "read"
      : /search/.test(kind) ? "search"
        : /list/.test(kind) ? "list"
          : /edit|write|delete|move/.test(kind) ? "edit"
            : /execute|terminal/.test(kind) ? "execute"
              : "unknown";
    const payload = {
      schema: "paperclip.tool.execution.v1",
      executionId: itemId,
      transport: "built_in",
      operation,
      name: text(event.title) || null,
      target: safeAcpLocation(event.locations?.[0]),
      namespace: null,
      readOnly: ["read", "search", "list"].includes(operation),
      status,
      durationMs: null,
      exitCode: null,
      progress: status === "running" ? event.text.slice(0, 4000) || null : null,
      ...boundedOutput(output),
    };
    const terminal = status !== "running";
    return [{
      eventType: terminal ? "tool.execution.completed" : event.tag === "tool_call" ? "tool.execution.started" : "tool.execution.progressed",
      payload,
      itemId,
    }];
  }
  if (event.type === "status" && event.tag === "plan") {
    const steps = event.text.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 256)
      .map((body, index) => ({ stepId: `step-${index + 1}`, body: body.slice(0, 4000), status: "pending" }));
    return [{
      eventType: "plan.updated",
      payload: {
        schema: "paperclip.plan.updated.v1",
        planId: itemId,
        revision: 1,
        explanation: null,
        steps,
        complete: true,
        syncStatus: "pending",
        documentRevision: null,
      },
      itemId,
    }];
  }
  if (event.type === "status" && event.tag === "current_mode_update") {
    const state = /review|plan/i.test(event.text) ? "entered" : "exited";
    return [{
      eventType: "review.mode.changed",
      payload: {
        schema: "paperclip.review.mode_changed.v1",
        reviewId: itemId,
        state,
        scope: event.text.slice(0, 4000) || null,
      },
      itemId,
    }];
  }
  if (event.type === "status" && event.tag && ![
    "usage_update",
    "available_commands_update",
    "config_option_update",
    "session_info_update",
  ].includes(event.tag)) {
    return [{
      eventType: "provider.notice.recorded",
      payload: {
        schema: "paperclip.provider.notice.v1",
        noticeId: itemId,
        severity: "info",
        category: `acp_${event.tag}`.slice(0, 160),
        scope: "turn",
        recoverable: true,
        userActionable: false,
        summary: event.text.slice(0, 4000) || "ACP provider update",
      },
      itemId,
    }];
  }
  return [];
}

function safeAcpLocation(value: unknown): string | null {
  const location = record(value);
  const raw = text(location.path, text(location.uri)).replaceAll("\\", "/");
  if (!raw || raw.startsWith("/") || raw.split("/").includes("..") || /^[a-z]+:\/\//i.test(raw)) return null;
  return raw.slice(0, 4000);
}

export function providerFamilyCapabilities(
  availability: Partial<Record<ProviderEventFamily, ProviderEventAvailability>>,
): TypedEventFamilyCapability[] {
  return PROVIDER_EVENT_FAMILIES.map((family) => ({
    family,
    version: 1,
    availability: availability[family] ?? "unsupported",
    detailLevel: availability[family] === "available" ? "structured" : "summary",
  }));
}
