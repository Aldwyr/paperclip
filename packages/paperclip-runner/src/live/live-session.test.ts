import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
} from "../drivers/codex/app-server-transport.js";
import {
  InMemoryCapabilityLiveSessionStore,
  CapabilityLiveSessionService,
  reconcileCapabilityLiveUsage,
  type CapabilityLiveTransportFactory,
} from "./live-session.js";
import { DurableCapabilityLiveSessionStore } from "./durable-live-session-store.js";
import { defaultCapabilityRunnerdBinary } from "./runnerd-codex-transport.js";

class AsyncNotifications implements AsyncIterable<CodexRpcNotification> {
  #values: CodexRpcNotification[] = [];
  #waiters: Array<(value: IteratorResult<CodexRpcNotification>) => void> = [];
  #closed = false;

  push(value: CodexRpcNotification): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexRpcNotification> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) return { value, done: false };
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

interface FakeProviderState {
  threadId: string;
  providerSessionId: string;
  nextTurn: number;
  lastToolResult: string;
  transports: FakeCapabilityCodexTransport[];
  turns: Map<string, string>;
  holdAfterTool: boolean;
}

class FakeCapabilityCodexTransport implements CodexAppServerTransport {
  readonly notificationsQueue = new AsyncNotifications();
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  #handler: CodexServerRequestHandler = async () => ({});
  #closed = false;
  #activeTurnId: string | null = null;

  constructor(
    readonly state: FakeProviderState,
    readonly onClose: () => void = () => undefined,
  ) {
    state.transports.push(this);
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.requests.push({ method, params: structuredClone(params) });
    if (method === "initialize") return { user: { sessionId: this.state.providerSessionId } };
    if (method === "thread/start") {
      expect(Array.isArray(params.dynamicTools)).toBe(true);
      return {
        model: "gpt-eval-test",
        modelProvider: "openai",
        thread: { id: this.state.threadId, sessionId: this.state.providerSessionId },
      };
    }
    if (method === "thread/read") {
      return {
        thread: {
          id: this.state.threadId,
          sessionId: this.state.providerSessionId,
          turns: [...this.state.turns].map(([id, status]) => ({ id, status })),
        },
      };
    }
    if (method === "thread/resume") {
      return {
        model: "gpt-eval-test",
        modelProvider: "openai",
        thread: { id: this.state.threadId, sessionId: this.state.providerSessionId },
      };
    }
    if (method === "turn/start") {
      const turnId = `turn-${++this.state.nextTurn}`;
      this.#activeTurnId = turnId;
      this.state.turns.set(turnId, "inProgress");
      const input = Array.isArray(params.input) ? params.input[0] as Record<string, unknown> : {};
      const message = String(input.text ?? "");
      void this.#runTurn(turnId, message);
      return { turn: { id: turnId, status: "inProgress" } };
    }
    if (method === "turn/interrupt") {
      const turnId = String(params.turnId);
      this.state.turns.set(turnId, "interrupted");
      this.notificationsQueue.push({
        method: "turn/completed",
        params: { threadId: this.state.threadId, turn: { id: turnId, status: "interrupted" } },
      });
      this.#activeTurnId = null;
      return {};
    }
    throw new Error(`unsupported fake Codex method ${method}`);
  }

  notify(): void {}

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.notificationsQueue;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.#handler = handler;
  }

  invokeServerRequest(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    return this.#handler(request);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.notificationsQueue.close();
    this.onClose();
  }

  processInfo() {
    return {
      pid: 4100 + this.state.transports.indexOf(this),
      processGroupId: 4100 + this.state.transports.indexOf(this),
      startedAt: "2026-08-01T00:00:00.000Z",
      exited: this.#closed,
      exitCode: this.#closed ? 0 : null,
      signal: null,
    };
  }

  async #runTurn(turnId: string, message: string): Promise<void> {
    await Promise.resolve();
    this.notificationsQueue.push({
      method: "turn/started",
      params: { threadId: this.state.threadId, turn: { id: turnId, status: "inProgress" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let assistantText: string;
    if (message.includes("progress")) {
      const idempotencyKey = message.includes("idempotent")
        ? "progress-governed-once"
        : `progress-${turnId}`;
      const result = await this.#toolCall({
        id: `request-${turnId}`,
        method: "item/tool/call",
        params: {
          threadId: this.state.threadId,
          turnId,
          callId: `call-${turnId}`,
          tool: "report_progress",
          arguments: {
            idempotencyKey,
            body: "Progress persisted through the live Codex tool loop.",
          },
        },
      });
      this.state.lastToolResult = String((result.contentItems as Array<Record<string, unknown>>)[0]?.text);
      if (this.state.holdAfterTool) await new Promise<never>(() => undefined);
      assistantText = `The typed result changed my response: ${this.state.lastToolResult}`;
    } else if (message.includes("semantic-interaction-result")) {
      assistantText = `Resumed the same provider thread with ${message}`;
    } else if (message.includes("question")) {
      const result = await this.#toolCall({
        id: `request-${turnId}`,
        method: "item/tool/call",
        params: {
          threadId: this.state.threadId,
          turnId,
          callId: `call-${turnId}`,
          tool: "request_human_input",
          arguments: {
            idempotencyKey: `question-${turnId}`,
            interactionKind: "questions",
            title: "Choose the mock path",
            prompt: "Which path should the mock agent take?",
            payload: { fields: [{ id: "path", label: "Path" }] },
            continuationPolicy: "wake_assignee",
          },
        },
      });
      this.state.lastToolResult = String((result.contentItems as Array<Record<string, unknown>>)[0]?.text);
      assistantText = "I created a durable question and will use its typed result when resumed.";
    } else if (message.includes("long")) {
      return;
    } else {
      assistantText = `Same thread remembers ${this.state.lastToolResult}`;
    }
    this.notificationsQueue.push({
      method: "item/completed",
      params: {
        threadId: this.state.threadId,
        turnId,
        item: { id: `message-${turnId}`, type: "agentMessage", text: assistantText },
      },
    });
    this.state.turns.set(turnId, "completed");
    this.notificationsQueue.push({
      method: "turn/completed",
      params: { threadId: this.state.threadId, turn: { id: turnId, status: "completed" } },
    });
    this.#activeTurnId = null;
  }

  #toolCall(request: CodexRpcServerRequest): Promise<Record<string, unknown>> {
    return this.#handler(request);
  }
}

function fakeTransportFactory(state: FakeProviderState): CapabilityLiveTransportFactory {
  return (options) => {
    const evidence = {
      runnerPid: 4100 + state.transports.length,
      runnerProcessGroupId: 4100 + state.transports.length,
      codexPid: 5100 + state.transports.length,
      runnerExited: false,
      runnerExitCode: null,
      runnerSignal: null,
      childEnvironmentKeys: ["CODEX_HOME", "HOME", "PATH"],
      diagnostics: ["paperclip-runnerd: capability codex proxy started"],
    };
    const transport = new FakeCapabilityCodexTransport(state, () => {
      evidence.runnerExited = true;
      options.onEvidence?.(evidence);
    });
    options.onEvidence?.(evidence);
    return { transport, evidence: () => ({ ...evidence, runnerExited: transport.processInfo().exited }) };
  };
}

function providerState(): FakeProviderState {
  return {
    threadId: "codex-thread-capability",
    providerSessionId: "codex-provider-capability",
    nextTurn: 0,
    lastToolResult: "nothing yet",
    transports: [],
    turns: new Map(),
    holdAfterTool: false,
  };
}

describe("Capability live runnerd and Codex session", () => {
  it("returns typed mock results to the same multi-turn Codex thread without Paperclip network calls", async () => {
    const state = providerState();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const service = new CapabilityLiveSessionService({ transportFactory: fakeTransportFactory(state) });
    const session = await service.create({
      runId: "run-live-tool-loop",
      sessionId: "session-live-tool-loop",
    });

    const first = await session.sendMessage("Please report progress on this mock issue.");
    const second = await session.sendMessage("What did the prior tool result say?");

    expect(first.assistantText).toContain("stateRevision");
    expect(second.assistantText).toContain("stateRevision");
    expect(first.snapshot.providerThreadId).toBe(second.snapshot.providerThreadId);
    expect(first.snapshot.providerModel).toEqual({ id: "gpt-eval-test", provider: "openai" });
    expect(session.mockState().comments.at(-1)?.body).toBe(
      "Progress persisted through the live Codex tool loop.",
    );
    expect(first.snapshot.evidence.some((entry) => entry.kind === "tool_call")).toBe(true);
    expect(first.snapshot.evidence.some((entry) => entry.kind === "tool_result")).toBe(true);
    expect(first.snapshot.networkEvidence).toEqual({
      realPaperclipRequests: 0,
      childPaperclipEnvironmentKeys: [],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    await service.shutdown(session.id);
  });

  it("restores transcript, mock state, and pending interactions before resuming the same Codex thread", async () => {
    const state = providerState();
    const store = new InMemoryCapabilityLiveSessionStore();
    const firstService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const first = await firstService.create({
      runId: "run-live-resume",
      sessionId: "session-live-resume",
      capabilities: ["control_plane:interactions"],
    });
    await first.sendMessage("Ask one structured question.");
    const pending = first.pendingInteractions()[0]!;

    const resumedService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const resumed = await resumedService.restore(first.id);
    expect(resumed.snapshot().providerThreadId).toBe("codex-thread-capability");
    expect(resumed.pendingInteractions()).toHaveLength(1);
    expect(resumed.snapshot().transcript).toEqual(first.snapshot().transcript);

    const continuation = await resumed.resolveInteraction({
      interactionId: pending.id,
      outcome: "answered",
      result: { path: "safe" },
    });
    expect(continuation.assistantText).toContain("semantic-interaction-result");
    expect(resumed.pendingInteractions()).toHaveLength(0);
    expect(resumed.mockState().interactions[0]?.result).toEqual({ path: "safe" });
    expect(state.transports[1]?.requests.map((entry) => entry.method)).toContain("thread/resume");
    await resumedService.shutdown(resumed.id);
    await firstService.shutdown(first.id);
  });

  it("stops active work and reset rotates authority while restoring clean mock state", async () => {
    const state = providerState();
    const store = new InMemoryCapabilityLiveSessionStore();
    const service = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const session = await service.create({
      runId: "run-live-reset",
      sessionId: "session-live-reset",
    });
    const longTurn = session.sendMessage("Start a long turn.");
    await new Promise((resolve) => setTimeout(resolve, 1));
    await session.interrupt("bounded test interrupt");
    await expect(longTurn).resolves.toMatchObject({ status: "interrupted" });
    await session.sendMessage("Please report progress before reset.");

    const replacement = await service.reset(session.id);
    expect(replacement.id).not.toBe(session.id);
    expect(replacement.snapshot().authority.runId).not.toBe("run-live-reset");
    expect(replacement.mockState().comments).toHaveLength(0);
    expect(replacement.snapshot().authority.active).toBe(true);
    expect(session.snapshot().authority.active).toBe(false);
    expect((await store.load(session.id))).toBeNull();
    expect(state.transports[0]?.processInfo().exited).toBe(true);
    const stopped = await service.stop(replacement.id, "bounded test stop");
    expect(stopped.authority.active).toBe(false);
    expect(stopped.process?.runnerExited).toBe(true);
    expect((await store.load(replacement.id))?.status).toBe("closed");
  });

  it("durably resumes a distinct attempt, preserves partial usage, and deduplicates the semantic effect", async () => {
    const state = providerState();
    const directory = await mkdtemp(join(tmpdir(), "capability-live-durable-"));
    const binding = {
      sessionId: "session-governed-resume",
      runId: "run-governed-resume",
      companyId: "company-1",
      actorId: "actor-1",
      taskId: "task-1",
    };
    const firstStore = new DurableCapabilityLiveSessionStore({ directory, binding });
    const firstService = new CapabilityLiveSessionService({
      store: firstStore,
      transportFactory: fakeTransportFactory(state),
    });
    const first = await firstService.create({
      ...binding,
      attemptId: "attempt-killed",
      turnTimeoutMs: 500,
    });
    state.holdAfterTool = true;
    const killedTurn = first.sendMessage("Apply idempotent progress once.");
    await vi.waitFor(async () => {
      expect((await firstStore.load(binding.sessionId))?.mockState).toContain(
        "Progress persisted through the live Codex tool loop.",
      );
    });
    await expect(first.recordUsage({
      receiptId: "provider-response-1",
      providerResponseId: "response-1",
      turnId: "turn-1",
      providerCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      reasoningTokens: 5,
      costNanodollars: 1_500,
    })).resolves.toBe("committed");
    await state.transports[0]?.close();
    await expect(killedTurn).rejects.toThrow("timed out");

    // A new service models worker termination: it owns no in-memory session.
    const resumedService = new CapabilityLiveSessionService({
      store: new DurableCapabilityLiveSessionStore({ directory, binding }),
      transportFactory: fakeTransportFactory(state),
    });
    const resumed = await resumedService.resume({
      sessionId: binding.sessionId,
      attemptId: "attempt-resumed",
      resumeOf: "attempt-killed",
    });
    expect(resumed.snapshot().providerThreadId).toBe(state.threadId);
    expect(resumed.snapshot().attempts).toMatchObject([
      { attemptId: "attempt-killed", status: "terminated", failureCode: "worker_terminated" },
      { attemptId: "attempt-resumed", resumeOf: "attempt-killed", status: "running" },
    ]);

    await expect(resumed.reconcileActiveTurn()).resolves.toMatchObject({
      turnId: "turn-1",
      status: "interrupted",
    });
    state.holdAfterTool = false;

    const duplicate = await resumed.sendMessage("Apply idempotent progress once.");
    expect(duplicate.assistantText).toContain('"disposition":"duplicate"');
    expect(resumed.mockState().comments).toHaveLength(1);
    await expect(resumed.recordUsage({
      receiptId: "provider-response-1",
      providerResponseId: "response-1",
      turnId: "turn-1",
      providerCalls: 1,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      reasoningTokens: 5,
      costNanodollars: 1_500,
    })).resolves.toBe("duplicate");
    await resumed.recordUsage({
      receiptId: "provider-response-2",
      providerResponseId: "response-2",
      providerCalls: 1,
      inputTokens: 80,
      outputTokens: 10,
      costNanodollars: 1_000,
    });
    await resumed.completeAttempt("succeeded");

    const final = await firstStore.load(binding.sessionId);
    expect(final?.attempts).toMatchObject([
      { attemptId: "attempt-killed", status: "terminated" },
      { attemptId: "attempt-resumed", status: "succeeded" },
    ]);
    expect(final?.usageLedger).toHaveLength(2);
    expect(final && reconcileCapabilityLiveUsage(final)).toEqual({
      providerCalls: 2,
      inputTokens: 180,
      outputTokens: 30,
      cachedInputTokens: 40,
      reasoningTokens: 5,
      costNanodollars: 2_500,
    });
  });

  it("replays only a durable duplicate after restore reconciles the provider turn as interrupted", async () => {
    const state = providerState();
    const store = new InMemoryCapabilityLiveSessionStore();
    const firstService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const first = await firstService.create({
      runId: "run-terminal-replay",
      sessionId: "session-terminal-replay",
      attemptId: "attempt-terminal-killed",
      turnTimeoutMs: 50,
    });
    state.holdAfterTool = true;
    const killedTurn = first.sendMessage("Apply idempotent progress once.").then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(async () => {
      expect((await store.load(first.id))?.mockState).toContain("progress-governed-once");
    });
    await state.transports[0]!.close();
    await expect(killedTurn).resolves.toMatchObject({ message: expect.stringContaining("timed out") });
    state.turns.set("turn-1", "interrupted");

    const resumedService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    const resumed = await resumedService.resume({
      sessionId: first.id,
      attemptId: "attempt-terminal-resumed",
      resumeOf: "attempt-terminal-killed",
    });
    expect(resumed.snapshot()).toMatchObject({
      activeTurnId: null,
      providerThreadId: state.threadId,
      terminalTurns: [
        {
          turnId: "turn-1",
          status: "interrupted",
          reconciledByAttemptId: "attempt-terminal-resumed",
        },
      ],
    });

    const replay = await state.transports[1]!.invokeServerRequest({
      id: "request-turn-1:deterministic-resume-replay",
      method: "item/tool/call",
      params: {
        threadId: state.threadId,
        turnId: "turn-1",
        callId: "call-turn-1:deterministic-resume-replay",
        tool: "report_progress",
        arguments: {
          idempotencyKey: "progress-governed-once",
          body: "Progress persisted through the live Codex tool loop.",
        },
      },
    });
    expect(replay.success).toBe(true);
    expect(String((replay.contentItems as Array<Record<string, unknown>>)[0]?.text)).toContain(
      '\"disposition\":\"duplicate\"',
    );
    expect(resumed.mockState().comments).toHaveLength(1);
    expect(resumed.mockState().idempotency).toHaveLength(1);
    const replayedSnapshot = resumed.snapshot();
    expect(replayedSnapshot.terminalTurns).toEqual([
      expect.objectContaining({ turnId: "turn-1", status: "interrupted" }),
      expect.objectContaining({
        turnId: "turn-1:durable-duplicate-replay",
        status: "completed",
        reconciledByAttemptId: "attempt-terminal-resumed",
      }),
    ]);
    expect(replayedSnapshot.evidence.filter((entry) => entry.kind === "tool_result")).toHaveLength(2);
    const receipts = replayedSnapshot.evidence.filter((entry) => entry.kind === "tool_result");
    expect(receipts.map((entry) => (entry.data.result as Record<string, unknown>).ok)).toEqual([true, true]);
    expect(receipts.map((entry) => (
      ((entry.data.result as Record<string, unknown>).result as Record<string, unknown>).disposition
    ))).toEqual(["applied", "duplicate"]);
    expect(receipts.every((entry) => (
      Number(entry.data.beforeRevision) <= Number(entry.data.afterRevision)
    ))).toBe(true);
    expect(receipts.every((entry) => (
      Number((entry.data.result as Record<string, unknown>).stateRevision)
        === Number(entry.data.afterRevision)
    ))).toBe(true);
    expect(receipts.at(-1)?.data.afterRevision).toBe(resumed.mockState().revision);
    expect(state.transports[1]!.requests.some((request) => request.method === "turn/start")).toBe(false);

    const rejected = await state.transports[1]!.invokeServerRequest({
      id: "request-turn-1:new-key",
      method: "item/tool/call",
      params: {
        threadId: state.threadId,
        turnId: "turn-1",
        callId: "call-turn-1:new-key",
        tool: "report_progress",
        arguments: {
          idempotencyKey: "progress-new-effect",
          body: "This effect must not be applied.",
        },
      },
    });
    expect(rejected.success).toBe(false);
    expect(resumed.mockState().comments).toHaveLength(1);
    expect(resumed.mockState().idempotency).toHaveLength(1);
    expect(resumed.snapshot().evidence.filter((entry) => entry.kind === "tool_result")).toHaveLength(2);
    await resumed.completeAttempt("succeeded");
    expect((await store.load(resumed.id))?.attempts).toMatchObject([
      { attemptId: "attempt-terminal-killed", status: "terminated" },
      { attemptId: "attempt-terminal-resumed", status: "succeeded" },
    ]);
    await resumedService.shutdown(resumed.id, "terminal replay test complete");
  });

  it("fails closed for missing, corrupt, mismatched, and provider-drifted checkpoints", async () => {
    const directory = await mkdtemp(join(tmpdir(), "capability-live-fail-closed-"));
    const binding = {
      sessionId: "session-fail-closed",
      runId: "run-fail-closed",
      companyId: "company-1",
      actorId: "actor-1",
      taskId: "task-1",
    };
    const missingService = new CapabilityLiveSessionService({
      store: new DurableCapabilityLiveSessionStore({ directory, binding }),
      transportFactory: fakeTransportFactory(providerState()),
    });
    await expect(missingService.resume({
      sessionId: binding.sessionId,
      attemptId: "attempt-missing-resume",
      resumeOf: "attempt-missing",
    })).rejects.toThrow("capability_live_resume_checkpoint_missing");

    const state = providerState();
    const store = new DurableCapabilityLiveSessionStore({ directory, binding });
    const firstService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    await firstService.create({ ...binding, attemptId: "attempt-original" });
    const mismatched = new DurableCapabilityLiveSessionStore({
      directory,
      binding: { ...binding, taskId: "task-other" },
    });
    await expect(mismatched.load(binding.sessionId)).rejects.toThrow(
      "capability_live_checkpoint_binding_mismatch",
    );

    state.providerSessionId = "codex-provider-drifted";
    const driftedService = new CapabilityLiveSessionService({
      store,
      transportFactory: fakeTransportFactory(state),
    });
    await expect(driftedService.resume({
      sessionId: binding.sessionId,
      attemptId: "attempt-drifted",
      resumeOf: "attempt-original",
    })).rejects.toThrow("capability_live_provider_session_drift");
    expect((await store.load(binding.sessionId))?.attempts?.at(-1)).toMatchObject({
      attemptId: "attempt-drifted",
      status: "failed",
      failureCode: "provider_recovery_failed",
    });

    const checkpointFile = join(directory, `${createHash("sha256").update(binding.sessionId).digest("hex")}.json`);
    const checkpoint = await readFile(checkpointFile, "utf8");
    await writeFile(checkpointFile, checkpoint.replace('"snapshotSha256":"', '"snapshotSha256":"corrupt-'));
    await expect(store.load(binding.sessionId)).rejects.toThrow("capability_live_checkpoint_corrupt");
  });

  it.skipIf(process.platform === "win32" || !existsSync(defaultCapabilityRunnerdBinary()))(
    "terminates real runnerd after a durable receipt and resumes its exact provider thread",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "capability-live-real-runnerd-"));
      const providerStatePath = join(directory, "provider-state.json");
      const fixture = fileURLToPath(new URL("../../test/fixtures/fake-durable-codex-app-server.mjs", import.meta.url));
      const binding = {
        sessionId: "session-real-runnerd-resume",
        runId: "run-real-runnerd-resume",
        companyId: "company-1",
        actorId: "actor-1",
        taskId: "task-1",
      };
      const store = new DurableCapabilityLiveSessionStore({ directory, binding });
      const transportOptions = {
        codexCommand: process.execPath,
        codexArgs: [fixture, providerStatePath],
        closeGraceMs: 100,
      };
      const firstService = new CapabilityLiveSessionService({ store, transportOptions });
      const first = await firstService.create({
        ...binding,
        attemptId: "attempt-real-killed",
        turnTimeoutMs: 2_000,
      });
      const killedTurn = first.sendMessage("Apply the governed idempotent effect.");
      await vi.waitFor(async () => {
        const checkpoint = await store.load(binding.sessionId);
        expect(checkpoint?.mockState).toContain("One durable governed effect.");
        expect(checkpoint?.activeTurnId).toBe("turn-1");
        expect(checkpoint?.process?.runnerProcessGroupId).not.toBeNull();
        expect(checkpoint?.process?.codexPid).not.toBeNull();
      });
      await first.recordUsage({
        receiptId: "real-response-1",
        providerResponseId: "fixture-response-1",
        turnId: "turn-1",
        providerCalls: 1,
        inputTokens: 10,
        outputTokens: 2,
        costNanodollars: 100,
      });
      const killedCheckpoint = await store.load(binding.sessionId);
      const processGroupId = killedCheckpoint?.process?.runnerProcessGroupId;
      expect(processGroupId).toBeTypeOf("number");
      process.kill(-processGroupId!, "SIGKILL");
      await expect(killedTurn).rejects.toThrow();

      const resumedService = new CapabilityLiveSessionService({
        store: new DurableCapabilityLiveSessionStore({ directory, binding }),
        transportOptions,
      });
      const resumed = await resumedService.resume({
        sessionId: binding.sessionId,
        attemptId: "attempt-real-resumed",
        resumeOf: "attempt-real-killed",
      });
      expect(resumed.snapshot().providerThreadId).toBe("thread-durable-runnerd");
      await expect(resumed.reconcileActiveTurn()).resolves.toMatchObject({ status: "interrupted" });
      const duplicate = await resumed.sendMessage("Apply the governed idempotent effect again.");
      expect(duplicate.assistantText).toContain("duplicate");
      expect(resumed.mockState().comments).toHaveLength(1);
      await resumed.completeAttempt("succeeded");
      const final = await store.load(binding.sessionId);
      expect(final?.attempts).toMatchObject([
        { attemptId: "attempt-real-killed", status: "terminated" },
        { attemptId: "attempt-real-resumed", status: "succeeded", resumeOf: "attempt-real-killed" },
      ]);
      expect(final?.usageLedger).toHaveLength(1);
      expect(final?.terminalTurns).toEqual(expect.arrayContaining([
        expect.objectContaining({ turnId: "turn-1", status: "interrupted" }),
        expect.objectContaining({ turnId: "turn-2", status: "completed" }),
      ]));
      await resumedService.shutdown(resumed.id, "test complete");
    },
    15_000,
  );
});
