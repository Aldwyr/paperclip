import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import type { UIAdapterModule } from "../types";
import { parseCodexStdoutLine, buildPaperclipRunnerConfig } from "@paperclipai/adapter-codex-local/ui";
import { CodexLocalConfigFields } from "../codex-local/config-fields";

type JsonRecord = Record<string, unknown>;

interface PaperclipRunnerParserState {
  assistantDeltaItemIds: Set<string>;
  reasoningDeltaItemIds: Set<string>;
  resultSummaries: Set<string>;
  toolOutputItemIds: Set<string>;
  itemChannels: Map<string, "progress" | "final" | "summary" | "detail" | "unknown">;
  structuredFinalItemIds: Set<string>;
}

function itemChannel(payload: JsonRecord): "progress" | "final" | "summary" | "detail" | "unknown" {
  const channel = text(payload.channel);
  return channel === "progress" || channel === "final" || channel === "summary" || channel === "detail"
    ? channel
    : "unknown";
}

function structuredResultSummary(value: string): string | null {
  if (!value.trimStart().startsWith("{")) return null;
  try {
    const parsed = record(JSON.parse(value));
    return text(parsed.schema) === "paperclip.run_result.v1" && text(parsed.summary)
      ? text(parsed.summary)
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function itemText(item: JsonRecord, payload: JsonRecord): string {
  const direct = text(item.text, text(payload.text));
  if (direct) return direct;
  const summary = Array.isArray(item.summary) ? item.summary : [];
  return summary
    .map((part) => text(record(part).text, text(part)))
    .filter(Boolean)
    .join("\n");
}

function normalizedItemType(item: JsonRecord, payload: JsonRecord): string {
  return text(item.type, text(payload.kind)).replaceAll("_", "").toLowerCase();
}

function itemId(event: JsonRecord, item: JsonRecord): string {
  return text(event.itemId, text(item.id, "paperclip-runner-item"));
}

function toolFailure(item: JsonRecord): boolean {
  const status = text(item.status).toLowerCase();
  const exitCode = item.exitCode ?? item.exit_code;
  return item.isError === true
    || item.is_error === true
    || item.success === false
    || (typeof exitCode === "number" && exitCode !== 0)
    || ["failed", "error", "errored", "cancelled"].includes(status);
}

function commandEntries(
  event: JsonRecord,
  item: JsonRecord,
  phase: "started" | "completed",
  ts: string,
): TranscriptEntry[] {
  const id = itemId(event, item);
  const commandActions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const command = text(item.command, text(record(commandActions[0]).command));
  if (phase === "started") {
    return [{ kind: "tool_call", ts, name: "command", toolUseId: id, input: { command } }];
  }
  const output = text(item.aggregatedOutput, text(item.aggregated_output));
  const exitCode = item.exitCode ?? item.exit_code;
  const detail = [
    typeof exitCode === "number" ? `exit_code: ${exitCode}` : "",
    output,
  ].filter(Boolean).join("\n");
  return [{
    kind: "tool_result",
    ts,
    toolUseId: id,
    toolName: "command",
    content: detail || text(item.status, "command completed"),
    isError: toolFailure(item),
  }];
}

function diffEntries(change: JsonRecord, ts: string): TranscriptEntry[] {
  const path = text(change.path);
  const kind = text(record(change.kind).type, text(change.kind, "update"));
  const raw = text(change.diff);
  const entries: TranscriptEntry[] = [];
  if (path) entries.push({ kind: "diff", ts, changeType: "file_header", text: path });
  for (const line of raw.split("\n")) {
    if (!line && raw.length === 0) continue;
    entries.push({
      kind: "diff",
      ts,
      changeType: kind === "add" ? "add" : kind === "delete" ? "remove" : "context",
      text: line,
    });
  }
  return entries;
}

function fileChangeEntries(
  event: JsonRecord,
  item: JsonRecord,
  phase: "started" | "completed",
  ts: string,
): TranscriptEntry[] {
  const id = itemId(event, item);
  const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
  const paths = changes.map((change) => text(change.path)).filter(Boolean);
  if (phase === "started") {
    return [{
      kind: "tool_call",
      ts,
      name: "file_change",
      toolUseId: id,
      input: { path: paths[0] ?? "", paths },
    }];
  }
  return [
    ...changes.flatMap((change) => diffEntries(change, ts)),
    {
      kind: "tool_result" as const,
      ts,
      toolUseId: id,
      toolName: "file_change",
      content: paths.length > 0 ? paths.join("\n") : "file change completed",
      isError: toolFailure(item),
    },
  ];
}

function dynamicToolEntries(
  event: JsonRecord,
  item: JsonRecord,
  phase: "started" | "completed",
  ts: string,
): TranscriptEntry[] {
  const id = itemId(event, item);
  const name = text(item.tool, text(item.name, "Paperclip tool"));
  if (phase === "started") {
    return [{ kind: "tool_call", ts, name, toolUseId: id, input: item.arguments ?? item.input ?? {} }];
  }
  return [{
    kind: "tool_result",
    ts,
    toolUseId: id,
    toolName: name,
    content: stringify(item.contentItems ?? item.result ?? item.output) || `${name} completed`,
    isError: toolFailure(item),
  }];
}

function genericToolEntries(
  event: JsonRecord,
  item: JsonRecord,
  phase: "started" | "completed",
  ts: string,
): TranscriptEntry[] {
  const id = itemId(event, item);
  const name = text(item.name, text(item.tool, "Tool"));
  if (phase === "started") {
    return [{ kind: "tool_call", ts, name, toolUseId: id, input: item.input ?? item.arguments ?? {} }];
  }
  return [{
    kind: "tool_result",
    ts,
    toolUseId: text(item.tool_use_id, id),
    toolName: name,
    content: stringify(item.content ?? item.result ?? item.output ?? item.error) || `${name} completed`,
    isError: toolFailure(item),
  }];
}

function parseItemEvent(
  event: JsonRecord,
  payload: JsonRecord,
  phase: "started" | "completed",
  ts: string,
  state: PaperclipRunnerParserState,
): TranscriptEntry[] {
  const item = record(payload.item);
  const type = normalizedItemType(item, payload);
  const id = itemId(event, item);
  const channel = itemChannel(payload);
  if (phase === "started") state.itemChannels.set(id, channel);
  const resolvedChannel = channel === "unknown" ? state.itemChannels.get(id) ?? "unknown" : channel;
  if (type === "agentmessage") {
    const value = itemText(item, payload);
    if (phase === "completed") state.itemChannels.delete(id);
    if (!value || state.assistantDeltaItemIds.has(id)) return [];
    if (resolvedChannel === "final") {
      const summary = structuredResultSummary(value);
      if (summary) {
        state.resultSummaries.add(summary);
        return [{ kind: "assistant", ts, text: summary, channel: "final" }];
      }
    }
    return [{ kind: "assistant", ts, text: value, channel: resolvedChannel === "final" ? "final" : resolvedChannel === "progress" ? "progress" : "unknown" }];
  }
  if (type === "reasoning") {
    const value = itemText(item, payload);
    if (phase === "completed") state.itemChannels.delete(id);
    if (value && !state.reasoningDeltaItemIds.has(id)) return [{
      kind: "thinking",
      ts,
      text: value,
      channel: resolvedChannel === "detail" ? "detail" : resolvedChannel === "summary" ? "summary" : "unknown",
    }];
    return phase === "started"
      ? [{ kind: "system", ts, text: "Reasoning started" }]
      : [];
  }
  if (type === "commandexecution") {
    const entries = commandEntries(event, item, phase, ts);
    if (phase === "completed" && state.toolOutputItemIds.has(id)) {
      const result = entries[0];
      if (result?.kind === "tool_result") result.content = "";
    }
    return entries;
  }
  if (type === "filechange") return fileChangeEntries(event, item, phase, ts);
  if (type === "dynamictoolcall") return dynamicToolEntries(event, item, phase, ts);
  if (type === "tooluse" || type === "toolresult" || type === "mcptoolcall") {
    return genericToolEntries(event, item, phase, ts);
  }
  if (type === "usage") return [];
  if (type === "usermessage") return [];
  const detail = itemText(item, payload);
  return detail ? [{ kind: "system", ts, text: detail }] : [];
}

function parseDeltaEvent(
  event: JsonRecord,
  payload: JsonRecord,
  ts: string,
  state: PaperclipRunnerParserState,
): TranscriptEntry[] {
  const kind = text(payload.kind).replaceAll("_", "").toLowerCase();
  const value = text(payload.text);
  const id = text(event.itemId, `${kind || "item"}-delta`);
  const explicitChannel = itemChannel(payload);
  const channel = explicitChannel === "unknown" ? state.itemChannels.get(id) ?? "unknown" : explicitChannel;
  if (!value) return [];
  if (kind === "agentmessage") {
    state.assistantDeltaItemIds.add(id);
    if (channel === "final" && (state.structuredFinalItemIds.has(id) || value.trimStart().startsWith("{"))) {
      state.structuredFinalItemIds.add(id);
      return [];
    }
    return [{ kind: "assistant", ts, text: value, delta: true, channel: channel === "final" ? "final" : channel === "progress" ? "progress" : "unknown" }];
  }
  if (kind === "reasoning") {
    state.reasoningDeltaItemIds.add(id);
    return [{ kind: "thinking", ts, text: value, delta: true, channel: channel === "detail" ? "detail" : channel === "summary" ? "summary" : "unknown" }];
  }
  if (kind === "commandexecution") {
    state.toolOutputItemIds.add(id);
    return [{
      kind: "tool_result",
      ts,
      toolUseId: id,
      toolName: "command",
      content: value,
      isError: false,
      delta: true,
    }];
  }
  if (kind === "filechange" || kind === "diff") {
    return value.split("\n").map((line) => ({
      kind: "diff" as const,
      ts,
      changeType: line.startsWith("+") ? "add" as const : line.startsWith("-") ? "remove" as const : "context" as const,
      text: /^[+-]/.test(line) ? line.slice(1) : line,
    }));
  }
  if (kind === "plan") return [{ kind: "system", ts, text: value }];
  return [{ kind: "system", ts, text: value }];
}

function usageEntry(payload: JsonRecord, ts: string): TranscriptEntry {
  const usage = record(payload.usage);
  const total = record(usage.total);
  return {
    kind: "result",
    ts,
    text: "",
    inputTokens: number(total.inputTokens ?? total.input_tokens),
    outputTokens: number(total.outputTokens ?? total.output_tokens),
    cachedTokens: number(total.cachedInputTokens ?? total.cached_input_tokens),
    costUsd: number(usage.costUsd ?? usage.cost_usd),
    subtype: "paperclip.usage",
    isError: false,
    errors: [],
  };
}

function parsePrpEvent(
  event: JsonRecord,
  ts: string,
  state: PaperclipRunnerParserState,
): TranscriptEntry[] {
  const eventType = text(event.eventType);
  const payload = record(event.payload);
  if (eventType === "session.started" || eventType === "session.resumed") {
    const context = record(payload.context);
    const model = text(context.model, text(record(payload.model).name, "Paperclip runner"));
    const sessionId = text(payload.providerSessionId, text(payload.driverSessionId, text(event.normalizedSessionId)));
    return [{ kind: "system", ts, text: `Paperclip session ${eventType === "session.resumed" ? "resumed" : "started"} · ${model}${sessionId ? ` · ${sessionId}` : ""}` }];
  }
  if (eventType === "turn.started") return [{ kind: "system", ts, text: "Turn started" }];
  if (eventType === "turn.completed") return [{ kind: "system", ts, text: "Turn completed" }];
  if (eventType === "turn.failed") return [{ kind: "stderr", ts, text: text(record(payload.error).message, "Turn failed") }];
  if (eventType === "item.started" || eventType === "item.completed") {
    if (payload.kind === "usage") return [usageEntry(payload, ts)];
    return parseItemEvent(event, payload, eventType === "item.started" ? "started" : "completed", ts, state);
  }
  if (eventType === "item.delta") return parseDeltaEvent(event, payload, ts, state);
  if (eventType === "run.result.proposed" || eventType === "run.result.accepted") {
    const result = eventType === "run.result.accepted" ? record(payload.result) : payload;
    const summary = text(result.summary);
    if (!summary || state.resultSummaries.has(summary)) return [];
    state.resultSummaries.add(summary);
    return [{ kind: "assistant", ts, text: summary, channel: "final" }];
  }
  if (eventType === "harness.diagnostic" || eventType === "session.failed") {
    return [{ kind: "system", ts, text: `Runner: ${text(payload.message, text(payload.code, eventType))}` }];
  }
  return [];
}

function createParserState(): PaperclipRunnerParserState {
  return {
    assistantDeltaItemIds: new Set(),
    reasoningDeltaItemIds: new Set(),
    resultSummaries: new Set(),
    toolOutputItemIds: new Set(),
    itemChannels: new Map(),
    structuredFinalItemIds: new Set(),
  };
}

function parsePaperclipRunnerLine(line: string, ts: string, state: PaperclipRunnerParserState): TranscriptEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return parseCodexStdoutLine(line, ts);
  }
  const envelope = record(parsed);
  if (envelope.type !== "paperclip.prp.event") return parseCodexStdoutLine(line, ts);
  const event = record(envelope.event);
  return Object.keys(event).length > 0 ? parsePrpEvent(event, ts, state) : [];
}

export function parsePaperclipRunnerStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return parsePaperclipRunnerLine(line, ts, createParserState());
}

export const paperclipRunnerUIAdapter: UIAdapterModule = {
  type: "paperclip_runner",
  label: "Paperclip Runner",
  parseStdoutLine: parsePaperclipRunnerStdoutLine,
  createStdoutParser: () => {
    let state = createParserState();
    return {
      parseLine: (line, ts) => parsePaperclipRunnerLine(line, ts, state),
      reset: () => { state = createParserState(); },
    };
  },
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: buildPaperclipRunnerConfig,
};
