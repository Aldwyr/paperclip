import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";

import {
  CODEX_BLOCK_TOOL_NAME,
  CODEX_COMPLETION_TOOL_NAME,
  CODEX_SKILLLESS_BASE_INSTRUCTIONS,
  createCodexTaskEnvelope,
  type CodexTaskEnvelope,
} from "../../contracts/codex.js";
import type {
  HarnessDriver,
  HarnessDriverConfigValidation,
  HarnessDriverDescriptor,
  HarnessSession,
  HarnessSessionRecoveryResult,
  HarnessTranscriptSnapshot,
  OpenHarnessSessionInput,
  PersistedHarnessSession,
} from "../../contracts/harness-driver.js";
import type { NativeSessionCapabilities, NativeUserMessage } from "../../contracts/types.js";
import type { PrpEvent, PrpStructuredRunResult } from "../../protocol/replay-contract.js";
import { validatePrpStructuredRunResult } from "../../protocol/replay-contract.js";
import { paperclipWorkspaceFileReferencesFromText } from "../../live/workspace-file-reference.js";
import { canonicalOpenCodeMcpToolName, startOpenCodeMcpBridge, type OpenCodeMcpBridge } from "./mcp-bridge.js";

export const OPENCODE_SERVER_DRIVER_KIND = "opencode_server" as const;
export const QUALIFIED_OPENCODE_VERSION = "1.18.17" as const;
export const QUALIFIED_OPENCODE_MODEL = "openrouter/deepseek/deepseek-v4-flash-0731" as const;

type DynamicToolHandler = (call: {
  tool: string;
  callId: string;
  threadId: string;
  turnId: string;
  arguments: unknown;
}) => Promise<unknown>;

export interface OpenCodeServerDriverOptions {
  model: string;
  taskEnvelope?: CodexTaskEnvelope;
  runnerInstanceId?: string;
  command?: string;
  runtimeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: DynamicToolHandler;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  onDiagnostic?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

interface OpenCodeRuntime {
  baseUrl: string;
  authHeader: string;
  version: string;
  process: ChildProcess;
  bridge: OpenCodeMcpBridge;
  sensitiveValues: readonly string[];
  close(): Promise<void>;
}

const CAPABILITIES: NativeSessionCapabilities = {
  resume: true,
  typedEvents: true,
  steering: false,
  interruption: true,
  structuredResult: true,
  read: true,
  reconciliation: true,
  usage: true,
  dynamicTools: true,
  runtimeRequestResolution: false,
  goals: false,
  threadLineage: false,
  unsupported: ["steering", "runtimeRequestResolution", "goals", "threadLineage"],
};

export class OpenCodeServerDriver implements HarnessDriver {
  readonly #options: OpenCodeServerDriverOptions;

  constructor(options: OpenCodeServerDriverOptions) {
    this.#options = options;
  }

  async descriptor(): Promise<HarnessDriverDescriptor> {
    return {
      kind: OPENCODE_SERVER_DRIVER_KIND,
      displayName: "OpenCode server",
      version: QUALIFIED_OPENCODE_VERSION,
      protocolVersion: "http+sse/v1",
      capabilities: structuredClone(CAPABILITIES),
    };
  }

  async validateConfig(config: unknown): Promise<HarnessDriverConfigValidation> {
    const candidate = isRecord(config) ? config : {};
    const issues = [];
    const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
    if (!validModel(model)) issues.push({ path: "model", code: "invalid_model", message: "OpenCode model must use provider/model form." });
    const command = typeof candidate.command === "string" ? candidate.command.trim() : "opencode";
    if (!command) issues.push({ path: "command", code: "invalid_command", message: "OpenCode command cannot be empty." });
    return issues.length === 0
      ? { ok: true, config: { model, command }, issues: [] }
      : { ok: false, config: null, issues };
  }

  async openSession(input: OpenHarnessSessionInput): Promise<HarnessSession> {
    return this.#open(input, null);
  }

  async recoverSession(snapshot: PersistedHarnessSession): Promise<HarnessSessionRecoveryResult> {
    if (
      snapshot.driverKind !== OPENCODE_SERVER_DRIVER_KIND
      || !snapshot.runId
      || !snapshot.normalizedSessionId
      || !snapshot.driverSessionId
    ) return { recovered: false, reason: "persisted OpenCode session identity is incomplete" };
    try {
      const session = await this.#open({
        runId: snapshot.runId,
        normalizedSessionId: snapshot.normalizedSessionId,
        workingDirectory: await this.#readWorkspace(snapshot.normalizedSessionId),
      }, snapshot);
      return { recovered: true, session };
    } catch (error) {
      return { recovered: false, reason: redact(String(error), [this.#options.environment?.OPENROUTER_API_KEY]) };
    }
  }

  async #readWorkspace(normalizedSessionId: string): Promise<string> {
    const raw = await readFile(join(sessionRoot(this.#options.runtimeDirectory, normalizedSessionId), "workspace"), "utf8");
    return raw.trim();
  }

  async #open(input: OpenHarnessSessionInput, snapshot: PersistedHarnessSession | null): Promise<HarnessSession> {
    const cwd = validateWorkspace(input.workingDirectory);
    const root = sessionRoot(this.#options.runtimeDirectory, input.normalizedSessionId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(join(root, "workspace"), `${cwd}\n`, { mode: 0o600 });
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let session: OpenCodeHarnessSession | null = null;
      let runtime: OpenCodeRuntime | null = null;
      try {
        runtime = await startRuntime({
          options: this.#options,
          root,
          cwd,
          dispatch: (call) => {
            if (session === null) throw new Error("OpenCode session is not ready for tool calls");
            return session.dispatchTool(call);
          },
        });
        const fetcher = this.#options.fetch ?? globalThis.fetch;
        let providerSessionId = snapshot?.providerSessionId ?? snapshot?.driverSessionId ?? null;
        if (providerSessionId !== null) {
          const existing = await api(fetcher, runtime, `/session/${encodeURIComponent(providerSessionId)}`);
          if (!isRecord(existing) || text(existing.id) !== providerSessionId) throw new Error("OpenCode resumed a different session");
        } else {
          const created = await api(fetcher, runtime, "/session", {
            method: "POST",
            body: JSON.stringify({ title: `Paperclip ${input.runId}` }),
          });
          providerSessionId = text(record(created).id);
          if (!providerSessionId) throw new Error("OpenCode session creation omitted its id");
        }
        session = new OpenCodeHarnessSession({
          runtime,
          fetcher,
          runId: input.runId,
          normalizedSessionId: input.normalizedSessionId,
          providerSessionId,
          workingDirectory: cwd,
          runnerInstanceId: this.#options.runnerInstanceId ?? `paperclip-opencode-${input.runId}`,
          model: this.#options.model,
          taskEnvelope: this.#options.taskEnvelope ?? createCodexTaskEnvelope({ objective: "Complete the supplied task." }),
          dynamicToolHandler: this.#options.dynamicToolHandler,
          snapshot,
          now: this.#options.now ?? (() => new Date()),
        });
        session.startEventPump();
        return session;
      } catch (error) {
        lastError = error;
        await runtime?.close();
        if (attempt === 3 || !retryableOpenCodeStartupError(error)) throw error;
        this.#options.onDiagnostic?.(`OpenCode session startup attempt ${attempt} failed; retrying.`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100 * attempt));
      }
    }
    throw lastError;
  }
}

class OpenCodeHarnessSession implements HarnessSession {
  readonly #runtime: OpenCodeRuntime;
  readonly #fetch: typeof globalThis.fetch;
  #runId: string;
  readonly #normalizedSessionId: string;
  readonly #providerSessionId: string;
  readonly #workingDirectory: string;
  readonly #runnerInstanceId: string;
  readonly #model: string;
  readonly #taskEnvelope: CodexTaskEnvelope;
  readonly #dynamicToolHandler?: DynamicToolHandler;
  readonly #now: () => Date;
  readonly #events = new AsyncQueue<PrpEvent>();
  readonly #transcript: PrpEvent[] = [];
  readonly #terminalTurns = new Map<string, string>();
  readonly #seenProviderEvents = new Set<string>();
  readonly #messageRoles = new Map<string, string>();
  readonly #pendingMessageParts = new Map<string, Array<Record<string, unknown>>>();
  readonly #partText = new Map<string, string>();
  readonly #workspaceChangesByTurn = new Map<string, Record<string, unknown>>();
  readonly #emittedFileReferences = new Set<string>();
  #sourceSequence: number;
  #activeTurnId: string | null;
  #result: PrpStructuredRunResult | null;
  #resultFingerprint: string | null;
  #resultCallId: string | null;
  #resultTurnId: string | null;
  #usage: Record<string, unknown> | null = null;
  #closed = false;
  #abort = new AbortController();

  constructor(input: {
    runtime: OpenCodeRuntime;
    fetcher: typeof globalThis.fetch;
    runId: string;
    normalizedSessionId: string;
    providerSessionId: string;
    workingDirectory: string;
    runnerInstanceId: string;
    model: string;
    taskEnvelope: CodexTaskEnvelope;
    dynamicToolHandler?: DynamicToolHandler;
    snapshot: PersistedHarnessSession | null;
    now: () => Date;
  }) {
    this.#runtime = input.runtime;
    this.#fetch = input.fetcher;
    this.#runId = input.runId;
    this.#sourceSequence = 0;
    this.#normalizedSessionId = input.normalizedSessionId;
    this.#providerSessionId = input.providerSessionId;
    this.#workingDirectory = input.workingDirectory;
    this.#runnerInstanceId = input.runnerInstanceId;
    this.#model = input.model;
    this.#taskEnvelope = input.taskEnvelope;
    this.#dynamicToolHandler = input.dynamicToolHandler;
    this.#now = input.now;
    this.#sourceSequence = input.snapshot?.lastSourceSequence ?? 0;
    this.#activeTurnId = input.snapshot?.activeTurnId ?? null;
    const restored = input.snapshot?.semanticResult ?? null;
    this.#result = restored?.result ?? null;
    this.#resultFingerprint = restored?.fingerprint ?? null;
    this.#resultCallId = restored?.callId ?? null;
    this.#resultTurnId = restored?.turnId ?? null;
    for (const terminal of input.snapshot?.terminalTurns ?? []) this.#terminalTurns.set(terminal.turnId, terminal.fingerprint);
    this.#emit(input.snapshot ? "session.resumed" : "session.started", {
      driverSessionId: input.providerSessionId,
      providerSessionId: input.providerSessionId,
      context: {
        protocolVersion: "http+sse/v1",
        opencodeVersion: input.runtime.version,
        model: input.model,
        modelProvider: input.model.split("/", 1)[0],
        workingDirectory: input.workingDirectory,
        environmentKeys: sanitizedEnvironmentKeys(),
      },
    });
    this.#emit("item.completed", {
      kind: "model",
      text: `${input.model} (OpenCode ${input.runtime.version})`,
      model: { name: input.model, provider: input.model.split("/", 1)[0], opencodeVersion: input.runtime.version },
    }, { itemId: `${input.providerSessionId}:model` });
  }

  ids() {
    return { driverSessionId: this.#providerSessionId, providerSessionId: this.#providerSessionId, displayId: this.#providerSessionId };
  }

  attachRun(input: { runId: string }): void {
    if (this.#activeTurnId !== null) throw new Error("opencode_run_attach_busy");
    if (!input.runId) throw new Error("opencode_run_attach_invalid");
    this.#runId = input.runId;
    this.#result = null;
    this.#resultFingerprint = null;
    this.#resultCallId = null;
    this.#resultTurnId = null;
    this.#terminalTurns.clear();
    this.#emit("run.attached", { runId: input.runId, sameSession: true });
  }

  events(): AsyncIterable<PrpEvent> { return this.#events; }

  startEventPump(): void { void this.#pumpEvents(); }

  async startTurn(input: { message: NativeUserMessage }): Promise<{ turnId: string }> {
    if (this.#activeTurnId !== null) throw new Error("OpenCode session already has an active turn");
    const turnId = `turn-${randomBytes(12).toString("hex")}`;
    this.#activeTurnId = turnId;
    this.#emit("turn.submitted", { envelopeSchema: this.#taskEnvelope.schema, text: input.message.text });
    this.#emit("turn.accepted", { turnId }, { turnId });
    this.#emit("turn.started", { status: "inProgress" }, { turnId });
    const [providerID, ...modelParts] = this.#model.split("/");
    const modelID = modelParts.join("/");
    const prompt = JSON.stringify({ task: this.#taskEnvelope, message: input.message.text });
    await api(this.#fetch, this.#runtime, `/session/${encodeURIComponent(this.#providerSessionId)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({
        // OpenCode 1.18's PromptPayload carries the provider and model at the
        // top level.  Older examples used a nested `model` object; 1.18
        // silently ignores that shape and falls back to the configured model,
        // which can turn `openrouter/deepseek/...` into a duplicated provider
        // lookup. Keep Paperclip's persisted provider/model form, but adapt it
        // at this HTTP boundary.
        providerID,
        modelID,
        system: CODEX_SKILLLESS_BASE_INSTRUCTIONS,
        parts: [{ type: "text", text: prompt }],
      }),
    });
    return { turnId };
  }

  async interrupt(input: { turnId?: string; reason?: string }): Promise<void> {
    if (input.turnId && this.#activeTurnId && input.turnId !== this.#activeTurnId) throw new Error("stale OpenCode turn");
    await api(this.#fetch, this.#runtime, `/session/${encodeURIComponent(this.#providerSessionId)}/abort`, { method: "POST" });
  }

  async read(): Promise<Record<string, unknown>> {
    const messages = await api(this.#fetch, this.#runtime, `/session/${encodeURIComponent(this.#providerSessionId)}/message`);
    return { sessionId: this.#providerSessionId, messages };
  }

  async reconcile(): Promise<Record<string, unknown>> {
    const status = await api(this.#fetch, this.#runtime, "/session/status");
    return { sessionId: this.#providerSessionId, status: record(status)[this.#providerSessionId] ?? null };
  }

  async usage(): Promise<Record<string, unknown> | null> { return this.#usage === null ? null : structuredClone(this.#usage); }

  async transcript(): Promise<HarnessTranscriptSnapshot> {
    return {
      schema: "paperclip-runner/harness-transcript/v1",
      complete: true,
      eventCount: this.#transcript.length,
      events: structuredClone(this.#transcript),
      omissionReason: null,
    };
  }

  async snapshot(): Promise<PersistedHarnessSession> {
    return {
      driverKind: OPENCODE_SERVER_DRIVER_KIND,
      driverSessionId: this.#providerSessionId,
      providerSessionId: this.#providerSessionId,
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      activeTurnId: this.#activeTurnId,
      semanticResult: this.#result && this.#resultFingerprint && this.#resultTurnId
        ? { result: structuredClone(this.#result), fingerprint: this.#resultFingerprint, callId: this.#resultCallId, turnId: this.#resultTurnId }
        : null,
      terminalTurns: [...this.#terminalTurns].map(([turnId, fingerprint]) => ({ turnId, fingerprint })),
      lastSourceSequence: this.#sourceSequence,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    this.#events.close();
    await this.#runtime.close();
  }

  async dispatchTool(call: { tool: string; callId: string; arguments: unknown }): Promise<unknown> {
    const tool = canonicalOpenCodeMcpToolName(call.tool);
    const turnId = this.#activeTurnId;
    if (turnId === null) throw new Error("OpenCode tool call is not bound to an active turn");
    this.#emit("item.started", {
      kind: "dynamicToolCall",
      item: { type: "tool_call", id: call.callId, name: tool, arguments: call.arguments },
    }, { turnId, itemId: call.callId });
    if (tool === CODEX_COMPLETION_TOOL_NAME || tool === CODEX_BLOCK_TOOL_NAME) {
      const validation = validatePrpStructuredRunResult(call.arguments);
      if (!validation.ok) throw new Error("Invalid semantic result");
      if (
        (tool === CODEX_BLOCK_TOOL_NAME && validation.result.reportedWorkDisposition !== "blocked")
        || (tool === CODEX_COMPLETION_TOOL_NAME && validation.result.reportedWorkDisposition === "blocked")
      ) throw new Error("Semantic result disposition does not match the terminal tool");
      if (validation.result.completionClaim.contractRevision !== this.#taskEnvelope.completionContract.revision) {
        throw new Error("Semantic result completion contract revision does not match");
      }
      const fingerprint = canonicalJson(validation.result);
      if (this.#resultFingerprint && this.#resultFingerprint !== fingerprint) throw new Error("A different semantic result was already committed");
      if (!this.#resultFingerprint) {
        this.#result = structuredClone(validation.result);
        this.#resultFingerprint = fingerprint;
        this.#resultCallId = call.callId;
        this.#resultTurnId = turnId;
        this.#emit("run.result.proposed", validation.result, { turnId, itemId: call.callId });
      }
      this.#emit("item.completed", {
        kind: "dynamicToolCall",
        item: { type: "tool_result", id: call.callId, tool_use_id: call.callId, result: "Semantic completion accepted." },
      }, { turnId, itemId: call.callId });
      return { accepted: true };
    }
    if (!this.#dynamicToolHandler) throw new Error("Unsupported Paperclip operation");
    try {
      const result = await this.#dynamicToolHandler({
        tool,
        callId: call.callId,
        threadId: this.#providerSessionId,
        turnId,
        arguments: call.arguments,
      });
      this.#emit("item.completed", {
        kind: "dynamicToolCall",
        item: { type: "tool_result", id: call.callId, tool_use_id: call.callId, result },
      }, { turnId, itemId: call.callId });
      return result;
    } catch (error) {
      this.#emit("item.completed", {
        kind: "dynamicToolCall",
        item: { type: "tool_result", id: call.callId, tool_use_id: call.callId, error: redact(String(error)), is_error: true },
      }, { turnId, itemId: call.callId });
      throw error;
    }
  }

  async #pumpEvents(): Promise<void> {
    let attempts = 0;
    while (!this.#closed && !this.#abort.signal.aborted) {
      try {
        const response = await this.#fetch(`${this.#runtime.baseUrl}/event`, {
          headers: { Authorization: this.#runtime.authHeader, Accept: "text/event-stream" },
          signal: this.#abort.signal,
        });
        if (!response.ok || !response.body) throw new Error(`OpenCode event stream returned HTTP ${response.status}`);
        for await (const event of parseSse(response.body)) {
          if (this.#closed) return;
          this.#mapProviderEvent(event);
        }
        throw new Error("OpenCode event stream closed before the session became terminal");
      } catch (error) {
        if (this.#closed || this.#abort.signal.aborted) return;
        attempts += 1;
        if (attempts > 3) {
          this.#emit("harness.diagnostic", { code: "opencode_sse_failed", message: redact(String(error), this.#runtime.sensitiveValues) });
          this.#events.fail(error);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50 * attempts));
      }
    }
  }

  #mapProviderEvent(value: unknown): void {
    const event = record(value);
    const properties = record(event.properties);
    const type = text(event.type);
    const eventId = text(event.id, canonicalJson(value));
    if (this.#seenProviderEvents.has(eventId)) return;
    this.#seenProviderEvents.add(eventId);
    if (this.#seenProviderEvents.size > 10_000) this.#seenProviderEvents.delete(this.#seenProviderEvents.values().next().value!);
    const sessionId = text(properties.sessionID, text(record(properties.info).sessionID));
    if (sessionId && sessionId !== this.#providerSessionId) return;
    const turnId = this.#activeTurnId;
    if (type === "message.part.updated" && turnId) {
      const part = record(properties.part);
      const messageId = text(part.messageID, text(part.messageId));
      if (!messageId) return;
      const role = this.#messageRoles.get(messageId);
      if (role === "assistant") this.#emitAssistantPart(part, turnId);
      else if (role === undefined) {
        const pending = this.#pendingMessageParts.get(messageId) ?? [];
        if (pending.length < 100) pending.push(part);
        this.#pendingMessageParts.set(messageId, pending);
      }
      return;
    }
    if (type === "message.updated" && turnId) {
      const info = record(properties.info);
      const messageId = text(info.id, text(info.messageID, text(info.messageId)));
      const role = text(info.role);
      if (messageId && role) {
        this.#messageRoles.set(messageId, role);
        const pending = this.#pendingMessageParts.get(messageId) ?? [];
        this.#pendingMessageParts.delete(messageId);
        if (role === "assistant") for (const part of pending) this.#emitAssistantPart(part, turnId);
      }
      const tokens = record(info.tokens);
      if (Object.keys(tokens).length > 0 || typeof info.cost === "number") {
        this.#usage = bounded({
          ...tokens,
          costUsd: info.cost ?? null,
          model: this.#model,
          provider: this.#model.split("/", 1)[0],
          driverVersion: this.#runtime.version,
        });
        this.#emit("item.completed", { kind: "usage", usage: this.#usage }, { turnId, itemId: `${turnId}:usage` });
      }
      return;
    }
    if ((type === "session.idle" || (type === "session.status" && text(record(properties.status).type) === "idle")) && turnId) {
      const fingerprint = canonicalJson({ status: "completed", semanticResult: this.#resultFingerprint });
      this.#terminalTurns.set(turnId, fingerprint);
      const workspace = this.#workspaceChangesByTurn.get(turnId);
      if (workspace !== undefined) this.#emit("workspace.diff.recorded", { ...workspace, complete: true }, { turnId, itemId: `${turnId}:workspace` });
      this.#emit("turn.completed", { status: "completed" }, { turnId });
      this.#activeTurnId = null;
      this.#events.close();
      return;
    }
    if (type === "session.error" && turnId) {
      this.#emit("turn.failed", { status: "failed", error: bounded(properties.error ?? properties) }, { turnId });
      this.#terminalTurns.set(turnId, canonicalJson({ status: "failed" }));
      this.#activeTurnId = null;
      this.#events.close();
    }
  }

  #emitAssistantPart(part: Record<string, unknown>, turnId: string): void {
    const partId = text(part.id, `${turnId}:part`);
    const partType = text(part.type, "unknown");
    if (partType === "patch") {
      const paths = Array.isArray(part.files) ? part.files : [];
      const files = paths.slice(0, 2_000).flatMap((value): Record<string, unknown>[] => {
        const path = text(value).replaceAll("\\", "/");
        if (!path || path.startsWith("/") || path.split("/").includes("..")) return [];
        return [{ path, operation: "modify", previousPath: null, additions: null, deletions: null, binary: false, diff: null }];
      });
      if (files.length > 0) {
        const previous = this.#workspaceChangesByTurn.get(turnId);
        const payload = {
          schema: "paperclip.workspace.diff.v1",
          changeSetId: `${turnId}:workspace`,
          revision: Number(record(previous).revision ?? 0) + 1,
          source: "harness_reported",
          complete: false,
          files,
          totals: { files: files.length, additions: null, deletions: null },
          patchArtifactRef: null,
        };
        this.#workspaceChangesByTurn.set(turnId, payload);
        this.#emit("workspace.change.updated", payload, { turnId, itemId: `${turnId}:workspace` });
      }
    }
    const content = text(part.text, text(part.output));
    const previous = this.#partText.get(partId) ?? "";
    this.#partText.set(partId, content);
    if (partType === "text" && content.length > 0) {
      for (const reference of paperclipWorkspaceFileReferencesFromText(
        this.#workingDirectory,
        content,
        turnId,
      )) {
        if (this.#emittedFileReferences.has(reference.referenceId)) continue;
        this.#emittedFileReferences.add(reference.referenceId);
        this.#emit("workspace.file.referenced", { ...reference }, { turnId, itemId: reference.referenceId });
      }
    }
    const delta = content.startsWith(previous) ? content.slice(previous.length) : content;
    if (!delta) return;
    this.#emit("item.delta", { kind: partType, text: delta, item: bounded(part) }, { turnId, itemId: partId });
  }

  #emit(eventType: PrpEvent["eventType"], payload: Record<string, unknown>, refs: { turnId?: string; itemId?: string } = {}): void {
    const sourceSeq = ++this.#sourceSequence;
    const event: PrpEvent = {
      schema: "paperclip.prp.event.v1",
      sourceEventId: `${this.#runnerInstanceId}:${this.#runId}:${sourceSeq}`,
      sourceSeq,
      sourceInstanceId: this.#runnerInstanceId,
      sourceKind: "runner",
      runId: this.#runId,
      normalizedSessionId: this.#normalizedSessionId,
      ...(refs.turnId ? { turnId: refs.turnId } : {}),
      ...(refs.itemId ? { itemId: refs.itemId } : {}),
      eventType,
      schemaVersion: 1,
      priority: eventType === "run.result.proposed" ? 0 : 1,
      emittedAt: this.#now().toISOString(),
      payload,
    };
    this.#transcript.push(structuredClone(event));
    this.#events.push(event);
  }
}

async function startRuntime(input: {
  options: OpenCodeServerDriverOptions;
  root: string;
  cwd: string;
  dispatch: (call: { tool: string; callId: string; arguments: unknown }) => Promise<unknown>;
}): Promise<OpenCodeRuntime> {
  const bridge = await startOpenCodeMcpBridge({
    tools: input.options.dynamicTools,
    handler: input.dispatch,
  });
  const port = await reservePort();
  const password = randomBytes(32).toString("base64url");
  const username = "paperclip";
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const configHome = join(input.root, "config");
  const dataHome = join(input.root, "data");
  const cacheHome = join(input.root, "cache");
  const isolatedHome = join(input.root, "home");
  await Promise.all([
    mkdir(join(configHome, "opencode"), { recursive: true, mode: 0o700 }),
    mkdir(dataHome, { recursive: true, mode: 0o700 }),
    mkdir(cacheHome, { recursive: true, mode: 0o700 }),
    mkdir(isolatedHome, { recursive: true, mode: 0o700 }),
  ]);
  const config = {
    $schema: "https://opencode.ai/config.json",
    model: input.options.model,
    small_model: input.options.model,
    share: "disabled",
    instructions: [],
    plugin: [],
    permission: { "*": "allow", external_directory: "deny" },
    mcp: {
      paperclip: {
        type: "remote",
        url: bridge.url,
        enabled: true,
        oauth: false,
        headers: { Authorization: `Bearer ${bridge.secret}` },
        timeout: 30_000,
      },
    },
  };
  await writeFile(join(configHome, "opencode", "opencode.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const environment = sanitizedEnvironment(input.options.environment ?? process.env, {
    HOME: isolatedHome,
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_CACHE_HOME: cacheHome,
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_SERVER_USERNAME: username,
    OPENCODE_SERVER_PASSWORD: password,
  });
  const child = spawn(input.options.command ?? "opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: input.cwd,
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
    detached: globalThis.process.platform !== "win32",
  });
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics = `${diagnostics}${String(chunk)}`.slice(-8_192);
    input.options.onDiagnostic?.(redact(String(chunk), [password, input.options.environment?.OPENROUTER_API_KEY]));
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (child.pid) await input.options.onSpawn?.({
      pid: child.pid,
      processGroupId: globalThis.process.platform === "win32" ? null : child.pid,
      startedAt: new Date().toISOString(),
    });
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(baseUrl, authHeader, input.options.fetch ?? globalThis.fetch, child, diagnostics);
    const version = text(record(health).version);
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("OpenCode health response omitted a semantic version");
    const qualifiedComparison = compareVersion(version, QUALIFIED_OPENCODE_VERSION);
    if (qualifiedComparison < 0) throw new Error(`OpenCode ${version} is older than required ${QUALIFIED_OPENCODE_VERSION}`);
    if (qualifiedComparison > 0) input.options.onDiagnostic?.(`OpenCode ${version} is newer than qualified ${QUALIFIED_OPENCODE_VERSION}.`);
    return {
      baseUrl,
      authHeader,
      version,
      process: child,
      bridge,
      sensitiveValues: [password, input.options.environment?.OPENROUTER_API_KEY].filter((value): value is string => Boolean(value)),
      close: async () => {
        await bridge.close().catch(() => {});
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          try {
            if (globalThis.process.platform === "win32") child.kill("SIGTERM");
            else globalThis.process.kill(-child.pid, "SIGTERM");
          } catch { child.kill("SIGTERM"); }
        }
        await waitForExit(child, 2_000);
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          try {
            if (globalThis.process.platform === "win32") child.kill("SIGKILL");
            else globalThis.process.kill(-child.pid, "SIGKILL");
          } catch { child.kill("SIGKILL"); }
        }
      },
    };
  } catch (error) {
    await bridge.close().catch(() => {});
    child.kill("SIGKILL");
    throw error;
  }
}

async function api(fetcher: typeof globalThis.fetch, runtime: OpenCodeRuntime, path: string, init: RequestInit = {}): Promise<unknown> {
  const timeout = AbortSignal.timeout(20_000);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetcher(`${runtime.baseUrl}${path}`, {
      ...init,
      signal,
      headers: { Authorization: runtime.authHeader, "Content-Type": "application/json", ...init.headers },
    });
  } catch (error) {
    throw new Error(`OpenCode API ${path} request failed: ${redact(String(error), runtime.sensitiveValues)}`);
  }
  if (!response.ok) throw new Error(`OpenCode API ${path} returned HTTP ${response.status}: ${redact(await response.text(), runtime.sensitiveValues)}`);
  if (response.status === 204) return null;
  return response.json();
}

function retryableOpenCodeStartupError(error: unknown): boolean {
  const message = String(error);
  return message.includes("request failed")
    || message.includes("did not become healthy")
    || message.includes("exited during startup")
    || message.includes("HTTP 408")
    || message.includes("HTTP 425")
    || message.includes("HTTP 429")
    || /HTTP 5\d\d/.test(message);
}

async function waitForHealth(baseUrl: string, authHeader: string, fetcher: typeof globalThis.fetch, process: ChildProcess, diagnostics: string): Promise<unknown> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null || process.signalCode !== null) throw new Error(`OpenCode server exited during startup: ${redact(diagnostics)}`);
    try {
      const response = await fetcher(`${baseUrl}/global/health`, {
        headers: { Authorization: authHeader },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return response.json();
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("OpenCode server did not become healthy within 10 seconds");
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to reserve OpenCode port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 1_048_576) throw new Error("OpenCode SSE event exceeded the retained payload limit");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary).replaceAll("\r", "");
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      yield JSON.parse(data);
    }
  }
}

function sanitizedEnvironment(source: NodeJS.ProcessEnv, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENROUTER_API_KEY"];
  const result: NodeJS.ProcessEnv = {};
  for (const key of allowed) if (source[key] !== undefined) result[key] = source[key];
  return { ...result, ...overrides };
}

function sanitizedEnvironmentKeys(): string[] {
  return ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "OPENROUTER_API_KEY"];
}

function sessionRoot(runtimeDirectory: string, normalizedSessionId: string): string {
  const safe = normalizedSessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid normalized OpenCode session id");
  return join(resolve(runtimeDirectory), safe);
}

function validateWorkspace(value: string): string {
  const cwd = resolve(value);
  if (!value.trim() || cwd === dirname(cwd)) throw new Error("OpenCode working directory must not be a filesystem root");
  return cwd;
}

function validModel(value: string): boolean {
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}

function compareVersion(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function bounded(value: unknown): Record<string, unknown> {
  const serialized = JSON.stringify(value);
  if (!serialized || serialized.length > 64 * 1024) return { omitted: true, reason: "payload_limit" };
  const parsed = JSON.parse(serialized) as unknown;
  return isRecord(parsed) ? parsed : { value: parsed };
}

function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {}; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }
function redact(value: string, sensitiveValues: readonly (string | undefined)[] = []): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive && sensitive.length >= 4) redacted = redacted.split(sensitive).join("[REDACTED]");
  }
  return redacted.replace(/(OPENROUTER_API_KEY|authorization|password|token|secret)\s*[:=]\s*[^\s,}\]]+/gi, "$1=[REDACTED]").slice(0, 8_192);
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}

async function waitForExit(process: ChildProcess, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    process.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

export const openCodeServerDriverInternals = { parseSse };

class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  #closed = false;
  #error: unknown = null;
  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: item });
    else this.#items.push(item);
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  }
  fail(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ done: false, value: item });
        if (this.#error !== null) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}
