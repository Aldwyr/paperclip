import { describe, expect, it, vi } from "vitest";

import type { ControlPlanePort } from "./contracts/control-plane-port.js";
import type { NativeExecutionInputV1 } from "./contracts/native-execution.js";
import type {
  NativeSession,
  NativeSessionBackend,
  PersistedNativeSession,
} from "./contracts/native-session-backend.js";
import type {
  PrpEvent,
  PrpStructuredRunResult,
  PrpTerminalState,
} from "./protocol/replay-contract.js";
import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
} from "./contracts/runtime-context.js";
import { executeNativeSession } from "./native-session-runtime.js";

const identity = {
  runId: "run-recovery",
  sessionId: "session-recovery",
  companyId: "company-recovery",
  issueId: "issue-recovery",
  agentId: "agent-recovery",
};

const result: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1",
  reportedWorkDisposition: "done",
  summary: "Recovered native work completed.",
  completionClaim: {
    contractRevision: "1",
    objectiveSatisfied: true,
    criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }],
    remainingWork: [],
  },
  evidence: [],
  verification: [{ commandOrCheck: "recovery", status: "passed" }],
  attentionRequests: [],
  artifacts: [],
};

const terminal: PrpTerminalState = {
  schema: "paperclip.prp.terminal.v1",
  turnTerminalState: "completed",
  runTerminalState: "succeeded",
  reportedWorkDisposition: "done",
};

const input: NativeExecutionInputV1 = {
  schema: "paperclip.native-execution-input.v1",
  binding: {
    companyId: identity.companyId,
    runId: identity.runId,
    issueId: identity.issueId,
    agentId: identity.agentId,
    executionWorkspaceId: "workspace-recovery",
  },
  task: {
    identifier: "PAP-RECOVERY",
    title: "Recover native work",
    description: null,
    prompt: "# PAP-RECOVERY: Recover native work",
    workMode: "standard",
  },
  workspace: { cwd: "/workspace", repoUrl: null, repoRef: null, branchName: null },
  session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1 },
  provider: { kind: "codex", model: null },
  completionContract: {
    id: "contract-recovery",
    sha256: "contract-recovery-sha",
    schemaVersion: "paperclip.completion-contract.v1",
    contract: {
      revision: "1",
      objective: "Recover native work",
      criteria: [{ id: "objective", requirement: "Complete after recovery" }],
    },
  },
  interactionResponses: [],
  credentialBindings: [],
};

function controlEvent(
  sourceSeq: number,
  eventType: PrpEvent["eventType"],
  payload: Record<string, unknown>,
): PrpEvent {
  return {
    schema: "paperclip.prp.event.v1",
    sourceEventId: `control-recovery:${identity.runId}:${sourceSeq}`,
    sourceSeq,
    sourceInstanceId: "control-recovery",
    sourceKind: "control_plane",
    runId: identity.runId,
    normalizedSessionId: identity.sessionId,
    turnId: "turn-recovery",
    eventType,
    schemaVersion: 1,
    priority: 0,
    emittedAt: "2026-08-09T00:00:00.000Z",
    payload,
  };
}

function highestContiguous(events: PrpEvent[]): number {
  const sequences = new Set(events.map((event) => event.sourceSeq));
  let cursor = 0;
  while (sequences.has(cursor + 1)) cursor += 1;
  return cursor;
}

describe("executeNativeSession recovery", () => {
  it("fails closed before launch when a v3 driver does not declare complete native context realization", async () => {
    const digest = "0".repeat(64);
    const context = {
      prompt: {
        revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
        text: PAPERCLIP_EXECUTION_PROMPT,
        digest: nativeRuntimePromptDigest(),
      },
      instructions: {
        entryPath: "AGENTS.md",
        bundle: {
          schema: NATIVE_RUNTIME_ASSET_SCHEMA,
          digest,
          manifestDigest: digest,
          rootPath: "/paperclip/context/instructions",
          fileCount: 1,
          totalBytes: 1,
        },
      },
      skills: [],
      mcp: { assignmentSetId: "none", digest, bindingId: null },
    } as const;
    const openSession = vi.fn();
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "future-provider",
          name: "future-provider",
          version: "1",
          capabilities: {
            resume: false,
            typedEvents: true,
            steering: false,
            interruption: false,
            structuredResult: true,
          },
        };
      },
      openSession,
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input: {
        ...input,
        schema: "paperclip.native-execution-input.v3",
        executionMode: "default",
        planningContext: null,
        runtimeContext: {
          ...context,
          aggregateDigest: canonicalNativeRuntimeContextDigest(context),
        },
      },
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).rejects.toThrow("does not natively realize instructions, skills, mcp");
    expect(openSession).not.toHaveBeenCalled();
  });

  it("contains a consumer rejection when starting the turn fails first", async () => {
    let closeStream = () => {};
    const streamClosed = new Promise<void>((resolve) => { closeStream = resolve; });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { await streamClosed; },
      async startTurn() { throw new Error("start turn failed"); },
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: "driver-recovery",
          identity,
          providerSessionId: "provider-recovery",
          cursor: null,
          activeTurnId: null,
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      async close() { closeStream(); },
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent() { throw new Error("unexpected event"); },
      async replayEvents() { return { events: [], highestContiguousSourceSeq: 0 }; },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).rejects.toThrow("start turn failed");
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  it("continues a provider-reported active turn without starting a duplicate turn", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "0",
      activeTurnId: null,
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const providerSnapshot: PersistedNativeSession = {
      ...checkpoint,
      cursor: "1",
      activeTurnId: "turn-recovery",
    };
    const terminalEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "provider-recovery:1",
      sourceSeq: 1,
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-recovery",
      eventType: "turn.completed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:00.000Z",
      payload: {},
    };
    const bySource = new Map<string, PrpEvent[]>();
    const startTurn = vi.fn(async () => ({ turnId: "duplicate-turn" }));
    const openSession = vi.fn(async () => { throw new Error("must recover the provider session"); });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield terminalEvent; },
      startTurn,
      async result() { return { result, terminal, turnId: "turn-recovery" }; },
      async snapshot() { return structuredClone(providerSnapshot); },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      openSession,
      async recoverSession() { return { recovered: true, session }; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession() {},
      async appendEvent(event) {
        const list = bySource.get(event.sourceInstanceId) ?? [];
        list.push(structuredClone(event));
        bySource.set(event.sourceInstanceId, list);
        return {
          cursor: list.length,
          highestContiguousSourceSeq: highestContiguous(list),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const list = bySource.get(replay.sourceInstanceId) ?? [];
        return {
          events: structuredClone(list.filter((event) => event.sourceSeq > replay.afterSourceSeq)),
          highestContiguousSourceSeq: highestContiguous(list),
        };
      },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).resolves.toMatchObject({ turnId: "turn-recovery", providerSessionId: "provider-recovery" });
    expect(openSession).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("starts a continuation after the driver clears a stale active terminal turn", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "1",
      activeTurnId: "turn-already-terminal",
      terminalTurns: [{ turnId: "turn-already-terminal", fingerprint: "terminal-fingerprint" }],
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const recoveredSnapshot: PersistedNativeSession = {
      ...checkpoint,
      activeTurnId: null,
    };
    const terminalEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "provider-recovery:2",
      sourceSeq: 2,
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-continuation",
      eventType: "turn.completed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:01.000Z",
      payload: {},
    };
    const startTurn = vi.fn(async () => ({ turnId: "turn-continuation" }));
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield terminalEvent; },
      startTurn,
      async result() { return { result, terminal, turnId: "turn-continuation" }; },
      async snapshot() { return structuredClone(recoveredSnapshot); },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { throw new Error("must recover the provider session"); },
      async recoverSession() { return { recovered: true, session }; },
    };
    const bySource = new Map<string, PrpEvent[]>();
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession() {},
      async appendEvent(event) {
        const list = bySource.get(event.sourceInstanceId) ?? [];
        list.push(structuredClone(event));
        bySource.set(event.sourceInstanceId, list);
        return {
          cursor: list.length,
          highestContiguousSourceSeq: highestContiguous(list),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const list = bySource.get(replay.sourceInstanceId) ?? [];
        return {
          events: structuredClone(list.filter((event) => event.sourceSeq > replay.afterSourceSeq)),
          highestContiguousSourceSeq: highestContiguous(list),
        };
      },
      async completeRun() {},
    };

    await expect(executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    })).resolves.toMatchObject({ turnId: "turn-continuation", providerSessionId: "provider-recovery" });
    expect(startTurn).toHaveBeenCalledOnce();
    const recoveryEnvelope = JSON.parse(
      startTurn.mock.calls[0]![0].message.text,
    ) as { task: { prompt: string } };
    expect(recoveryEnvelope.task.prompt).toContain(
      "semantic-result recovery for a prior completed provider turn",
    );
    expect(recoveryEnvelope.task.prompt).toContain(
      "Do not repeat implementation, tests, research, or the final answer",
    );
  });

  it("recovers a completed checkpoint and appends only a missing control terminal fact", async () => {
    const checkpoint: PersistedNativeSession = {
      backendKind: "mock",
      sessionId: "driver-recovery",
      identity,
      providerSessionId: "provider-recovery",
      cursor: "4",
      semanticResult: result,
      terminal,
      activeTurnId: "turn-recovery",
      terminalTurns: [{ turnId: "turn-recovery", fingerprint: "terminal-fingerprint" }],
      pendingRuntimeRequests: [],
      lineage: [],
    };
    const events = [controlEvent(1, "run.result.accepted", { result })];
    const checkpoints: PersistedNativeSession[] = [];
    const completeRun = vi.fn(async () => undefined);
    const startTurn = vi.fn(async () => ({ turnId: "unexpected-turn" }));
    const openSession = vi.fn(async () => {
      throw new Error("a recovered run must not open a second provider session");
    });
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() {},
      startTurn,
      async result() { return { result, terminal, turnId: "turn-recovery" }; },
      async snapshot() { return structuredClone(checkpoint); },
      async close() {},
    };
    const recoverSession = vi.fn(async () => ({ recovered: true, session }));
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "recovery-backend",
          version: "1",
          capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      openSession,
      recoverSession,
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async loadSessionCheckpoint() { return structuredClone(checkpoint); },
      async checkpointSession(snapshot) { checkpoints.push(structuredClone(snapshot)); },
      async appendEvent(event) {
        events.push(structuredClone(event as PrpEvent));
        return {
          cursor: events.length,
          highestContiguousSourceSeq: highestContiguous(events),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const replayed = events.filter((event) => event.sourceSeq > replay.afterSourceSeq);
        return { events: structuredClone(replayed), highestContiguousSourceSeq: highestContiguous(events) };
      },
      completeRun,
    };

    const completed = await executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
    });

    expect(openSession).not.toHaveBeenCalled();
    expect(recoverSession).toHaveBeenCalledOnce();
    expect(startTurn).not.toHaveBeenCalled();
    expect(events.map((event) => event.eventType)).toEqual(["run.result.accepted", "run.terminal"]);
    expect(events.map((event) => event.sourceSeq)).toEqual([1, 2]);
    expect(completeRun).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({ nativeEventCount: 1, highestContiguousSourceSeq: 2 });
    expect(checkpoints.at(-1)).toMatchObject({ semanticResult: result, terminal });
  });

  it("accepts a control-plane governed wait when a completed turn omitted its semantic result", async () => {
    const terminalEvent: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: "provider-recovery:1",
      sourceSeq: 1,
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      runId: identity.runId,
      normalizedSessionId: identity.sessionId,
      turnId: "turn-waiting",
      eventType: "turn.completed",
      schemaVersion: 1,
      priority: 0,
      emittedAt: "2026-08-09T00:00:00.000Z",
      payload: {},
    };
    const yielded: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary: "Waiting for the requested response.",
      completionClaim: {
        contractRevision: "1",
        objectiveSatisfied: false,
        criteria: [{ criterionId: "objective", status: "unknown", evidenceRefs: ["interaction:pending"] }],
        remainingWork: [{ description: "Resume after the response.", blocksCompletion: true }],
      },
      evidence: [{ ref: "interaction:pending" }],
      verification: [],
      attentionRequests: [],
      artifacts: [],
      continuation: {
        kind: "response_wake",
        summary: "Resume from the answer.",
        idempotencyKey: "interaction-response:pending",
      },
    };
    const events: PrpEvent[] = [];
    const completeRun = vi.fn(async () => undefined);
    const resolveMissingResult = vi.fn(async () => yielded);
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true };
      },
      async *events() { yield terminalEvent; },
      async startTurn() { return { turnId: "turn-waiting" }; },
      async result() { return null; },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "provider-waiting",
          cursor: "1",
          activeTurnId: "turn-waiting",
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "governed-wait-backend",
          version: "1",
          capabilities: { resume: false, typedEvents: true, steering: false, interruption: true, structuredResult: true },
        };
      },
      async openSession() { return session; },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent(event) {
        events.push(structuredClone(event as PrpEvent));
        return {
          cursor: events.length,
          highestContiguousSourceSeq: highestContiguous(events),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const replayed = events.filter((event) =>
          event.sourceInstanceId === replay.sourceInstanceId && event.sourceSeq > replay.afterSourceSeq
        );
        return { events: structuredClone(replayed), highestContiguousSourceSeq: highestContiguous(replayed) };
      },
      completeRun,
    };

    const completed = await executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      resolveMissingResult,
    });

    expect(resolveMissingResult).toHaveBeenCalledWith({ turnId: "turn-waiting", terminalEvent });
    expect(completed).toMatchObject({
      result: yielded,
      terminal: { runTerminalState: "succeeded", reportedWorkDisposition: "yielded" },
      turnId: "turn-waiting",
    });
    expect(completeRun).toHaveBeenCalledWith(expect.objectContaining({ result: yielded }));
    expect(events.map((event) => event.eventType)).toEqual([
      "turn.completed",
      "run.result.accepted",
      "run.terminal",
    ]);
  });

  it("parks a provider turn immediately after a durable governed wait appears", async () => {
    const yielded: PrpStructuredRunResult = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary: "Waiting for the requested response.",
      completionClaim: {
        contractRevision: "1",
        objectiveSatisfied: false,
        criteria: [
          {
            criterionId: "objective",
            status: "unknown",
            evidenceRefs: ["interaction:pending"],
          },
        ],
        remainingWork: [
          { description: "Resume after the response.", blocksCompletion: true },
        ],
      },
      evidence: [{ ref: "interaction:pending" }],
      verification: [],
      attentionRequests: [],
      artifacts: [],
      continuation: {
        kind: "response_wake",
        summary: "Resume from the answer.",
        idempotencyKey: "interaction-response:pending",
      },
    };
    const itemCompleted: PrpEvent = {
      ...controlEvent(1, "item.completed", {
        kind: "dynamicToolCall",
        item: { id: "ask-1", name: "ask_user_questions" },
      }),
      sourceEventId: "provider-recovery:1",
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      turnId: "turn-waiting",
    };
    const turnInterrupted: PrpEvent = {
      ...controlEvent(2, "turn.interrupted", { reason: "governed_wait" }),
      sourceEventId: "provider-recovery:2",
      sourceInstanceId: "provider-recovery",
      sourceKind: "provider",
      turnId: "turn-waiting",
    };
    let releaseCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      releaseCancelled = resolve;
    });
    const cancel = vi.fn(async () => releaseCancelled());
    const events: PrpEvent[] = [];
    const completeRun = vi.fn(async () => undefined);
    const session: NativeSession = {
      identity: () => identity,
      async capabilities() {
        return {
          resume: false,
          typedEvents: true,
          steering: false,
          interruption: true,
          structuredResult: true,
        };
      },
      async *events() {
        yield itemCompleted;
        await cancelled;
        yield turnInterrupted;
      },
      async startTurn() {
        return { turnId: "turn-waiting" };
      },
      cancel,
      async result() {
        return null;
      },
      async snapshot() {
        return {
          backendKind: "mock",
          sessionId: identity.sessionId,
          identity,
          providerSessionId: "provider-waiting",
          cursor: "2",
          activeTurnId: "turn-waiting",
          pendingRuntimeRequests: [],
          lineage: [],
        };
      },
      async close() {},
    };
    const backend: NativeSessionBackend = {
      async descriptor() {
        return {
          kind: "mock",
          name: "governed-wait-backend",
          version: "1",
          capabilities: {
            resume: false,
            typedEvents: true,
            steering: false,
            interruption: true,
            structuredResult: true,
          },
        };
      },
      async openSession() {
        return session;
      },
    };
    const port: ControlPlanePort = {
      async openRun() {},
      async checkpointSession() {},
      async appendEvent(event) {
        events.push(structuredClone(event as PrpEvent));
        return {
          cursor: events.length,
          highestContiguousSourceSeq: highestContiguous(events),
          disposition: "committed",
        };
      },
      async replayEvents(replay) {
        const replayed = events.filter(
          (event) =>
            event.sourceInstanceId === replay.sourceInstanceId &&
            event.sourceSeq > replay.afterSourceSeq,
        );
        return {
          events: structuredClone(replayed),
          highestContiguousSourceSeq: highestContiguous(replayed),
        };
      },
      completeRun,
    };

    const completed = await executeNativeSession({
      input,
      backend,
      controlPlane: port,
      runnerInstanceId: "runner-recovery",
      controlPlaneInstanceId: "control-recovery",
      resolveGovernedWait: async ({ event }) =>
        event.eventType === "item.completed" ? yielded : null,
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(completed).toMatchObject({
      result: yielded,
      terminal: {
        turnTerminalState: "completed",
        runTerminalState: "succeeded",
        reportedWorkDisposition: "yielded",
      },
    });
    expect(events.map((event) => event.eventType)).toEqual([
      "item.completed",
      "turn.interrupted",
      "run.result.accepted",
      "run.terminal",
    ]);
  });
});
