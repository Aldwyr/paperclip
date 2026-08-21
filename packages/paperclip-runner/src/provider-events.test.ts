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
      ["item/completed", { item: { id: "web-1", type: "webSearch", action: { type: "search", query: "PRP" } } }],
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
  });

  it("classifies only structured OpenCode parts and never assistant prose", () => {
    expect(canonicalProviderEventsFromOpenCodePart({ id: "tool-1", type: "tool", tool: "read", state: { status: "completed", output: "done" } })[0]?.eventType).toBe("tool.execution.completed");
    expect(canonicalProviderEventsFromOpenCodePart({ id: "text-1", type: "text", text: "I ran a command and delegated work" })).toEqual([]);
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
