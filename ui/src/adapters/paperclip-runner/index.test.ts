import { describe, expect, it } from "vitest";
import { paperclipRunnerUIAdapter } from "./index";

describe("paperclip runner transcript projection", () => {
  it("renders committed PRP semantic tool items with the existing chat parts", () => {
    const started = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({
      type: "paperclip.prp.event",
      event: {
        eventType: "item.started",
        payload: { item: { type: "tool_use", id: "call-1", name: "get_task_context", input: {} } },
      },
    }), "2026-08-21T12:00:00.000Z");
    const completed = paperclipRunnerUIAdapter.parseStdoutLine(JSON.stringify({
      type: "paperclip.prp.event",
      event: {
        eventType: "item.completed",
        payload: { item: { type: "tool_result", id: "call-1", tool_use_id: "call-1", result: { ok: true } } },
      },
    }), "2026-08-21T12:00:01.000Z");
    expect(started).toEqual([expect.objectContaining({ kind: "tool_call", name: "get_task_context", toolUseId: "call-1" })]);
    expect(completed).toEqual([expect.objectContaining({ kind: "tool_result", toolUseId: "call-1", isError: false })]);
  });

  it("maps native Codex deltas, camel-case tools, and usage into the shared chat transcript", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string, payload: Record<string, unknown>, itemId?: string) => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, itemId, payload },
    }), "2026-08-21T12:00:00.000Z");

    expect(event("item.delta", { kind: "reasoning", text: "Inspecting the runner" }, "reason-1"))
      .toEqual([{ kind: "thinking", ts: expect.any(String), text: "Inspecting the runner", delta: true }]);
    expect(event("item.delta", { kind: "agentMessage", text: "Here is" }, "message-1"))
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Here is", delta: true }]);
    expect(event("item.started", {
      kind: "commandExecution",
      item: { id: "exec-1", type: "commandExecution", command: "pnpm test", status: "inProgress" },
    }, "exec-1")).toEqual([
      expect.objectContaining({ kind: "tool_call", name: "command", toolUseId: "exec-1" }),
    ]);
    expect(event("item.completed", {
      kind: "usage",
      usage: { total: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 80 } },
    })).toEqual([
      expect.objectContaining({ kind: "result", subtype: "paperclip.usage", inputTokens: 120, outputTokens: 30 }),
    ]);
  });

  it("emits a proposed and accepted terminal summary only once", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const line = (eventType: string, payload: Record<string, unknown>) => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, payload },
    }), "2026-08-21T12:00:00.000Z");

    expect(line("run.result.proposed", { summary: "Finished the task" }))
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Finished the task" }]);
    expect(line("run.result.accepted", { result: { summary: "Finished the task" } }))
      .toEqual([]);
  });
});
