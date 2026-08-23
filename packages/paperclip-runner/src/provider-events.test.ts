import { describe, expect, it } from "vitest";

import { redactCapabilityEvidenceData } from "./live/evidence-redaction.js";
import {
  CODEX_THREAD_ITEM_CLASSIFICATION,
  PROVIDER_EVENT_FAMILIES,
  canonicalProviderEventsFromCodex,
  canonicalProviderEventsFromOpenCodePart,
  providerFamilyCapabilities,
} from "./provider-events.js";
import { validatePrpEvent } from "./protocol/replay-contract.js";

function envelope(event: ReturnType<typeof canonicalProviderEventsFromCodex>[number]) {
  return {
    schema: "paperclip.prp.event.v1", sourceEventId: `source:${event.itemId}`, sourceSeq: 1,
    sourceInstanceId: "runner-1", sourceKind: "runner", runId: "run-1",
    normalizedSessionId: "session-1", turnId: "turn-1", itemId: event.itemId,
    eventType: event.eventType, schemaVersion: 1, priority: 1,
    emittedAt: "2026-08-21T12:00:00.000Z", payload: event.payload,
  };
}

describe("provider-neutral events", () => {
  it("classifies the complete qualified 18-variant Codex ThreadItem inventory", () => {
    expect(Object.keys(CODEX_THREAD_ITEM_CLASSIFICATION)).toEqual([
      "userMessage", "hookPrompt", "agentMessage", "plan", "reasoning",
      "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall",
      "collabAgentToolCall", "subAgentActivity", "webSearch", "imageView",
      "sleep", "imageGeneration", "enteredReviewMode", "exitedReviewMode",
      "contextCompaction",
    ]);
    expect(Object.values(CODEX_THREAD_ITEM_CLASSIFICATION)).not.toContain("unclassified");
  });

  it("negotiates every declared family and preserves explicit unsupported states", () => {
    const capabilities = providerFamilyCapabilities({ plan: "available", artifact: "policy_disabled" });
    expect(capabilities).toHaveLength(PROVIDER_EVENT_FAMILIES.length);
    expect(capabilities.find((entry) => entry.family === "plan")?.detailLevel).toBe("structured");
    expect(capabilities.find((entry) => entry.family === "artifact")?.availability).toBe("policy_disabled");
    expect(capabilities.find((entry) => entry.family === "memory")?.availability).toBe("unsupported");
  });

  it("maps representative Codex variants across every canonical family to valid PRP", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["item/completed", { item: { id: "plan-1", type: "plan", text: "Ship it" } }],
      ["item/completed", { item: { id: "exec-1", type: "commandExecution", status: "completed", output: "ok" } }],
      ["item/completed", { item: { id: "web-1", type: "webSearch", action: { type: "search", query: "PRP" }, results: [{ ref_id: "source-1", title: "Protocol notes", url: "https://example.com/prp", snippet: "Canonical event details" }] } }],
      ["item/completed", { item: { id: "child-1", type: "collabAgentToolCall", tool: "spawnAgent" } }],
      ["model/rerouted", { turnId: "turn-1", fromModel: "gpt-5", toModel: "gpt-5.1", reason: "capacity" }],
      ["thread/compacted", { itemId: "compact-1" }],
      ["item/completed", { item: { id: "image-1", type: "imageView", path: "artifacts/a.png" } }],
      ["item/completed", { item: { id: "review-1", type: "enteredReviewMode" } }],
      ["hook/completed", { run: { id: "hook-1", eventName: "post-tool", scope: "workspace", status: "completed" } }],
      ["item/completed", { item: { id: "message-1", type: "agentMessage", memoryCitation: { entries: [{ label: "Decision" }] } } }],
      ["item/autoApprovalReview/completed", { reviewId: "safety-1", targetItemId: "exec-1" }],
      ["item/commandExecution/terminalInteraction", { itemId: "exec-1", stdin: "secret input" }],
      ["item/completed", { item: { id: "wait-1", type: "sleep", durationMs: 1000 } }],
      ["warning", { message: "Update the provider configuration" }],
    ];
    const mapped = cases.flatMap(([method, params]) => canonicalProviderEventsFromCodex(method, params));
    expect(mapped).toHaveLength(cases.length);
    for (const event of mapped) expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
    expect(JSON.stringify(mapped.find((entry) => entry.eventType === "terminal.input.sent"))).not.toContain("secret input");
    expect(mapped.find((entry) => entry.eventType === "research.completed")?.payload.sources).toEqual([{
      sourceId: "source-1",
      title: "Protocol notes",
      url: "https://example.com/prp",
      snippet: "Canonical event details",
    }]);
  });

  it("bounds and filters Codex research sources before they enter PRP", () => {
    const event = canonicalProviderEventsFromCodex("item/completed", {
      item: {
        id: "web-1",
        type: "webSearch",
        results: [
          { ref_id: "good", title: "Good", url: "https://example.com/good", snippet: "x".repeat(5000) },
          { ref_id: "unsafe", title: "Unsafe", url: "file:///etc/passwd" },
        ],
      },
    })[0]!;
    expect(event.payload.sources).toEqual([expect.objectContaining({ sourceId: "good", url: "https://example.com/good", snippet: "x".repeat(4000) })]);
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("marks a turn plan complete when every native step is complete", () => {
    const event = canonicalProviderEventsFromCodex("turn/plan/updated", {
      turnId: "turn-1",
      plan: [
        { step: "Inspect", status: "completed" },
        { step: "Implement", status: "completed" },
      ],
    })[0]!;
    expect(event).toMatchObject({
      eventType: "plan.updated",
      payload: { complete: true, syncStatus: "pending" },
    });
  });

  it("classifies only structured OpenCode parts and never assistant prose", () => {
    expect(canonicalProviderEventsFromOpenCodePart({ id: "tool-1", type: "tool", tool: "read", state: { status: "completed", output: "done" } })[0]?.eventType).toBe("tool.execution.completed");
    expect(canonicalProviderEventsFromOpenCodePart({ id: "text-1", type: "text", text: "I ran a command and delegated work" })).toEqual([]);
  });

  it("maps OpenCode pending dynamic tools to a valid builtin execution start", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "prt_02c35c313001X42cqyvQrpXOFv",
      type: "tool",
      tool: "paperclip_report_progress",
      callID: "call_6cd0302e681d44c2aba3c164",
      state: { status: "pending", input: {}, raw: "" },
    })[0]!;
    expect(event).toMatchObject({
      eventType: "tool.execution.started",
      payload: {
        schema: "paperclip.tool.execution.v1",
        transport: "builtin",
        status: "running",
        name: "paperclip_report_progress",
      },
    });
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("presents OpenCode's server-qualified semantic tool with its canonical name", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "finish-1",
      type: "tool",
      tool: "paperclip_paperclip_finish",
      state: { status: "running", input: {} },
    })[0]!;
    expect(event.payload).toMatchObject({ name: "paperclip_finish", transport: "builtin" });
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("recovers an interrupted OpenCode function label and error from its structured call id", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "prt_interrupted",
      type: "tool",
      tool: "unknown",
      callID: "functions.todowrite:0",
      state: {
        status: "error",
        input: {},
        error: "Tool execution aborted",
        metadata: { interrupted: true },
      },
    })[0]!;
    expect(event).toMatchObject({
      eventType: "tool.execution.completed",
      payload: {
        name: "todowrite",
        status: "failed",
        output: "Tool execution aborted",
        outputBytes: 22,
      },
    });
    expect(validatePrpEvent(envelope(event))).toEqual({ ok: true, event: expect.any(Object), issues: [] });
  });

  it("does not infer a tool label from an opaque provider call id", () => {
    const event = canonicalProviderEventsFromOpenCodePart({
      id: "prt_unknown",
      type: "tool",
      tool: "unknown",
      callID: "call_f3d79e",
      state: { status: "error", error: "Unavailable" },
    })[0]!;
    expect(event.payload).toMatchObject({ name: "unknown", output: "Unavailable" });
  });

  it("redacts secrets at durable ingestion while retaining bounded canonical output", () => {
    const output = `Bearer sk-secretvalue ${"x".repeat(70_000)}`;
    const redacted = redactCapabilityEvidenceData("provider_event", {
      canonicalEventType: "tool.execution.completed", itemId: "exec-1",
      payload: { schema: "paperclip.tool.execution.v1", output, password: "must-not-survive" },
    });
    expect(JSON.stringify(redacted)).not.toContain("sk-secretvalue");
    expect(JSON.stringify(redacted)).not.toContain("must-not-survive");
    expect(String((redacted.payload as Record<string, unknown>).output).length).toBeLessThanOrEqual(64 * 1024 + 1);
  });

  it("rejects a canonical event whose payload belongs to another family", () => {
    const plan = canonicalProviderEventsFromCodex("item/completed", {
      item: { id: "plan-1", type: "plan", text: "Ship it" },
    })[0]!;
    expect(validatePrpEvent(envelope({
      ...plan,
      eventType: "tool.execution.completed",
    }))).toMatchObject({ ok: false });
  });
});
