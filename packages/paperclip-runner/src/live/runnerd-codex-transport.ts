import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
  CodexTransportProcessInfo,
} from "../drivers/codex/app-server-transport.js";
import { createSanitizedCodexEnvironment } from "../drivers/codex/app-server-transport.js";
import { createIsolatedCodexAppServerArgs } from "../drivers/codex/codex-app-server-driver.js";
import {
  DurablePrpControlPlane,
  durableRecoveryInternals,
  spawnRunner,
  waitForProcess,
  type RunnerProcessHandle,
} from "../control-plane/durable-prp-control-plane.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const MAX_NOTIFICATION_COUNT = 2_048;
const MAX_NOTIFICATION_BYTES = 4 * 1024 * 1024;

export interface CapabilityRunnerdProcessEvidence {
  runnerPid: number | null;
  runnerProcessGroupId: number | null;
  codexPid: number | null;
  runnerExited: boolean;
  runnerExitCode: number | null;
  runnerSignal: NodeJS.Signals | null;
  childEnvironmentKeys: string[];
  diagnostics: string[];
}

export interface CapabilityRunnerdCodexTransportOptions {
  provider?: "codex" | "opencode";
  runnerBinary?: string;
  codexCommand?: string;
  codexArgs?: string[];
  opencodeCommand?: string;
  opencodeProxyPath?: string;
  opencodeRuntimeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  closeGraceMs?: number;
  onDiagnostic?: (message: string) => void;
  onEvidence?: (evidence: Readonly<CapabilityRunnerdProcessEvidence>) => void;
  stateDirectory?: string;
  prpIdentity?: {
    runnerInstanceId: string;
    environmentLeaseId: string;
    runId: string;
    normalizedSessionId: string;
    turnId: string;
    itemId: string;
  };
  /** Registers the run-bound PRP authority on Paperclip's shared HTTP server. */
  controlPlaneRegistration?: (authority: DurablePrpControlPlane) => Promise<{
    connectUrl: string;
    release: () => Promise<void> | void;
  }>;
}

export type RunnerdCodexTransportOptions = CapabilityRunnerdCodexTransportOptions;

export interface CapabilityRunnerdCodexTransport {
  transport: CodexAppServerTransport;
  evidence(): Readonly<CapabilityRunnerdProcessEvidence>;
}

export type RunnerdCodexTransport = CapabilityRunnerdCodexTransport;

export function unwrapRunnerdProviderNotification(input: unknown): Record<string, unknown> {
  const payload = record(input);
  if (typeof payload.method === "string") return payload;
  const latest = record(payload.latest);
  return typeof latest.method === "string" ? latest : payload;
}

class NotificationQueue implements AsyncIterable<CodexRpcNotification> {
  #values: Array<{ value: CodexRpcNotification; bytes: number }> = [];
  #waiters: Array<(value: IteratorResult<CodexRpcNotification>) => void> = [];
  #bytes = 0;
  #closed = false;

  push(value: CodexRpcNotification): void {
    if (this.#closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value, done: false });
      return;
    }
    if (this.#values.length >= MAX_NOTIFICATION_COUNT || this.#bytes + bytes > MAX_NOTIFICATION_BYTES) {
      throw new Error("PRP provider notification queue bound exceeded");
    }
    this.#values.push({ value, bytes });
    this.#bytes += bytes;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#values = [];
    this.#bytes = 0;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexRpcNotification> {
    return {
      next: async () => {
        const queued = this.#values.shift();
        if (queued !== undefined) {
          this.#bytes -= queued.bytes;
          return { value: queued.value, done: false };
        }
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolveValue) => this.#waiters.push(resolveValue));
      },
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function commandDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(durableRecoveryInternals.canonicalJson(value)).digest("hex")}`;
}

function unwrapToolResponse(response: Record<string, unknown>): unknown {
  const items = Array.isArray(response.contentItems) ? response.contentItems : [];
  const value = record(items[0]).text;
  if (typeof value !== "string") return response;
  try {
    return JSON.parse(value);
  } catch {
    return response;
  }
}

class DurablePrpCodexTransport implements CodexAppServerTransport {
  readonly #root: string;
  readonly #ownsRoot: boolean;
  readonly #queue = new NotificationQueue();
  readonly #startedAt = new Date().toISOString();
  readonly #evidence: CapabilityRunnerdProcessEvidence;
  #handler: CodexServerRequestHandler = async () => ({
    success: false,
    contentItems: [{ type: "inputText", text: "No Paperclip control-plane tool handler is installed." }],
  });
  #core: DurablePrpControlPlane | null = null;
  #handle: RunnerProcessHandle | null = null;
  #pump: NodeJS.Timeout | null = null;
  #eventIndex = 0;
  #threadId = "";
  #sessionId: string | null = null;
  #turnId = "";
  #closed = false;
  #controlPlaneRelease: (() => Promise<void> | void) | null = null;

  constructor(readonly options: CapabilityRunnerdCodexTransportOptions) {
    this.#ownsRoot = options.stateDirectory === undefined;
    this.#root = options.stateDirectory ?? mkdtempSync(resolve(tmpdir(), "paperclip-runner-lab-prp-"));
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#evidence = {
      runnerPid: null,
      runnerProcessGroupId: null,
      codexPid: null,
      runnerExited: false,
      runnerExitCode: null,
      runnerSignal: null,
      childEnvironmentKeys: Object.keys(createSanitizedCodexEnvironment(options.environment)).sort(),
      diagnostics: ["lab transport selected authenticated durable PRP"],
    };
  }

  evidence(): CapabilityRunnerdProcessEvidence {
    return structuredClone(this.#evidence);
  }

  async request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#closed) throw new Error("PRP Codex transport is closed");
    if (method === "initialize") return { user: {} };
    if (method === "thread/start") return this.#start(params);
    if (method === "turn/start") return this.#startTurn(params);
    if (method === "turn/interrupt") {
      await this.#command("turn.interrupt", params);
      return {};
    }
    if (method === "thread/read") {
      if (this.#core === null) await this.#resume();
      return this.#commandResult("provider.thread.read", {});
    }
    if (method === "thread/resume") return { thread: { id: this.#threadId, sessionId: this.#sessionId } };
    throw new Error(`PRP Codex transport does not expose provider method ${method}`);
  }

  notify(_method: string, _params?: Record<string, unknown>): void {}

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.#queue;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.#handler = handler;
  }

  processInfo(): CodexTransportProcessInfo {
    return {
      pid: this.#evidence.runnerPid,
      processGroupId: this.#evidence.runnerProcessGroupId,
      startedAt: this.#startedAt,
      exited: this.#evidence.runnerExited,
      exitCode: this.#evidence.runnerExitCode,
      signal: this.#evidence.runnerSignal,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#core !== null && this.#handle !== null) {
      this.#core.queueCommand("runner.suspend", {}, undefined, true);
      try {
        const result = await waitForProcess(this.#handle, this.options.closeGraceMs ?? 10_000);
        this.#evidence.runnerExited = true;
        this.#evidence.runnerExitCode = result.code;
        this.#evidence.runnerSignal = result.signal as NodeJS.Signals | null;
        if (result.stderr.trim()) this.#diagnostic(result.stderr.trim().slice(-4_096));
      } catch (error) {
        this.#diagnostic(`runner shutdown failed: ${String(error)}`);
      }
    }
    if (this.#pump !== null) clearInterval(this.#pump);
    this.#pump = null;
    this.#queue.close();
    if (this.#controlPlaneRelease !== null) await this.#controlPlaneRelease();
    await this.#core?.stop();
    this.#controlPlaneRelease = null;
    this.#handle?.child.kill("SIGKILL");
    if (this.#ownsRoot) rmSync(this.#root, { recursive: true, force: true });
    this.#publish();
  }

  async #start(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#core !== null) throw new Error("PRP provider thread is already started");
    const token = randomUUID().replaceAll("-", "");
    const identity = this.options.prpIdentity ?? {
      runnerInstanceId: `runner_lab_${token}`,
      environmentLeaseId: `lease_lab_${token}`,
      runId: `run_lab_${token}`,
      normalizedSessionId: `session_lab_${token}`,
      turnId: `turn_lab_${token}`,
      itemId: `item_lab_${token}`,
    };
    const dynamicTools = Array.isArray(params.dynamicTools) ? params.dynamicTools.map(record) : [];
    const operations = dynamicTools.map((tool) => ({
      operationId: String(tool.name ?? ""),
      version: 1,
      description: String(tool.description ?? ""),
      inputSchema: record(tool.inputSchema),
      responseSchema: {},
    }));
    const core = new DurablePrpControlPlane({
      stateDirectory: resolve(this.#root, "control-plane"),
      identity,
      onSemanticToolInput: async (call) => unwrapToolResponse(await this.#handler({
        id: call.callId,
        method: "item/tool/call",
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          callId: call.callId,
          tool: call.operationId,
          arguments: call.input,
        },
      })),
      connectionLeaseTtlMs: 60 * 60 * 1_000,
    });
    this.#core = core;
    mkdirSync(resolve(this.#root, "runner"), { recursive: true, mode: 0o700 });
    const provider = this.options.provider ?? "codex";
    const opencodeProxyPath = this.options.opencodeProxyPath
      ?? fileURLToPath(new URL("../cli/opencode-app-server-proxy.js", import.meta.url));
    core.queueCommand("run.prepare", {
      authorizedTools: {
        schema: "paperclip.runner.authorized-tools.v1",
        schemaVersion: 1,
        catalogDigest: commandDigest(operations),
        operations,
      },
      provider: {
        kind: provider,
        command: provider === "opencode" ? process.execPath : this.options.codexCommand ?? "codex",
        args: provider === "opencode" ? [opencodeProxyPath] : this.options.codexArgs ?? createIsolatedCodexAppServerArgs(this.options.environment),
        cwd: String(params.cwd ?? tmpdir()),
        model: typeof params.model === "string" ? params.model : null,
        instructions: String(params.baseInstructions ?? "You are a Paperclip agent."),
      },
    });
    core.queueCommand("session.open", { reuse: "same_session" });
    const registration = this.options.controlPlaneRegistration
      ? await this.options.controlPlaneRegistration(core)
      : null;
    if (registration === null) await core.start();
    else this.#controlPlaneRelease = registration.release;
    const handle = spawnRunner({
      connectUrl: registration?.connectUrl ?? core.connectUrl,
      stateDirectory: resolve(this.#root, "runner"),
      identity,
      ticket: core.issueBootstrapTicket(),
      maxOutboxBytes: 256 * 1024,
      p0ReserveBytes: 64 * 1024,
      maxRuntimeMs: 60 * 60 * 1_000,
      runnerBinaryPath: this.options.runnerBinary ?? defaultCapabilityRunnerdBinary(),
      environment: provider === "opencode"
        ? {
            ...this.options.environment,
            PAPERCLIP_OPENCODE_COMMAND: this.options.opencodeCommand ?? "opencode",
            PAPERCLIP_OPENCODE_RUNTIME_DIR: this.options.opencodeRuntimeDirectory ?? resolve(this.#root, "opencode"),
            PAPERCLIP_RUNNER_INSTANCE_ID: identity.runnerInstanceId,
            PAPERCLIP_RUN_ID: identity.runId,
            PAPERCLIP_NORMALIZED_SESSION_ID: identity.normalizedSessionId,
          }
        : this.options.environment,
    });
    this.#handle = handle;
    this.#evidence.runnerPid = handle.child.pid ?? null;
    this.#evidence.runnerProcessGroupId = null;
    this.#publish();
    this.#pump = setInterval(() => this.#pumpEvents(), 5);
    await this.#waitCommand("run.prepare");
    await this.#waitCommand("session.open");
    await this.#waitForProviderIdentity();
    this.#diagnostic("runnerd authenticated to the durable PRP control plane");
    return { thread: { id: this.#threadId, sessionId: this.#sessionId, model: params.model, modelProvider: "openai" } };
  }

  async #resume(): Promise<void> {
    const identity = this.options.prpIdentity;
    if (identity === undefined || !existsSync(resolve(this.#root, "runner", "runner-state.json"))) {
      throw new Error("PRP provider resume state is unavailable");
    }
    const core = new DurablePrpControlPlane({
      stateDirectory: resolve(this.#root, "control-plane"),
      identity,
      onSemanticToolInput: async (call) => unwrapToolResponse(await this.#handler({
        id: call.callId,
        method: "item/tool/call",
        params: {
          threadId: this.#threadId,
          turnId: this.#turnId,
          callId: call.callId,
          tool: call.operationId,
          arguments: call.input,
        },
      })),
      connectionLeaseTtlMs: 60 * 60 * 1_000,
    });
    this.#core = core;
    this.#eventIndex = core.store.state.committedEvents.length;
    const registration = this.options.controlPlaneRegistration
      ? await this.options.controlPlaneRegistration(core)
      : null;
    if (registration === null) await core.start();
    else this.#controlPlaneRelease = registration.release;
    const handle = spawnRunner({
      connectUrl: registration?.connectUrl ?? core.connectUrl,
      stateDirectory: resolve(this.#root, "runner"),
      identity,
      ticket: core.issueBootstrapTicket(),
      maxOutboxBytes: 256 * 1024,
      p0ReserveBytes: 64 * 1024,
      maxRuntimeMs: 60 * 60 * 1_000,
      runnerBinaryPath: this.options.runnerBinary ?? defaultCapabilityRunnerdBinary(),
    });
    this.#handle = handle;
    this.#evidence.runnerPid = handle.child.pid ?? null;
    this.#evidence.runnerProcessGroupId = null;
    this.#publish();
    this.#pump = setInterval(() => this.#pumpEvents(), 5);
    await this.#waitForProviderIdentity();
    this.#diagnostic("runnerd restored its durable PRP session and provider thread");
  }

  async #startTurn(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const input = Array.isArray(params.input) ? params.input.map(record) : [];
    const message = input.map((item) => typeof item.text === "string" ? item.text : "").join("\n");
    const pendingTurnId = `turn_lab_${randomUUID().replaceAll("-", "")}`;
    this.#turnId = pendingTurnId;
    await this.#command("turn.start", { text: message });
    // Command completion only means runnerd accepted the command. Codex assigns
    // the authoritative turn identity in the subsequent turn/started event, so
    // do not expose the temporary transport identity to the strict driver.
    const deadline = Date.now() + 30_000;
    while (this.#turnId === pendingTurnId && Date.now() < deadline) {
      this.#pumpEvents();
      if (this.#turnId !== pendingTurnId) break;
      if (this.#handle?.child.exitCode !== null) throw new Error("runnerd exited before provider turn startup");
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (this.#turnId === pendingTurnId) throw new Error("runnerd did not report the provider turn identity");
    return { turn: { id: this.#turnId, status: "inProgress" } };
  }

  async #command(type: string, payload: Record<string, unknown>): Promise<void> {
    const core = this.#core;
    if (core === null) throw new Error("PRP provider thread is not started");
    const commandId = `command_lab_${randomUUID().replaceAll("-", "")}`;
    core.queueCommand(type, payload, commandId, true);
    await this.#waitCommand(type, commandId);
  }

  async #commandResult(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const core = this.#core;
    if (core === null) throw new Error("PRP provider thread is not started");
    const commandId = `command_lab_${randomUUID().replaceAll("-", "")}`;
    core.queueCommand(type, payload, commandId, true);
    await this.#waitCommand(type, commandId);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const event = core.store.state.committedEvents.find((candidate) => {
        if (candidate.eventType !== "provider.rpc_result") return false;
        return record(record(candidate.envelope.payload).payload).commandId === commandId;
      });
      const result = record(record(record(event?.envelope.payload).payload).result);
      if (event !== undefined) return result;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`PRP command ${type} omitted its provider result`);
  }

  async #waitForProviderIdentity(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.#pumpEvents();
      if (this.#threadId.length > 0 && this.#evidence.codexPid !== null) return;
      if (this.#handle?.child.exitCode !== null) throw new Error("runnerd exited before provider startup");
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error("runnerd did not report its provider identity");
  }

  async #waitCommand(type: string, commandId?: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const command = this.#core?.store.state.commands.find((candidate) =>
        commandId === undefined ? candidate.type === type : candidate.commandId === commandId
      );
      if (command?.status === "completed") return;
      if (command !== undefined && command.status !== "pending") {
        throw new Error(`PRP command ${type} ${command.status}: ${JSON.stringify(command.result)}`);
      }
      if (this.#handle?.child.exitCode !== null) throw new Error(`runnerd exited while waiting for ${type}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`PRP command ${type} timed out`);
  }

  #pumpEvents(): void {
    const events = this.#core?.store.state.committedEvents ?? [];
    while (this.#eventIndex < events.length) {
      const event = events[this.#eventIndex++];
      if (event.eventType === "provider.started") {
        const started = record(record(event.envelope.payload).payload);
        const pid = started.pid;
        const threadId = started.threadId;
        const sessionId = started.sessionId;
        if (typeof pid === "number") {
          this.#evidence.codexPid = pid;
        }
        if (typeof threadId === "string") this.#threadId = threadId;
        if (typeof sessionId === "string") this.#sessionId = sessionId;
        this.#publish();
        continue;
      }
      if (event.eventType !== "provider.event" && event.eventType !== "turn.completed") continue;
      const payload = unwrapRunnerdProviderNotification(record(event.envelope.payload).payload);
      const method = payload.method;
      if (typeof method !== "string") continue;
      const params = record(payload.params);
      const providerTurnId = params.turnId ?? record(params.turn).id;
      if (typeof providerTurnId === "string" && providerTurnId.length > 0) {
        this.#turnId = providerTurnId;
      }
      this.#queue.push({ method, params });
    }
  }

  #diagnostic(message: string): void {
    this.#evidence.diagnostics.push(message);
    if (this.#evidence.diagnostics.length > 64) this.#evidence.diagnostics.shift();
    this.options.onDiagnostic?.(message);
    this.#publish();
  }

  #publish(): void {
    this.options.onEvidence?.(this.evidence());
  }
}

export function defaultCapabilityRunnerdBinary(): string {
  return resolve(packageRoot, `runner/target/debug/paperclip-runnerd${executableSuffix}`);
}

/** Starts an authenticated durable PRP authority, runnerd, and Codex provider transport. */
export function createCapabilityRunnerdCodexTransport(
  options: CapabilityRunnerdCodexTransportOptions = {},
): CapabilityRunnerdCodexTransport {
  const transport = new DurablePrpCodexTransport(options);
  return { transport, evidence: () => transport.evidence() };
}

export const createRunnerdCodexTransport = createCapabilityRunnerdCodexTransport;
