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
      .toEqual([{ kind: "thinking", ts: expect.any(String), text: "Inspecting the runner", delta: true, channel: "unknown" }]);
    expect(event("item.delta", { kind: "agentMessage", text: "Here is" }, "message-1"))
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Here is", delta: true, channel: "unknown" }]);
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
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Finished the task", channel: "final" }]);
    expect(line("run.result.accepted", { result: { summary: "Finished the task" } }))
      .toEqual([]);
  });

  it("preserves progress, final-answer, and reasoning channels across item deltas", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string, payload: Record<string, unknown>, itemId: string) => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, itemId, payload },
    }), "2026-08-21T12:00:00.000Z");

    expect(event("item.started", { kind: "agentMessage", channel: "progress", item: { id: "p1", type: "agentMessage", phase: "commentary", text: "" } }, "p1")).toEqual([]);
    expect(event("item.delta", { kind: "agentMessage", channel: "progress", text: "Running it now." }, "p1"))
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Running it now.", delta: true, channel: "progress" }]);

    expect(event("item.started", { kind: "agentMessage", channel: "final", item: { id: "f1", type: "agentMessage", phase: "final_answer", text: "" } }, "f1")).toEqual([]);
    expect(event("item.delta", { kind: "agentMessage", channel: "final", text: "Completed." }, "f1"))
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Completed.", delta: true, channel: "final" }]);

    expect(event("item.delta", { kind: "reasoning", channel: "summary", text: "Inspecting" }, "r1"))
      .toEqual([{ kind: "thinking", ts: expect.any(String), text: "Inspecting", delta: true, channel: "summary" }]);
    expect(event("item.delta", { kind: "reasoning", channel: "detail", text: "Detailed trace" }, "r1"))
      .toEqual([{ kind: "thinking", ts: expect.any(String), text: "Detailed trace", delta: true, channel: "detail" }]);
  });

  it("never exposes the structured task result envelope as final-response prose", () => {
    const parse = paperclipRunnerUIAdapter.createStdoutParser!().parseLine;
    const event = (eventType: string, payload: Record<string, unknown>, itemId = "result-1") => parse(JSON.stringify({
      type: "paperclip.prp.event",
      event: { eventType, itemId, payload },
    }), "2026-08-21T12:00:00.000Z");
    event("item.started", { kind: "agentMessage", channel: "final", item: { id: "result-1", type: "agentMessage", phase: "final_answer", text: "" } });
    expect(event("item.delta", { kind: "agentMessage", channel: "final", text: "{\"schema\":" })).toEqual([]);
    expect(event("item.delta", { kind: "agentMessage", channel: "final", text: "\"paperclip.run_result.v1\"}" })).toEqual([]);
    expect(event("run.result.proposed", { summary: "Human-readable completion." }))
      .toEqual([{ kind: "assistant", ts: expect.any(String), text: "Human-readable completion.", channel: "final" }]);
  });
});
