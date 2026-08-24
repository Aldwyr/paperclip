#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { isAbsolute, relative, resolve } from "node:path";

import type {
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpPermissionDecision,
  AcpRuntimeEvent,
  AcpRuntimeStatus,
} from "acpx/runtime";

import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../contracts/completion-result.js";
import { AcpxRuntimeHost } from "../drivers/acpx/acpx-runtime-host.js";
import { normalizeAcpFormElicitation } from "../drivers/acpx/acp-question-adapter.js";
import { resolveQualifiedAcpxProfile, type QualifiedAcpxAgent } from "../drivers/acpx/qualified-profiles.js";
import {
  ACPX_SIDECAR_MAX_FRAME_BYTES,
  ACPX_SIDECAR_PROTOCOL_VERSION,
  boundedSidecarValue,
  parseAcpxSidecarRequest,
  record,
  text,
  type AcpxSidecarEvent,
  type AcpxSidecarOpenParams,
  type AcpxSidecarRequest,
  type AcpxSidecarResponse,
} from "../drivers/acpx/sidecar-protocol.js";
import { validatePrpStructuredRunResult } from "../protocol/replay-contract.js";
import { parseNativeRuntimeContext } from "../contracts/runtime-context.js";

interface PendingResolution<T> {
  turnId: string;
  settle: (value: T) => void;
  reject: (error: Error) => void;
}

let host: AcpxRuntimeHost | null = null;
let openParams: AcpxSidecarOpenParams | null = null;
let runId: string | null = null;
let turnId: string | null = null;
let sequence = 0;
let closing = false;
const permissions = new Map<string, PendingResolution<AcpPermissionDecision | undefined>>();
const inputs = new Map<string, PendingResolution<AcpElicitationResponse> & {
  request: AcpElicitationRequest;
  questionSet: import("../contracts/question-set.js").PaperclipQuestionSet;
}>();
const tools = new Map<string, PendingResolution<unknown>>();

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
lines.on("line", (line) => void receiveLine(line));
lines.on("close", () => void shutdown("sidecar stdin closed"));
process.once("SIGTERM", () => void shutdown("sidecar received SIGTERM"));
process.once("SIGINT", () => void shutdown("sidecar received SIGINT"));

async function receiveLine(line: string): Promise<void> {
  if (!line.trim()) return;
  if (Buffer.byteLength(line) > ACPX_SIDECAR_MAX_FRAME_BYTES) {
    diagnostic("oversized_frame", "Rejected an oversized sidecar request.");
    return;
  }
  let request: AcpxSidecarRequest;
  try {
    request = parseAcpxSidecarRequest(JSON.parse(line));
  } catch (error) {
    diagnostic("malformed_frame", safeMessage(error));
    return;
  }
  try {
    response(request.id, true, await dispatch(request));
  } catch (error) {
    response(request.id, false, undefined, {
      code: text(record(error).code, "acpx_sidecar_command_failed"),
      message: safeMessage(error),
      retryable: record(error).retryable === true,
    });
  }
}

async function dispatch(request: AcpxSidecarRequest): Promise<Record<string, unknown>> {
  if (request.command === "initialize") {
    const agent = requiredAgent(request.params.agent);
    const model = requiredText(request.params.model, "model");
    const profile = resolveQualifiedAcpxProfile(agent, model);
    return {
      protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
      sidecarPid: process.pid,
      profile,
      capabilities: {
        persistentSessions: true,
        exactModelVerification: true,
        permissions: agent === "pi" ? "runner_extension" : "native_acp",
        semanticTools: agent === "pi" ? "runner_extension" : "runner_bridge",
      },
    };
  }
  if (request.command === "session.open") {
    if (host) throw new Error("ACPX sidecar already owns a session");
    const params = parseOpenParams(request.params);
    openParams = params;
    host = await openRuntime(params);
    const identity = host.identity();
    emit("runtime.process", { role: "sidecar", pid: process.pid, processGroupId: null, startedAt: new Date().toISOString() });
    return {
      identity,
      sidecarPid: process.pid,
      agentProcess: host.processIdentity(),
      status: sanitizeRuntimeStatus(await host.status()),
    };
  }
  if (request.command === "run.attach") {
    requireHost();
    if (turnId) throw new Error("cannot attach a run while an ACPX turn is active");
    const nextRunId = requiredText(request.params.runId, "runId");
    const previousRunId = runId;
    runId = nextRunId;
    const nextTools = Array.isArray(request.params.tools)
      ? request.params.tools.slice(0, 512).map(record)
      : openParams?.tools ?? [];
    try {
      if (openParams && JSON.stringify(nextTools) !== JSON.stringify(openParams.tools)) {
        const nextParams = { ...openParams, tools: nextTools };
        await host!.close({ reason: "Paperclip tool catalog changed", discardPersistentState: false });
        host = await openRuntime(nextParams);
        openParams = nextParams;
      }
    } catch (error) {
      runId = previousRunId;
      throw error;
    }
    return { runId, catalogRevision: positiveInteger(request.params.catalogRevision, "catalogRevision") };
  }
  if (request.command === "turn.start") {
    const activeHost = requireHost();
    if (!runId) throw new Error("attach a Paperclip run before starting a turn");
    if (turnId) throw new Error("ACPX sidecar already has an active turn");
    turnId = requiredText(request.params.turnId, "turnId");
    const currentTurnId = turnId;
    const runtimeTurn = activeHost.startTurn({
      requestId: `${runId}:${currentTurnId}`,
      text: requiredText(request.params.message, "message"),
    });
    void pumpTurn(currentTurnId, runtimeTurn);
    return { turnId: currentTurnId };
  }
  if (request.command === "turn.cancel") {
    const expected = requiredText(request.params.turnId, "turnId");
    if (expected !== turnId) throw new Error("cannot cancel a stale ACPX turn");
    await requireHost().cancel(text(request.params.reason, "Paperclip cancellation"));
    return { cancelled: true };
  }
  if (request.command === "permission.resolve") {
    const requestId = requiredText(request.params.requestId, "requestId");
    const pending = permissions.get(requestId);
    if (!pending || pending.turnId !== requiredText(request.params.turnId, "turnId")) throw new Error("permission request is stale or unknown");
    permissions.delete(requestId);
    pending.settle(parsePermissionDecision(request.params.decision));
    return { resolved: true };
  }
  if (request.command === "input.resolve") {
    const requestId = requiredText(request.params.requestId, "requestId");
    const pending = inputs.get(requestId);
    if (!pending || pending.turnId !== requiredText(request.params.turnId, "turnId")) {
      throw new Error("input request is stale or unknown");
    }
    const resolution = record(request.params.resolution);
    const action = requiredText(resolution.action, "resolution.action");
    let elicitationResponse: AcpElicitationResponse;
    if (action === "submit") {
      const normalized = normalizeAcpFormElicitation(pending.request);
      if (!normalized) throw new Error("ACP input request is no longer a form elicitation");
      elicitationResponse = normalized.accept(resolution.response);
    } else if (action === "decline") {
      elicitationResponse = { action: "decline" };
    } else if (action === "cancel") {
      elicitationResponse = { action: "cancel" };
    } else {
      throw new Error("unsupported ACP input resolution action");
    }
    inputs.delete(requestId);
    pending.settle(elicitationResponse);
    return { resolved: true };
  }
  if (request.command === "tool.resolve") {
    const callId = requiredText(request.params.callId, "callId");
    const pending = tools.get(callId);
    if (!pending || pending.turnId !== requiredText(request.params.turnId, "turnId")) throw new Error("tool call is stale or unknown");
    tools.delete(callId);
    if (request.params.error) pending.reject(new Error(text(record(request.params.error).message, "Paperclip tool failed")));
    else pending.settle(structuredClone(request.params.result));
    return { resolved: true };
  }
  if (request.command === "session.read") {
    return { identity: requireHost().identity(), status: sanitizeRuntimeStatus(await requireHost().status()) };
  }
  if (request.command === "session.snapshot") {
    return { identity: requireHost().identity(), status: sanitizeRuntimeStatus(await requireHost().status()), runId, turnId, sequence };
  }
  if (request.command === "session.suspend") {
    if (turnId) throw new Error("ACPX session is not at a safe suspension point");
    const identity = requireHost().identity();
    await host!.close({ reason: text(request.params.reason, "Paperclip suspension"), discardPersistentState: false });
    host = null;
    return { suspended: true, identity };
  }
  if (request.command === "session.close") {
    const discard = request.params.discardPersistentState === true;
    if (host) await host.close({ reason: text(request.params.reason, "Paperclip close"), discardPersistentState: discard });
    host = null;
    return { closed: true, discarded: discard };
  }
  throw new Error("unreachable sidecar command");
}

async function openRuntime(params: AcpxSidecarOpenParams): Promise<AcpxRuntimeHost> {
  return AcpxRuntimeHost.open({
    ...params,
    environment: process.env,
    dynamicTools: params.tools,
    dynamicToolHandler: (call) => waitForTool(call),
    onPermissionRequest: (context) => waitForPermission(context.request, context.signal),
    onElicitation: (context) => waitForInput(context.request, context.requestId, context.signal),
    onSpawn: async (identity) => emit("runtime.process", {
      role: "acp_agent",
      ...identity,
    }),
    onUsage: (usage) => {
      if (!turnId) return;
      const { cost, ...breakdown } = usage;
      emit("runtime.event", {
        type: "status",
        text: "Usage updated.",
        tag: "usage_update",
        used: usage.totalTokens ?? null,
        size: null,
        cost: cost ?? null,
        breakdown,
      });
    },
    onDiagnostic: (message) => diagnostic("acp_agent_stderr", message),
  });
}

async function pumpTurn(currentTurnId: string, runtimeTurn: ReturnType<AcpxRuntimeHost["startTurn"]>): Promise<void> {
  try {
    for await (const event of runtimeTurn.events) emit("runtime.event", sanitizeRuntimeEvent(event), currentTurnId);
    const result = await runtimeTurn.result;
    emit("runtime.turn_terminal", boundedSidecarValue(result), currentTurnId);
  } catch (error) {
    emit("runtime.turn_terminal", { status: "failed", error: { message: safeMessage(error), retryable: false } }, currentTurnId);
  } finally {
    rejectTurnWaiters(currentTurnId, "ACPX turn became terminal");
    if (turnId === currentTurnId) turnId = null;
  }
}

function waitForTool(call: { tool: string; callId: string; arguments: unknown }): Promise<unknown> {
  if (!turnId || tools.has(call.callId)) throw new Error("ACPX tool call is unbound or duplicated");
  if (call.tool === PRP_COMPLETION_TOOL_NAME || call.tool === PRP_BLOCK_TOOL_NAME) {
    const validation = validatePrpStructuredRunResult(call.arguments);
    if (!validation.ok) throw new Error("ACPX semantic result failed PRP schema validation");
    if (
      (call.tool === PRP_BLOCK_TOOL_NAME && validation.result.reportedWorkDisposition !== "blocked")
      || (call.tool === PRP_COMPLETION_TOOL_NAME && validation.result.reportedWorkDisposition === "blocked")
    ) throw new Error("ACPX semantic result disposition does not match its terminal operation");
    emit("runtime.event", {
      type: "semantic_result",
      callId: call.callId,
      operationId: call.tool,
      result: validation.result,
    });
    return Promise.resolve({ accepted: true });
  }
  emit("runtime.tool_called", {
    callId: call.callId,
    operationId: call.tool,
    input: boundedSidecarValue(record(call.arguments)),
  });
  return new Promise((settle, reject) => tools.set(call.callId, { turnId: turnId!, settle, reject }));
}

function waitForPermission(request: import("acpx/runtime").AcpPermissionRequest, signal: AbortSignal): Promise<AcpPermissionDecision | undefined> {
  if (!turnId || signal.aborted) return Promise.resolve({ outcome: "cancel" });
  const raw = record(request.raw);
  const toolCall = record(raw.toolCall);
  const requestId = requiredText(toolCall.toolCallId ?? toolCall.id ?? `permission-${sequence + 1}`, "permission request id");
  if (permissions.has(requestId)) return Promise.resolve({ outcome: "reject_once" });
  emit("runtime.permission_requested", {
    requestId,
    kind: text(request.inferredKind, "unknown"),
    title: text(toolCall.title, "ACP permission request").slice(0, 4000),
    optionCount: Array.isArray(raw.options) ? Math.min(raw.options.length, 32) : 0,
  });
  return new Promise((settle, reject) => {
    const abort = () => {
      if (!permissions.delete(requestId)) return;
      settle({ outcome: "cancel" });
    };
    signal.addEventListener("abort", abort, { once: true });
    permissions.set(requestId, {
      turnId: turnId!,
      settle: (decision) => { signal.removeEventListener("abort", abort); settle(decision); },
      reject,
    });
  });
}

function waitForInput(
  request: AcpElicitationRequest,
  nativeRequestId: string | number | null,
  signal: AbortSignal,
): Promise<AcpElicitationResponse> {
  if (!turnId || signal.aborted) return Promise.resolve({ action: "cancel" });
  let normalized: ReturnType<typeof normalizeAcpFormElicitation>;
  try {
    normalized = normalizeAcpFormElicitation(request);
  } catch (error) {
    diagnostic("runtime_input_rejected", safeMessage(error));
    return Promise.resolve({ action: "decline" });
  }
  if (!normalized) return Promise.resolve({ action: "decline" });
  const requestId = requiredText(String(nativeRequestId), "elicitation request id");
  if (inputs.has(requestId)) return Promise.resolve({ action: "decline" });
  emit("runtime.input_requested", {
    requestId,
    questionSet: normalized.questionSet,
    origin: {
      adapter: "acpx-runtime-sidecar",
      provider: "acpx",
      method: "elicitation/create",
    },
  });
  return new Promise((settle, reject) => {
    const abort = () => {
      if (!inputs.delete(requestId)) return;
      settle({ action: "cancel" });
    };
    signal.addEventListener("abort", abort, { once: true });
    inputs.set(requestId, {
      turnId: turnId!,
      request,
      questionSet: normalized.questionSet,
      settle: (response) => {
        signal.removeEventListener("abort", abort);
        settle(response);
      },
      reject,
    });
  });
}

function sanitizeRuntimeEvent(event: AcpRuntimeEvent): Record<string, unknown> {
  const runtimeType = text(record(event).type);
  if (!["text_delta", "status", "tool_call", "error", "done"].includes(runtimeType)) {
    return {
      type: "provider_notice",
      category: `unclassified_acp_${runtimeType || "unknown"}`.slice(0, 160),
      summary: "The qualified ACP agent emitted an unclassified runtime update.",
    };
  }
  if (event.type === "text_delta") {
    return event.stream === "thought" || event.tag === "agent_thought_chunk"
      ? { type: "thinking", state: "active", tag: event.tag ?? null }
      : { type: "text_delta", text: event.text.slice(0, 64 * 1024), stream: "output", tag: event.tag ?? null, messageId: event.messageId?.slice(0, 200) ?? null };
  }
  if (event.type === "status") {
    return boundedSidecarValue({
      type: "status",
      text: event.text.slice(0, 4000),
      tag: event.tag ?? null,
      used: event.used ?? null,
      size: event.size ?? null,
      cost: event.cost ?? null,
      breakdown: event.breakdown ?? null,
    });
  }
  if (event.type === "tool_call") {
    return boundedSidecarValue({
      type: "tool_call",
      toolCallId: event.toolCallId?.slice(0, 200) ?? null,
      status: event.status?.slice(0, 100) ?? null,
      title: event.title?.slice(0, 4000) ?? null,
      kind: event.kind ?? null,
      locations: safeLocations(event.locations),
      ...safeOutput(event.rawOutput),
    }, 128 * 1024);
  }
  if (event.type === "error") return { type: "error", code: event.code ?? null, message: safeText(event.message), retryable: event.retryable ?? false };
  if (event.type === "done") return { type: "done", stopReason: event.stopReason ?? null };
  return { type: "provider_notice", category: "unclassified_acp_unknown", summary: "The qualified ACP agent emitted an unclassified runtime update." };
}

function sanitizeRuntimeStatus(status: AcpRuntimeStatus): Record<string, unknown> {
  const cumulative = status.usage?.cumulative;
  const cost = status.usage?.cost;
  return boundedSidecarValue({
    summary: status.summary ? safeText(status.summary).slice(0, 4000) : null,
    acpxRecordId: text(status.acpxRecordId).slice(0, 240) || null,
    backendSessionId: text(status.backendSessionId).slice(0, 240) || null,
    agentSessionId: text(status.agentSessionId).slice(0, 240) || null,
    models: {
      currentModelId: text(status.models?.currentModelId).slice(0, 240) || null,
      availableModelCount: Math.min(status.models?.availableModelIds.length ?? 0, 100_000),
    },
    usage: {
      cumulative: cumulative ? {
        inputTokens: safeNonNegativeNumber(cumulative.inputTokens),
        outputTokens: safeNonNegativeNumber(cumulative.outputTokens),
        cachedReadTokens: safeNonNegativeNumber(cumulative.cachedReadTokens),
        cachedWriteTokens: safeNonNegativeNumber(cumulative.cachedWriteTokens),
        thoughtTokens: safeNonNegativeNumber(cumulative.thoughtTokens),
        totalTokens: safeNonNegativeNumber(cumulative.totalTokens),
      } : null,
      cost: cost ? {
        amount: safeNonNegativeNumber(cost.amount),
        currency: text(cost.currency).slice(0, 16) || null,
      } : null,
      requestCount: Math.min(Object.keys(status.usage?.perRequest ?? {}).length, 100_000),
    },
  }, 32 * 1024);
}

function safeNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function safeOutput(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return { output: null, outputBytes: 0, outputTruncated: false, outputDigest: null };
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (!raw) return { output: null, outputBytes: 0, outputTruncated: false, outputDigest: null };
  const redacted = raw.replace(/(key|token|secret|password|authorization)\s*[:=]\s*[^\s,}\]]+/gi, "$1=[REDACTED]");
  const bytes = Buffer.from(redacted);
  return {
    output: bytes.subarray(Math.max(0, bytes.length - 64 * 1024)).toString("utf8"),
    outputBytes: bytes.length,
    outputTruncated: bytes.length > 64 * 1024,
    outputDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

function safeLocations(locations: Extract<AcpRuntimeEvent, { type: "tool_call" }>["locations"]): Array<Record<string, unknown>> {
  if (!openParams) return [];
  const cwd = resolve(openParams.workingDirectory);
  return (locations ?? []).slice(0, 2_000).flatMap((location): Array<Record<string, unknown>> => {
    const candidate = record(location);
    const rawPath = text(candidate.path, text(candidate.uri));
    if (!rawPath) return [];
    const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
    const local = relative(cwd, absolute).replaceAll("\\", "/");
    if (!local || local === ".." || local.startsWith("../")) return [];
    return [{ path: local.slice(0, 4000), line: candidate.line ?? null }];
  });
}

function parseOpenParams(value: Record<string, unknown>): AcpxSidecarOpenParams {
  const agent = requiredAgent(value.agent);
  const model = requiredText(value.model, "model");
  resolveQualifiedAcpxProfile(agent, model);
  const runtimeContextPath = process.env.PAPERCLIP_NATIVE_RUNTIME_CONTEXT_PATH?.trim();
  return {
    runtimeDirectory: requiredText(value.runtimeDirectory, "runtimeDirectory"),
    normalizedSessionId: requiredText(value.normalizedSessionId, "normalizedSessionId"),
    workingDirectory: requiredText(value.workingDirectory, "workingDirectory"),
    agent,
    model,
    systemInstructions: requiredText(value.systemInstructions, "systemInstructions"),
    runtimeContext: runtimeContextPath
      ? parseNativeRuntimeContext(JSON.parse(readFileSync(runtimeContextPath, "utf8")))
      : null,
    tools: Array.isArray(value.tools) ? value.tools.slice(0, 512).map(record) : [],
    ...(value.expectedIdentity === undefined || value.expectedIdentity === null
      ? {}
      : { expectedIdentity: parseExpectedIdentity(value.expectedIdentity) }),
  };
}

function parseExpectedIdentity(value: unknown): NonNullable<AcpxSidecarOpenParams["expectedIdentity"]> {
  const input = record(value);
  if (input.kind !== "acpx") throw new Error("ACPX recovery identity kind is invalid");
  return {
    kind: "acpx",
    normalizedSessionId: requiredText(input.normalizedSessionId, "expected normalizedSessionId"),
    acpxRecordId: requiredText(input.acpxRecordId, "expected acpxRecordId"),
    backendSessionId: requiredText(input.backendSessionId, "expected backendSessionId"),
    agentSessionId: requiredText(input.agentSessionId, "expected agentSessionId"),
    profileDigest: requiredText(input.profileDigest, "expected profileDigest"),
    workspaceDigest: requiredText(input.workspaceDigest, "expected workspaceDigest"),
    requestedModel: requiredText(input.requestedModel, "expected requestedModel"),
    effectiveModel: requiredText(input.effectiveModel, "expected effectiveModel"),
  };
}

function parsePermissionDecision(value: unknown): AcpPermissionDecision {
  const outcome = text(record(value).outcome);
  if (!["allow_once", "allow_always", "reject_once", "reject_always", "cancel"].includes(outcome)) throw new Error("unsupported ACP permission decision");
  return { outcome } as AcpPermissionDecision;
}

function emit(eventType: AcpxSidecarEvent["eventType"], payload: Record<string, unknown>, eventTurnId = turnId): void {
  writeFrame({ protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION, sequence: ++sequence, eventType, runId, turnId: eventTurnId, payload } satisfies AcpxSidecarEvent);
}

function diagnostic(code: string, message: string): void {
  process.stderr.write(`[paperclip-acpx-sidecar] ${code}: ${safeText(message)}\n`);
  emit("runtime.diagnostic", { code, message: safeText(message) });
}

function response(id: number, ok: boolean, result?: Record<string, unknown>, error?: AcpxSidecarResponse["error"]): void {
  writeFrame({ protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION, id, ok, ...(result ? { result } : {}), ...(error ? { error } : {}) } satisfies AcpxSidecarResponse);
}

function writeFrame(value: AcpxSidecarEvent | AcpxSidecarResponse): void {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > ACPX_SIDECAR_MAX_FRAME_BYTES) {
    process.stderr.write("[paperclip-acpx-sidecar] output_frame_too_large\n");
    return;
  }
  process.stdout.write(`${line}\n`);
}

function requireHost(): AcpxRuntimeHost {
  if (!host) throw new Error("ACPX session is not open");
  return host;
}

function requiredAgent(value: unknown): QualifiedAcpxAgent {
  if (value !== "pi" && value !== "claude" && value !== "codex") throw new Error("agent must be pi, claude, or codex");
  return value;
}

function requiredText(value: unknown, field: string): string {
  const result = text(value).trim();
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function safeText(value: unknown): string {
  return text(value, String(value)).replace(/(key|token|secret|password|authorization)\s*[:=]\s*[^\s,}\]]+/gi, "$1=[REDACTED]").slice(0, 8192);
}

function safeMessage(error: unknown): string { return safeText(error instanceof Error ? error.message : error); }

function rejectTurnWaiters(terminalTurnId: string, message: string): void {
  for (const [id, pending] of permissions) if (pending.turnId === terminalTurnId) {
    permissions.delete(id);
    pending.settle({ outcome: "cancel" });
  }
  for (const [id, pending] of tools) if (pending.turnId === terminalTurnId) {
    tools.delete(id);
    pending.reject(new Error(message));
  }
  for (const [id, pending] of inputs) if (pending.turnId === terminalTurnId) {
    inputs.delete(id);
    pending.settle({ action: "cancel" });
  }
}

async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  rejectTurnWaiters(turnId ?? "", reason);
  if (host) await host.close({ reason, discardPersistentState: false }).catch(() => {});
  process.exitCode = 0;
}
