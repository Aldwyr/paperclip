import { describe, expect, it, vi } from "vitest";

import type { AcpRuntimeEvent } from "acpx/runtime";

import {
  PRP_BLOCK_TOOL_NAME,
  PRP_COMPLETION_TOOL_NAME,
} from "../../contracts/completion-result.js";
import type { PrpEvent } from "../../protocol/replay-contract.js";
import { validatePrpEvent } from "../../protocol/replay-contract.js";
import {
  CodexAcpxDriver,
  type CodexAcpxDriverDependencies,
  type CodexAcpxDriverOptions,
} from "./codex-acpx-driver.js";
import type {
  AcpxRuntimeTurnInput,
  AcpxRuntimeTurn,
  OpenAcpxRuntimeHostOptions,
} from "./runtime-host.js";

describe("Codex ACPX harness driver", () => {
  it("advertises only the implemented Codex production surface", async () => {
    const fixture = driverFixture();
    const descriptor = await fixture.driver.descriptor();

    expect(descriptor).toMatchObject({
      kind: "acpx_runtime",
      displayName: "Codex via ACPX",
      capabilities: {
        resume: true,
        interruption: true,
        dynamicTools: true,
        runtimeRequestResolution: true,
        runtimeRequestHandoff: true,
      },
      runtimeContextCapabilities: {
        instructions: "native",
        skills: "unsupported",
        mcp: "native",
      },
    });
    await expect(
      fixture.driver.validateConfig({
        agent: "claude",
        model: "claude-sonnet-5",
        permissionMode: "approve-reads",
      }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ code: "unsupported_agent" }],
    });
  });

  it("maps one turn, dispatches tools, and commits one semantic result", async () => {
    const dynamicToolHandler = vi.fn(async () => ({ title: "Document" }));
    const fixture = driverFixture({ dynamicToolHandler });
    const session = await fixture.driver.openSession({
      runId: "run-1",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");

    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;
    await expect(
      bridgeHandler({
        tool: "documents.read",
        callId: "tool-1",
        arguments: { id: "doc-1" },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ title: "Document" });
    expect(dynamicToolHandler).toHaveBeenCalledWith({
      tool: "documents.read",
      callId: "tool-1",
      providerSessionId: "agent-1",
      turnId,
      arguments: { id: "doc-1" },
      signal: expect.any(AbortSignal),
    });

    await expect(
      bridgeHandler({
        tool: PRP_COMPLETION_TOOL_NAME,
        callId: "finish-1",
        arguments: completedResult(),
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ accepted: true });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });

    const events = await terminalEvents;
    expect(events.every((event) => validatePrpEvent(event).ok)).toBe(true);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "turn.submitted",
        "turn.accepted",
        "turn.started",
        "item.delta",
        "tool.execution.started",
        "run.result.proposed",
        "item.completed",
        "turn.completed",
      ]),
    );
    expect(
      events.findIndex((event) => event.eventType === "run.result.proposed"),
    ).toBeLessThan(
      events.findIndex((event) => event.eventType === "turn.completed"),
    );
    await expect(session.snapshot()).resolves.toMatchObject({
      driverKind: "acpx_runtime",
      activeTurnId: null,
      providerIdentity: {
        kind: "acpx",
        agentSessionId: "agent-1",
      },
      semanticResult: {
        callId: "finish-1",
        turnId,
        result: { reportedWorkDisposition: "done" },
      },
    });
    await session.close({ reason: "complete" });
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("rejects terminal disposition drift and bounds interruption", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-2",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    const bridgeHandler = fixture.hostOptions!.semanticTools!.handler;

    await expect(
      bridgeHandler({
        tool: PRP_BLOCK_TOOL_NAME,
        callId: "block-1",
        arguments: completedResult(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("does not match");
    await session.interrupt({ turnId, reason: "user cancelled" });
    expect(fixture.host.interruptActiveTurn).toHaveBeenCalledWith(
      "user cancelled",
    );
    await expect(session.interrupt({ turnId: "stale-turn" })).rejects.toThrow(
      "is not the active turn",
    );
    await session.close({ reason: "cancelled" });
  });

  it("emits an interrupted terminal before closing an active stream", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-close",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.interrupted");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });

    await Promise.all([
      session.close({ reason: "operator shutdown" }),
      session.close({ reason: "duplicate shutdown" }),
    ]);

    await expect(terminalEvents).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "turn.interrupted" }),
      ]),
    );
    await expect(session.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      terminalTurns: [expect.objectContaining({ turnId: expect.any(String) })],
    });
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("reports a host close timeout and retains cleanup ownership", async () => {
    const fixture = driverFixture({}, { closeSettlementTimeoutMs: 1 });
    const hostClose = deferred<void>();
    fixture.host.close.mockImplementation(() => hostClose.promise);
    const session = await fixture.driver.openSession({
      runId: "run-close-timeout",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.interrupted");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });

    await expect(
      session.close({ reason: "runtime close stalled" }),
    ).rejects.toThrow("host cleanup exceeded its shutdown timeout");
    expect(fixture.host.close).toHaveBeenCalledOnce();
    await expect(terminalEvents).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "turn.interrupted" }),
      ]),
    );
    await expect(session.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      terminalTurns: [expect.objectContaining({ turnId: expect.any(String) })],
    });

    fixture.finishTurn({ status: "cancelled", stopReason: "session_closed" });
    hostClose.resolve();
    await expect(
      session.close({ reason: "finish retained cleanup" }),
    ).resolves.toBeUndefined();
    expect(fixture.host.close).toHaveBeenCalledOnce();
  });

  it("bounds lagging streams without introducing source sequence gaps", async () => {
    const fixture = driverFixture(
      {},
      {
        runtimeEvents: Array.from({ length: 1_100 }, (_, index) => ({
          type: "text_delta" as const,
          text: `chunk-${index}`,
          stream: "output" as const,
        })),
      },
    );
    const session = await fixture.driver.openSession({
      runId: "run-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    await session.startTurn({
      message: { role: "user", text: "Produce many events." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });

    await vi.waitFor(async () => {
      const snapshot = await session.snapshot();
      expect(snapshot.terminalTurns).toHaveLength(1);
    });
    await vi.waitFor(async () => {
      const snapshot = await session.snapshot();
      expect(snapshot.terminalTurns).toHaveLength(1);
      const transcript = await session.transcript!();
      expect(transcript.eventCount).toBeGreaterThan(1_024);
      expect(transcript.complete).toBe(false);
      expect(transcript.events.length).toBeLessThanOrEqual(1_024);
      expect(transcript.omissionReason).toBe("retention_limit");
    });
    await expect(
      session.startTurn({
        message: { role: "user", text: "Do not overtake the lagging consumer." },
      }),
    ).rejects.toThrow("event consumer must drain");

    await session.close({ reason: "bounds verified" });
    const iterator = session.events()[Symbol.asyncIterator]();
    const retained: PrpEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      retained.push(next.value);
    }
    expect(retained.length).toBeLessThanOrEqual(512);
    expect(retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "harness.diagnostic",
          payload: expect.objectContaining({
            code: "event_stream_retention_limit",
          }),
        }),
      ]),
    );
    expect(
      retained.filter((event) => event.eventType === "turn.completed"),
    ).toHaveLength(1);
    expect(retained.map((event) => event.sourceSeq)).toEqual(
      Array.from({ length: retained.length }, (_, index) => index + 1),
    );
  });

  it("preserves every terminal when the bounded consumer keeps draining", async () => {
    const fixture = driverFixture({}, { maxBufferedEvents: 4 });
    const session = await fixture.driver.openSession({
      runId: "run-critical-bounds",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalTurnIds: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const terminalEvents = collectUntil(session.events(), "turn.completed");
      const { turnId } = await session.startTurn({
        message: { role: "user", text: `Complete turn ${index}.` },
      });
      terminalTurnIds.push(turnId);
      fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
      const emitted = await terminalEvents;
      expect(emitted.at(-1)).toMatchObject({
        eventType: "turn.completed",
        turnId,
      });
    }
    await expect(
      session.startTurn({
        message: { role: "user", text: "Exceed the bounded turn limit." },
      }),
    ).rejects.toThrow("bounded session turn limit");

    await session.close({ reason: "critical bounds verified" });
    await expect(session.snapshot()).resolves.toMatchObject({
      terminalTurns: terminalTurnIds.map((turnId) =>
        expect.objectContaining({ turnId }),
      ),
    });
  });

  it("round-trips a provider-neutral ACP form through the runtime request boundary", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-question",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const createdEvent = collectUntil(
      session.events(),
      "runtime_request.created",
    );
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Choose a region." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;
    const controller = new AbortController();
    const providerResponse = onElicitation(
      {
        mode: "form",
        message: "Choose deployment settings.",
        requestedSchema: {
          type: "object",
          title: "Deployment",
          required: ["region"],
          properties: {
            region: {
              type: "string",
              title: "Region",
              enum: ["us-east-1", "eu-west-1"],
            },
          },
        },
      },
      { requestId: "rpc-question-1", signal: controller.signal },
    );
    const events = await createdEvent;
    const request = session.pendingRuntimeRequests!()[0]!;

    expect(events.at(-1)).toMatchObject({
      eventType: "runtime_request.created",
      turnId,
      payload: {
        request: {
          schema: "paperclip.runtime_request.v2",
          requestKind: "runtime",
          type: "input",
          status: "pending",
          input: { schema: "paperclip.question_set.v1" },
          origin: { adapter: "acpx-runtime", provider: "codex" },
        },
      },
    });
    const question = request.input!.questions[0]!;
    const resolvedEvent = collectUntil(
      session.events(),
      "runtime_request.resolved",
    );
    await session.resolveRuntimeRequest!({
      requestId: request.requestId,
      turnId,
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: {
            [question.id]: {
              selectedOptionIds: [question.options![1]!.id],
            },
          },
        },
      },
    });

    await expect(providerResponse).resolves.toEqual({
      action: "accept",
      content: { region: "eu-west-1" },
    });
    await expect(resolvedEvent).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "runtime_request.resolved" }),
      ]),
    );
    expect(session.pendingRuntimeRequests!()).toEqual([]);
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await collectUntil(session.events(), "turn.completed");
    await session.close({ reason: "question verified" });
  });

  it("cancels a pending ACP form when its owning provider request aborts", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-question-abort",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const createdEvent = collectUntil(
      session.events(),
      "runtime_request.created",
    );
    await session.startTurn({
      message: { role: "user", text: "Ask and abort." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;
    const controller = new AbortController();
    const providerResponse = onElicitation(
      {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      { requestId: "rpc-question-abort", signal: controller.signal },
    );
    await createdEvent;
    const cancelledEvent = collectUntil(
      session.events(),
      "runtime_request.cancelled",
    );

    controller.abort();

    await expect(providerResponse).resolves.toEqual({ action: "cancel" });
    await expect(cancelledEvent).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "runtime_request.cancelled" }),
      ]),
    );
    expect(session.pendingRuntimeRequests!()).toEqual([]);
    fixture.finishTurn({ status: "cancelled", stopReason: "aborted" });
    await collectUntil(session.events(), "turn.interrupted");
    await session.close({ reason: "abort verified" });
  });

  it("cancels a pending ACP form when the provider event stream fails", async () => {
    const eventStreamFailure = deferred<void>();
    const fixture = driverFixture(
      {},
      { eventStreamFailure: eventStreamFailure.promise },
    );
    const session = await fixture.driver.openSession({
      runId: "run-question-stream-failure",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const failedEvent = collectUntil(session.events(), "turn.failed");
    await session.startTurn({
      message: { role: "user", text: "Ask before the stream fails." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;
    const providerResponse = onElicitation(
      {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      {
        requestId: "rpc-question-stream-failure",
        signal: new AbortController().signal,
      },
    );
    await vi.waitFor(() => {
      expect(session.pendingRuntimeRequests!()).toHaveLength(1);
    });

    eventStreamFailure.resolve();

    await expect(providerResponse).resolves.toEqual({ action: "cancel" });
    await expect(failedEvent).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ eventType: "runtime_request.cancelled" }),
        expect.objectContaining({ eventType: "turn.failed" }),
      ]),
    );
    expect(session.pendingRuntimeRequests!()).toEqual([]);
    await session.close({ reason: "stream failure verified" });
  });

  it("expires an ACP form before a durable wait without accepting late answers", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-question-handoff",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const createdEvent = collectUntil(
      session.events(),
      "runtime_request.created",
    );
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Ask for input." },
    });
    const onElicitation =
      fixture.host.startTurn.mock.calls[0]![0].onElicitation!;
    const providerResponse = onElicitation(
      {
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
      {
        requestId: "rpc-question-handoff",
        signal: new AbortController().signal,
      },
    );
    await createdEvent;
    const [request] = session.pendingRuntimeRequests!();

    await expect(
      session.handoffRuntimeRequest!({
        requestId: request!.requestId,
        turnId,
        reason: "durable_handoff",
      }),
    ).resolves.toBe("handed_off");
    await expect(providerResponse).resolves.toEqual({ action: "cancel" });
    expect(fixture.host.interruptActiveTurn).toHaveBeenCalledWith(
      "Paperclip parked the ACPX input on a durable wait.",
    );
    await expect(
      session.resolveRuntimeRequest!({
        requestId: request!.requestId,
        turnId,
        resolution: { action: "cancel" },
      }),
    ).rejects.toThrow("no longer pending");
    fixture.finishTurn({ status: "cancelled", stopReason: "durable_wait" });
    await collectUntil(session.events(), "turn.interrupted");
    await session.close({ reason: "handoff verified" });
  });

  it("recovers a settled session with the exact persisted identity", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");
    await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    await fixture.hostOptions!.semanticTools!.handler({
      tool: PRP_COMPLETION_TOOL_NAME,
      callId: "finish-recovery",
      arguments: completedResult(),
      signal: new AbortController().signal,
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await terminalEvents;
    const snapshot = await session.snapshot();
    await session.close({ reason: "simulate restart" });

    const recovery = await fixture.driver.recoverSession!(snapshot);

    expect(recovery).toMatchObject({ recovered: true });
    expect(fixture.readRecoveryWorkspace).toHaveBeenCalledWith({
      runtimeDirectory: "/runtime",
      normalizedSessionId: "session-1",
    });
    expect(fixture.hostOptions?.expectedIdentity).toEqual(
      snapshot.providerIdentity,
    );
    await expect(recovery.session!.snapshot()).resolves.toMatchObject({
      driverSessionId: snapshot.driverSessionId,
      providerSessionId: snapshot.providerSessionId,
      providerRecoveryPolicy: "same_session_only",
      lastSourceSequence: snapshot.lastSourceSequence,
      semanticResult: snapshot.semanticResult,
      activeTurnId: null,
    });
    await recovery.session!.close({ reason: "recovery verified" });
  });

  it("clears a checkpoint race when the active turn is already terminal", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-terminal-race",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const terminalEvents = collectUntil(session.events(), "turn.completed");
    const { turnId } = await session.startTurn({
      message: { role: "user", text: "Complete the task." },
    });
    fixture.finishTurn({ status: "completed", stopReason: "end_turn" });
    await terminalEvents;
    const snapshot = await session.snapshot();
    snapshot.activeTurnId = turnId;
    await session.close({ reason: "simulate checkpoint race" });

    const recovery = await fixture.driver.recoverSession!(snapshot);

    expect(recovery).toMatchObject({ recovered: true });
    await expect(recovery.session!.snapshot()).resolves.toMatchObject({
      activeTurnId: null,
      terminalTurns: [expect.objectContaining({ turnId })],
    });
    await recovery.session!.close({ reason: "checkpoint race verified" });
  });

  it("fails closed when a checkpoint contains an unproved active turn", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-active-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    await session.startTurn({
      message: { role: "user", text: "Continue working." },
    });
    const snapshot = await session.snapshot();

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason: "active Codex ACPX turn continuity is unavailable",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    expect(fixture.openHost).toHaveBeenCalledOnce();
    await session.close({ reason: "active recovery rejected" });
  });

  it("rejects a tampered recovery result before reopening the provider", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-tampered-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const snapshot = await session.snapshot();
    snapshot.semanticResult = {
      result: completedResult(),
      fingerprint: "tampered",
      turnId: "turn-settled",
    };

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason: "persisted Codex ACPX semantic result is invalid",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    expect(fixture.openHost).toHaveBeenCalledOnce();
    await session.close({ reason: "tampered recovery rejected" });
  });

  it("rejects an unimplemented replacement policy before reopening", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-policy-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const snapshot = await session.snapshot();
    snapshot.providerRecoveryPolicy = "allow_replacement_after_resume_failure";

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason: "persisted Codex ACPX recovery policy is unsupported",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    expect(fixture.openHost).toHaveBeenCalledOnce();
    await session.close({ reason: "replacement recovery rejected" });
  });

  it("rejects oversized terminal history before reopening", async () => {
    const fixture = driverFixture();
    const session = await fixture.driver.openSession({
      runId: "run-bounded-recovery",
      normalizedSessionId: "session-1",
      workingDirectory: "/workspace",
    });
    const snapshot = await session.snapshot();
    snapshot.terminalTurns = Array.from({ length: 4_097 }, (_, index) => ({
      turnId: `turn-${index}`,
      fingerprint: "terminal",
    }));

    await expect(fixture.driver.recoverSession!(snapshot)).resolves.toEqual({
      recovered: false,
      reason: "persisted Codex ACPX terminal history exceeds its limit",
    });
    expect(fixture.readRecoveryWorkspace).not.toHaveBeenCalled();
    expect(fixture.openHost).toHaveBeenCalledOnce();
    await session.close({ reason: "bounded recovery rejected" });
  });
});

function driverFixture(
  overrides: Partial<CodexAcpxDriverOptions> = {},
  fixtureOptions: {
    runtimeEvents?: readonly AcpRuntimeEvent[];
    closeSettlementTimeoutMs?: number;
    maxBufferedEvents?: number;
    eventStreamFailure?: Promise<void>;
  } = {},
): {
  driver: CodexAcpxDriver;
  host: ReturnType<typeof fakeHost>;
  openHost: ReturnType<typeof vi.fn>;
  readRecoveryWorkspace: ReturnType<typeof vi.fn>;
  hostOptions: OpenAcpxRuntimeHostOptions | null;
  finishTurn(result: Awaited<AcpxRuntimeTurn["result"]>): void;
} {
  const result = deferred<Awaited<AcpxRuntimeTurn["result"]>>();
  const turn: AcpxRuntimeTurn = {
    requestId: "provider-turn-1",
    promptStarted: Promise.resolve(),
    events: {
      async *[Symbol.asyncIterator]() {
        yield* fixtureOptions.runtimeEvents ?? [
          {
            type: "text_delta" as const,
            text: "Task complete.",
            stream: "output" as const,
          },
          {
            type: "tool_call" as const,
            toolCallId: "provider-tool-1",
            title: "Read",
            kind: "read" as const,
            status: "pending",
            tag: "tool_call",
            text: "Reading",
          },
        ];
        if (fixtureOptions.eventStreamFailure) {
          await fixtureOptions.eventStreamFailure;
          throw new Error("provider event stream failed");
        }
      },
    },
    result: result.promise,
    cancel: vi.fn(async () => undefined),
    closeStream: vi.fn(async () => undefined),
  };
  const host = fakeHost(turn, () =>
    result.resolve({ status: "cancelled", stopReason: "session_closed" }),
  );
  let hostOptions: OpenAcpxRuntimeHostOptions | null = null;
  const openHost = vi.fn(async (options: OpenAcpxRuntimeHostOptions) => {
    hostOptions = options;
    return host;
  });
  const readRecoveryWorkspace = vi.fn(async () => "/workspace");
  const dependencies: CodexAcpxDriverDependencies = {
    openHost,
    readRecoveryWorkspace,
    closeSettlementTimeoutMs: fixtureOptions.closeSettlementTimeoutMs,
    maxBufferedEvents: fixtureOptions.maxBufferedEvents,
  };
  const driver = new CodexAcpxDriver(
    {
      runtimeDirectory: "/runtime",
      model: "gpt-5.6-sol",
      permissionMode: "approve-reads",
      dynamicTools: [
        {
          name: "documents.read",
          inputSchema: { type: "object" },
        },
      ],
      now: () => new Date("2026-08-27T12:00:00.000Z"),
      ...overrides,
    },
    dependencies,
  );
  return {
    driver,
    host,
    openHost,
    readRecoveryWorkspace,
    get hostOptions() {
      return hostOptions;
    },
    finishTurn: result.resolve,
  };
}

function fakeHost(turn: AcpxRuntimeTurn, onClose: () => void) {
  return {
    identity: () => ({
      schema: "paperclip.runner.acpx-identity.v1" as const,
      normalizedSessionId: "session-1",
      acpxRecordId: "record-1",
      backendSessionId: "backend-1",
      agentSessionId: "agent-1",
      profileDigest: `sha256:${"a".repeat(64)}`,
      workspaceDigest: `sha256:${"b".repeat(64)}`,
      requestedModel: "gpt-5.6-sol",
      effectiveModel: "gpt-5.6-sol",
      permissionMode: "approve-reads" as const,
    }),
    binding: () => ({
      normalizedSessionId: "session-1",
      workspacePath: "/workspace",
      workspaceDigest: `sha256:${"b".repeat(64)}`,
      runtimeRoot: "/runtime/acpx/session-1",
      profileDigest: `sha256:${"a".repeat(64)}`,
      requestedModel: "gpt-5.6-sol",
      effectiveModel: "gpt-5.6-sol",
      permissionMode: "approve-reads" as const,
      profileSessionKey: "paperclip-session",
    }),
    status: vi.fn(async () => ({
      agentSessionId: "agent-1",
      models: {
        currentModelId: "gpt-5.6-sol",
        availableModelIds: ["gpt-5.6-sol"],
      },
    })),
    startTurn: vi.fn((_input: AcpxRuntimeTurnInput) => turn),
    interruptActiveTurn: vi.fn(async () => undefined),
    close: vi.fn(async () => {
      onClose();
    }),
  };
}

async function collectUntil(
  events: AsyncIterable<PrpEvent>,
  terminalType: PrpEvent["eventType"],
): Promise<PrpEvent[]> {
  const collected: PrpEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.eventType === terminalType) return collected;
  }
  throw new Error(`Event stream closed before ${terminalType}`);
}

function completedResult() {
  return {
    schema: "paperclip.run_result.v1" as const,
    reportedWorkDisposition: "done" as const,
    summary: "The task is complete.",
    completionClaim: {
      contractRevision: "codex-acpx-test-v1",
      objectiveSatisfied: true,
      criteria: [],
      remainingWork: [],
    },
    evidence: [],
    verification: [
      { commandOrCheck: "Codex ACPX driver test", status: "passed" as const },
    ],
    attentionRequests: [],
    artifacts: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
