import type { UIAdapterModule } from "../types";
import { parseCodexStdoutLine, buildPaperclipRunnerConfig } from "@paperclipai/adapter-codex-local/ui";
import { CodexLocalConfigFields } from "../codex-local/config-fields";

function parsePaperclipRunnerStdoutLine(line: string, ts: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return parseCodexStdoutLine(line, ts);
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { type?: unknown }).type !== "paperclip.prp.event") {
    return parseCodexStdoutLine(line, ts);
  }
  const event = (parsed as { event?: unknown }).event;
  if (typeof event !== "object" || event === null) return [];
  const candidate = event as { eventType?: unknown; payload?: unknown };
  const eventType = typeof candidate.eventType === "string" ? candidate.eventType : "";
  const payload = typeof candidate.payload === "object" && candidate.payload !== null
    ? candidate.payload as Record<string, unknown>
    : {};
  if ((eventType === "item.started" || eventType === "item.completed") && payload.item) {
    return parseCodexStdoutLine(JSON.stringify({ type: eventType, item: payload.item }), ts);
  }
  if (eventType === "turn.started") return parseCodexStdoutLine(JSON.stringify({ type: "turn.started" }), ts);
  if (eventType === "turn.completed") {
    return parseCodexStdoutLine(JSON.stringify({ type: "turn.completed", result: payload.result ?? "" }), ts);
  }
  if (eventType === "harness.diagnostic") {
    return [{ kind: "system" as const, ts, text: String(payload.message ?? payload.code ?? "Runner diagnostic") }];
  }
  return [];
}

export const paperclipRunnerUIAdapter: UIAdapterModule = {
  type: "paperclip_runner",
  label: "Paperclip Runner",
  parseStdoutLine: parsePaperclipRunnerStdoutLine,
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: buildPaperclipRunnerConfig,
};
