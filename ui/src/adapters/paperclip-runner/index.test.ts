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
});
