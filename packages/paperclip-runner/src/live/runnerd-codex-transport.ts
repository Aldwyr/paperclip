import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CodexAppServerTransport,
  CodexRpcNotification,
  CodexRpcServerRequest,
  CodexServerRequestHandler,
  CodexTraceInterpretation,
  CodexTransportProcessInfo,
} from "../drivers/codex/app-server-transport.js";
import { createSanitizedCodexEnvironment } from "../drivers/codex/app-server-transport.js";
import {
  codexSemanticToolSpecs,
  createIsolatedCodexAppServerArgs,
} from "../drivers/codex/codex-app-server-driver.js";
import type { DurableRecoveryIdentity } from "../contracts/durable-recovery.js";
import {
  DurablePrpControlPlane,
  durableRecoveryInternals,
  spawnRunner,
  waitForProcess,
  type RunnerProcessHandle,
} from "../control-plane/durable-prp-control-plane.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
} from "../drivers/acpx/qualified-profiles.js";
import { createSanitizedAcpxEnvironment } from "../drivers/acpx/environment.js";
import { createSanitizedClaudeManagedEnvironment } from "../drivers/claude-managed/environment.js";
import type { NativeRuntimeContextSnapshot } from "../contracts/runtime-context.js";
import { nativeMcpLaunchBinding } from "../drivers/native-mcp.js";
import { prepareIsolatedCodexHome } from "../drivers/runtime-context-materializer.js";

export { createSanitizedClaudeManagedEnvironment } from "../drivers/claude-managed/environment.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const MAX_NOTIFICATION_COUNT = 2_048;
const MAX_NOTIFICATION_BYTES = 4 * 1024 * 1024;

function recoveredControlPlaneIdentity(
  directory: string,
  desired: DurableRecoveryIdentity,
): DurableRecoveryIdentity {
  const stored = record(
    JSON.parse(
      readFileSync(resolve(directory, "mock-core-state.json"), "utf8"),
    ),
  );
  const identity = record(
    stored.identity,
  ) as unknown as DurableRecoveryIdentity;
  if (
    identity.runnerInstanceId !== desired.runnerInstanceId ||
    identity.environmentLeaseId !== desired.environmentLeaseId ||
    identity.normalizedSessionId !== desired.normalizedSessionId
  ) {
    throw new Error(
      "PRP recovery identity does not match the durable session binding",
    );
  }
  return structuredClone(identity);
}

export interface CapabilityRunnerdProcessEvidence {
  runnerPid: number | null;
  runnerProcessGroupId: number | null;
  providerPid: number | null;
  codexPid: number | null;
  sidecarPid: number | null;
  agentPid: number | null;
  providerDriver: string | null;
  providerVersion: string | null;
  acpxAgent: QualifiedAcpxAgent | null;
  agentServerVersion: string | null;
  agentRuntimeVersion: string | null;
  acpProtocolVersion: number | null;
  providerExecutionKind: "local_process" | "remote_service" | null;
  providerService:
    "anthropic_managed_agents" | "aws_bedrock_agentcore_harness" | null;
  runnerExited: boolean;
  runnerExitCode: number | null;
  runnerSignal: NodeJS.Signals | null;
  childEnvironmentKeys: string[];
  diagnostics: string[];
}

export interface CapabilityRunnerdCodexTransportOptions {
  provider?: "codex" | "opencode" | "claude_managed" | "aws_agentcore" | "acpx";
  acpxAgent?: QualifiedAcpxAgent;
  acpxSidecarPath?: string;
  acpxRuntimeDirectory?: string;
  managedProfile?: {
    profileId: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: "managed-agents-2026-04-01";
    maxSessionListCostUsd: number;
    model: string;
  };
  agentCoreProfile?: {
    profileId: string;
    region: string;
    accountId: string;
    harnessArn: string;
    harnessVersion: string;
    endpointArn: string;
    endpointQualifier: string;
    agentRuntimeArn: string;
    memoryArn: string;
    memoryId: string;
    invocationRoleArn: string;
    qualificationRevision: string;
    eventExpiryDays: 90;
    maxEstimatedSessionCostUsd: number;
    maxIterations: number;
    maxOutputTokens: number;
    timeoutSeconds: number;
    model: string;
  };
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
  lifecyclePolicy?:
    | { mode: "per_turn"; idleTimeoutMs: null }
    | { mode: "warm"; idleTimeoutMs: number };
  runtimeContext?: NativeRuntimeContextSnapshot | null;
  /** Current run's authority catalog, used when a suspended session is rebound. */
  resumeDynamicTools?: readonly Readonly<Record<string, unknown>>[];
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

export type RunnerdCodexTransportOptions =
  CapabilityRunnerdCodexTransportOptions;

export interface CapabilityRunnerdCodexTransport {
  transport: CodexAppServerTransport;
  evidence(): Readonly<CapabilityRunnerdProcessEvidence>;
}

export type RunnerdCodexTransport = CapabilityRunnerdCodexTransport;

export function unwrapRunnerdProviderNotifications(
  input: unknown,
): Record<string, unknown>[] {
  const payload = record(input);
  if (typeof payload.method === "string") return [payload];
  if (Array.isArray(payload.events)) {
    return payload.events
      .map(record)
      .filter((event) => typeof event.method === "string");
  }
  const latest = record(payload.latest);
  return typeof latest.method === "string" ? [latest] : [];
}

export function unwrapRunnerdProviderNotification(
  input: unknown,
): Record<string, unknown> {
  const notifications = unwrapRunnerdProviderNotifications(input);
  return notifications.at(-1) ?? record(input);
}

class NotificationQueue implements AsyncIterable<CodexRpcNotification> {
  #values: Array<{ value: CodexRpcNotification; bytes: number }> = [];
  #waiters: Array<{
    resolve: (value: IteratorResult<CodexRpcNotification>) => void;
    reject: (error: Error) => void;
  }> = [];
  #bytes = 0;
  #closed = false;
  #error: Error | null = null;

  push(value: CodexRpcNotification): void {
    if (this.#closed) return;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return;
    }
    if (
      this.#values.length >= MAX_NOTIFICATION_COUNT ||
      this.#bytes + bytes > MAX_NOTIFICATION_BYTES
    ) {
      throw new Error("PRP provider notification queue bound exceeded");
    }
    this.#values.push({ value, bytes });
    this.#bytes += bytes;
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error ?? null;
    this.#values = [];
    this.#bytes = 0;
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#error !== null) waiter.reject(this.#error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<CodexRpcNotification> {
    return {
      next: async () => {
        const queued = this.#values.shift();
        if (queued !== undefined) {
          this.#bytes -= queued.bytes;
          return { value: queued.value, done: false };
        }
        if (this.#error !== null) throw this.#error;
        if (this.#closed) return { value: undefined, done: true };
        return new Promise((resolveValue, reject) =>
          this.#waiters.push({ resolve: resolveValue, reject }),
        );
      },
    };
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type PendingTraceRehydration = {
  sourceEventId: string;
  eventType: string;
  visibleNotificationCount: number;
};

type PendingDriverTraceInterpretation = CodexTraceInterpretation;

function locateRunnerdTraceFrame(
  tracePath: string,
  sourceEventId: string,
): { frameId: number | null; nativeChannelSettled: boolean } {
  const lines = readFileSync(tracePath, "utf8").split("\n");
  let frameId: number | null = null;
  let nativeChannelSettled = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]?.trim()) continue;
    const entry = record(JSON.parse(lines[index]!));
    if (entry.kind === "trace_status" && entry.debugChannel === "rust_native") {
      nativeChannelSettled = true;
    }
    if (
      entry.kind !== "interpretation" ||
      !Array.isArray(entry.emittedEventIds)
    ) {
      continue;
    }
    if ((entry.emittedEventIds as unknown[]).includes(sourceEventId)) {
      frameId = typeof entry.frameId === "number" ? entry.frameId : null;
      break;
    }
  }
  return { frameId, nativeChannelSettled };
}

function appendRunnerdRehydrationTrace(
  tracePath: string | undefined,
  sourceEventId: string,
  eventType: string,
  visibleNotificationCount: number,
  debugSequence: number,
): "written" | "retry" | "not_applicable" {
  if (!tracePath) return "not_applicable";
  if (!existsSync(tracePath)) return "retry";
  try {
    const { frameId, nativeChannelSettled } = locateRunnerdTraceFrame(
      tracePath,
      sourceEventId,
    );
    if (frameId === null)
      return nativeChannelSettled ? "not_applicable" : "retry";
    appendFileSync(
      `${tracePath}.rehydration`,
      `${JSON.stringify({
        kind: "interpretation",
        schema: "paperclip.provider_trace_interpretation.v1",
        debugChannel: "typescript_runnerd_rehydration",
        debugSequence,
        frameId,
        stage: "typescript_runnerd_rehydration",
        ruleId: `runnerd.rehydrate.${eventType}`,
        disposition: visibleNotificationCount > 0 ? "mapped" : "ignored",
        emittedEventIds: [sourceEventId],
        droppedFields: [],
        fieldMappings: [
          {
            inputPath: "sourceEventId",
            outputPath: "paperclipTrace.sourceEventId",
            action: "copied",
            reason: "Preserved the durable event identity while rehydrating the provider notification",
          },
          {
            inputPath: "eventType",
            outputPath: "paperclipTrace.sourceEventType",
            action: "renamed",
            reason: "Attached the canonical PRP type to the rehydrated notification",
          },
        ],
        reason:
          visibleNotificationCount > 0
            ? "Canonical PRP event was rehydrated into the Codex driver notification contract"
            : "Canonical PRP event did not produce a Codex driver notification",
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return "written";
  } catch {
    // Debug delivery is deliberately outside run authority and never fails it.
    return "retry";
  }
}

function appendCodexDriverInterpretationTrace(
  tracePath: string | undefined,
  input: PendingDriverTraceInterpretation,
  debugSequence: number,
): "written" | "retry" | "not_applicable" {
  if (!tracePath) return "not_applicable";
  if (!existsSync(tracePath)) return "retry";
  try {
    const { frameId, nativeChannelSettled } = locateRunnerdTraceFrame(
      tracePath,
      input.sourceEventId,
    );
    if (frameId === null) {
      return nativeChannelSettled ? "not_applicable" : "retry";
    }
    appendFileSync(
      `${tracePath}.rehydration`,
      `${JSON.stringify({
        kind: "interpretation",
        schema: "paperclip.provider_trace_interpretation.v1",
        debugChannel: "typescript_runnerd_rehydration",
        debugSequence,
        frameId,
        stage: "typescript_codex_driver_normalization",
        ruleId: `codex_driver.normalize.${input.providerMethod}`,
        disposition: input.disposition,
        emittedEventIds: input.emittedEventIds,
        droppedFields: [],
        fieldMappings: [
          {
            inputPath: "params",
            outputPath: "payload",
            action: "normalized",
            reason: "Codex notification fields were normalized into canonical PRP event payloads",
          },
          ...input.emittedEventIds.map((eventId) => ({
            outputPath: `event:${eventId}`,
            action: "derived",
            reason: "The driver emitted this canonical PRP event from the normalized notification",
          })),
        ],
        reason: input.reason,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return "written";
  } catch {
    // Debug delivery is deliberately outside run authority and never fails it.
    return "retry";
  }
}

function appendRunnerdTraceStatus(
  tracePath: string,
  input: {
    status: "complete" | "incomplete";
    reason: string | null;
    debugSequence: number;
    acknowledgedDebugSequence: number;
  },
): void {
  appendFileSync(
    `${tracePath}.rehydration`,
    `${JSON.stringify({
      kind: "trace_status",
      debugChannel: "typescript_runnerd_rehydration",
      debugSequence: input.debugSequence,
      status: input.status,
      acknowledgedDebugSequence: input.acknowledgedDebugSequence,
      reason: input.reason,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

export function rehydrateRunnerdUsageNotification(
  rawParams: Record<string, unknown>,
  openedThreadId: string,
  activeTurnId: string,
): Record<string, unknown> {
  return {
    ...rawParams,
    // The normalized PRP usage event carries the provider session identity
    // rather than replaying the provider's original threadId field. Rehydrate
    // the Codex notification contract so the strict driver does not reject
    // valid accounting as a cross-thread event.
    threadId:
      typeof rawParams.threadId === "string"
        ? rawParams.threadId
        : typeof rawParams.providerSessionId === "string"
          ? rawParams.providerSessionId
          : openedThreadId,
    turnId:
      typeof rawParams.turnId === "string" ? rawParams.turnId : activeTurnId,
    tokenUsage: {
      total: record(rawParams.cumulative),
      runDelta: record(rawParams.runDelta),
    },
  };
}

function commandDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(durableRecoveryInternals.canonicalJson(value)).digest("hex")}`;
}

function authorizedToolSet(
  tools: readonly Readonly<Record<string, unknown>>[],
): Record<string, unknown> {
  const operations = tools.map((tool) => ({
    operationId: String(tool.name ?? ""),
    version: 1,
    description: String(tool.description ?? ""),
    inputSchema: record(tool.inputSchema),
    responseSchema: {},
  }));
  return {
    schema: "paperclip.runner.authorized-tools.v1",
    schemaVersion: 1,
    catalogDigest: commandDigest(operations),
    operations,
  };
}

export function createSanitizedAwsAgentCoreEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const source = environment ?? process.env;
  const result: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "RUST_BACKTRACE",
    "AWS_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN",
    "AWS_ROLE_SESSION_NAME",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "PAPERCLIP_NATIVE_MCP_NAME",
    "PAPERCLIP_NATIVE_MCP_URL",
    "PAPERCLIP_NATIVE_MCP_TOKEN",
  ]) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  return result;
}

function unwrapToolResponse(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const items = Array.isArray(response.contentItems)
    ? response.contentItems
    : [];
  const value = record(items[0]).text;
  let result: unknown = response;
  try {
    if (typeof value === "string") result = JSON.parse(value);
  } catch {
    result = response;
  }
  return {
    __paperclipSemanticToolOutcome: true,
    result,
    isError: response.success === false,
  };
}

class DurablePrpCodexTransport implements CodexAppServerTransport {
  readonly #root: string;
  readonly #ownsRoot: boolean;
  readonly #queue = new NotificationQueue();
  readonly #startedAt = new Date().toISOString();
  readonly #evidence: CapabilityRunnerdProcessEvidence;
  #handler: CodexServerRequestHandler = async () => ({
    success: false,
    contentItems: [
      {
        type: "inputText",
        text: "No Paperclip control-plane tool handler is installed.",
      },
    ],
  });
  #core: DurablePrpControlPlane | null = null;
  #handle: RunnerProcessHandle | null = null;
  #pump: NodeJS.Timeout | null = null;
  #eventIndex = 0;
  #threadId = "";
  #sessionId: string | null = null;
  #turnId = "";
  #durableTurnId = "";
  #authorizedTools: Record<string, unknown> | null = null;
  #closed = false;
  #failure: Error | null = null;
  #controlPlaneRelease: (() => Promise<void> | void) | null = null;
  #nextTraceDebugSequence = 1;
  #traceRehydrationSpoolOverflow = false;
  #pendingTraceRehydrations: PendingTraceRehydration[] = [];
  #pendingDriverTraceInterpretations: PendingDriverTraceInterpretation[] = [];

  constructor(readonly options: CapabilityRunnerdCodexTransportOptions) {
    this.#ownsRoot = options.stateDirectory === undefined;
    this.#root =
      options.stateDirectory ??
      mkdtempSync(resolve(tmpdir(), "paperclip-runner-lab-prp-"));
    if (options.resumeDynamicTools !== undefined) {
      this.#authorizedTools = authorizedToolSet([
        ...options.resumeDynamicTools,
        ...codexSemanticToolSpecs(),
      ]);
    }
    mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.#evidence = {
      runnerPid: null,
      runnerProcessGroupId: null,
      providerPid: null,
      codexPid: null,
      sidecarPid: null,
      agentPid: null,
      providerDriver: null,
      providerVersion: null,
      acpxAgent: null,
      agentServerVersion: null,
      agentRuntimeVersion: null,
      acpProtocolVersion: null,
      providerExecutionKind: null,
      providerService: null,
      runnerExited: false,
      runnerExitCode: null,
      runnerSignal: null,
      childEnvironmentKeys: Object.keys(
        options.provider === "claude_managed"
          ? createSanitizedClaudeManagedEnvironment(options.environment)
          : options.provider === "aws_agentcore"
            ? createSanitizedAwsAgentCoreEnvironment(options.environment)
            : options.provider === "acpx"
              ? createSanitizedAcpxEnvironment(
                  options.environment,
                  options.acpxAgent ?? "pi",
                )
              : createSanitizedCodexEnvironment(options.environment),
      ).sort(),
      diagnostics: ["lab transport selected authenticated durable PRP"],
    };
  }

  evidence(): CapabilityRunnerdProcessEvidence {
    return structuredClone(this.#evidence);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#closed) throw new Error("PRP Codex transport is closed");
    this.#throwIfFailed();
    if (method === "initialize") return { user: {} };
    if (method === "thread/start") return this.#start(params);
    if (method === "collaborationMode/list") {
      // runnerd already negotiated the real preset with the provider during
      // session.open. This transport-level mask confirms that closed boundary;
      // turn/start remains runner-managed and never forwards this sentinel.
      return this.options.provider === undefined ||
        this.options.provider === "codex"
        ? {
            data: [
              {
                name: "Plan",
                mode: "plan",
                model: "runner-managed",
                reasoning_effort: null,
              },
            ],
          }
        : { data: [] };
    }
    if (method === "turn/start") return this.#startTurn(params);
    if (method === "turn/steer") {
      const input = Array.isArray(params.input) ? params.input.map(record) : [];
      const text = input
        .map((item) => (typeof item.text === "string" ? item.text : ""))
        .join("\n");
      const expectedTurnId =
        typeof params.expectedTurnId === "string"
          ? params.expectedTurnId
          : this.#turnId;
      if (!text.trim()) throw new Error("turn/steer requires a message");
      if (expectedTurnId !== this.#turnId)
        throw new Error("turn/steer named a stale turn");
      const correlationId =
        typeof params.correlationId === "string"
          ? params.correlationId
          : undefined;
      await this.#command(
        "turn.steer",
        {
          text,
          turnId: this.#durableTurnId,
          providerTurnId: expectedTurnId,
          ...(correlationId ? { correlationId } : {}),
        },
        correlationId,
      );
      return {};
    }
    if (method === "turn/interrupt") {
      await this.#command("turn.interrupt", params);
      return {};
    }
    if (method === "thread/read") {
      if (this.#core === null) await this.#resume();
      const result = await this.#commandResult("provider.thread.read", {});
      if (
        this.options.provider !== "claude_managed" &&
        this.options.provider !== "aws_agentcore"
      )
        return result;
      const session = record(result.session);
      return {
        ...result,
        thread: {
          id: this.#threadId,
          sessionId: this.#sessionId,
          turns: [],
          ...(session.usage === undefined ? {} : { tokenUsage: session.usage }),
        },
      };
    }
    if (method === "session/budget/increase") {
      await this.#command("session.budget.increase", params);
      return {};
    }
    if (method === "session/destroy") {
      await this.#command("session.destroy", params);
      return {};
    }
    if (method === "thread/resume")
      return { thread: { id: this.#threadId, sessionId: this.#sessionId } };
    throw new Error(
      `PRP Codex transport does not expose provider method ${method}`,
    );
  }

  notify(_method: string, _params?: Record<string, unknown>): void {}

  notifications(): AsyncIterable<CodexRpcNotification> {
    return this.#queue;
  }

  setServerRequestHandler(handler: CodexServerRequestHandler): void {
    this.#handler = handler;
  }

  recordTraceInterpretation(input: CodexTraceInterpretation): void {
    const tracePath = this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH;
    if (!tracePath) return;
    const traceResult = appendCodexDriverInterpretationTrace(
      tracePath,
      input,
      this.#nextTraceDebugSequence,
    );
    if (traceResult === "written") {
      this.#nextTraceDebugSequence += 1;
    } else if (
      traceResult === "retry" &&
      this.#pendingDriverTraceInterpretations.length < 4_096
    ) {
      this.#pendingDriverTraceInterpretations.push(structuredClone(input));
    } else if (traceResult === "retry") {
      this.#traceRehydrationSpoolOverflow = true;
    }
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

  async attachRun(input: {
    runId: string;
    turnId: string;
    itemId: string;
  }): Promise<void> {
    if (this.#closed || this.#core === null)
      throw new Error("PRP provider session is not attachable");
    await this.#command("run.attach", {
      runId: input.runId,
      turnId: input.turnId,
      itemId: input.itemId,
      ...(this.#authorizedTools === null
        ? {}
        : { authorizedTools: this.#authorizedTools }),
    });
    await this.#waitForAttachment(input.runId);
    this.#durableTurnId = input.turnId;
    this.#turnId = input.turnId;
  }

  async #waitForAttachment(runId: string): Promise<void> {
    const core = this.#core;
    const attachDeadline = Date.now() + 10_000;
    let attachmentDrained = false;
    while (core !== null && Date.now() < attachDeadline) {
      const durable = record(
        JSON.parse(
          readFileSync(
            resolve(this.#root, "runner", "runner-state.json"),
            "utf8",
          ),
        ),
      );
      const attached = core.store.state.committedEvents.find(
        (event) =>
          event.eventType === "run.attached" &&
          record(record(event.envelope.payload).payload).runId === runId,
      );
      if (
        attached &&
        Number(durable.ackedSourceSeq ?? 0) >= attached.sourceSeq
      ) {
        attachmentDrained = true;
        break;
      }
      this.#throwIfFailed();
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (!attachmentDrained)
      throw new Error("runnerd did not durably acknowledge the run attachment");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#core !== null && this.#handle !== null) {
      const perTurnAlreadySuspending =
        this.options.lifecyclePolicy?.mode === "per_turn" &&
        this.#core.store.state.committedEvents.some(
          (event) =>
            event.eventType === "runner.suspending" ||
            event.eventType === "turn.completed" ||
            event.eventType === "turn.failed" ||
            event.eventType === "turn.interrupted" ||
            event.eventType === "turn.cancelled",
        );
      if (!perTurnAlreadySuspending) {
        this.#core.queueCommand("runner.suspend", {}, undefined, true);
      }
      try {
        const result = await waitForProcess(
          this.#handle,
          this.options.closeGraceMs ?? 10_000,
        );
        this.#evidence.runnerExited = true;
        this.#evidence.runnerExitCode = result.code;
        this.#evidence.runnerSignal = result.signal as NodeJS.Signals | null;
        if (result.stderr.trim())
          this.#diagnostic(result.stderr.trim().slice(-4_096));
      } catch (error) {
        this.#diagnostic(`runner shutdown failed: ${String(error)}`);
      }
    }
    this.#flushPendingTraceRehydrations();
    const tracePath = this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH;
    if (tracePath) {
      const incomplete =
        this.#traceRehydrationSpoolOverflow ||
        this.#pendingTraceRehydrations.length > 0 ||
        this.#pendingDriverTraceInterpretations.length > 0;
      const debugSequence = this.#nextTraceDebugSequence++;
      try {
        appendRunnerdTraceStatus(tracePath, {
          status: incomplete ? "incomplete" : "complete",
          reason: incomplete
            ? this.#traceRehydrationSpoolOverflow
              ? "typescript_rehydration_spool_full"
              : "typescript_rehydration_correlation_incomplete"
            : null,
          debugSequence,
          acknowledgedDebugSequence: debugSequence - 1,
        });
      } catch {
        // Raw trace failure is intentionally independent of run authority.
      }
      this.#pendingTraceRehydrations = [];
      this.#pendingDriverTraceInterpretations = [];
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

  async #start(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (this.#core !== null)
      throw new Error("PRP provider thread is already started");
    const token = randomUUID().replaceAll("-", "");
    const identity = this.options.prpIdentity ?? {
      runnerInstanceId: `runner_lab_${token}`,
      environmentLeaseId: `lease_lab_${token}`,
      runId: `run_lab_${token}`,
      normalizedSessionId: `session_lab_${token}`,
      turnId: `turn_lab_${token}`,
      itemId: `item_lab_${token}`,
    };
    this.#durableTurnId = identity.turnId;
    const dynamicTools = Array.isArray(params.dynamicTools)
      ? params.dynamicTools.map(record)
      : [];
    const core = new DurablePrpControlPlane({
      stateDirectory: resolve(this.#root, "control-plane"),
      identity,
      onSemanticToolInput: async (call) =>
        unwrapToolResponse(
          await this.#handler({
            id: call.callId,
            method: "item/tool/call",
            params: {
              threadId: this.#threadId,
              turnId: this.#turnId,
              callId: call.callId,
              tool: call.operationId,
              arguments: call.input,
            },
          }),
        ),
      connectionLeaseTtlMs: 60 * 60 * 1_000,
    });
    this.#core = core;
    mkdirSync(resolve(this.#root, "runner"), { recursive: true, mode: 0o700 });
    const provider = this.options.provider ?? "codex";
    const runtimeContext = this.options.runtimeContext ?? null;
    const codexHome = resolve(this.#root, "codex-home");
    if (provider === "codex") {
      await prepareIsolatedCodexHome({
        context: runtimeContext,
        codexHome,
        sourceCodexHome: this.options.environment?.CODEX_HOME,
        nativeMcp: nativeMcpLaunchBinding(this.options.environment),
      });
    }
    const opencodeProxyPath =
      this.options.opencodeProxyPath ??
      fileURLToPath(
        new URL("../cli/opencode-app-server-proxy.js", import.meta.url),
      );
    const acpxSidecarPath =
      this.options.acpxSidecarPath ??
      fileURLToPath(new URL("../cli/acpx-runtime-sidecar.js", import.meta.url));
    this.#authorizedTools = authorizedToolSet(dynamicTools);
    const managed = this.options.managedProfile;
    const agentCore = this.options.agentCoreProfile;
    if (provider === "claude_managed" && managed === undefined) {
      throw new Error(
        "Claude Agent runner transport requires a managed profile snapshot",
      );
    }
    if (provider === "aws_agentcore" && agentCore === undefined) {
      throw new Error(
        "AWS AgentCore runner transport requires a qualified profile snapshot",
      );
    }
    const acpxAgent =
      provider === "acpx" ? (this.options.acpxAgent ?? "pi") : null;
    const requestedModel = typeof params.model === "string" ? params.model : "";
    const acpxProfile =
      provider === "acpx"
        ? resolveQualifiedAcpxProfile(acpxAgent!, requestedModel)
        : null;
    core.queueCommand("run.prepare", {
      authorizedTools: this.#authorizedTools,
      provider:
        provider === "claude_managed"
          ? {
              kind: "claude_managed",
              model: managed!.model,
              profileId: managed!.profileId,
              anthropicAgentId: managed!.anthropicAgentId,
              agentVersion: managed!.agentVersion,
              environmentId: managed!.environmentId,
              betaVersion: managed!.betaVersion,
              maxSessionListCostUsd: managed!.maxSessionListCostUsd,
              instructions: String(params.baseInstructions ?? "You are a Paperclip agent."),
              runtimeContext,
            }
          : provider === "aws_agentcore"
            ? {
                kind: "aws_agentcore",
                model: agentCore!.model,
                profileId: agentCore!.profileId,
                region: agentCore!.region,
                accountId: agentCore!.accountId,
                harnessArn: agentCore!.harnessArn,
                harnessVersion: agentCore!.harnessVersion,
                endpointArn: agentCore!.endpointArn,
                endpointQualifier: agentCore!.endpointQualifier,
                agentRuntimeArn: agentCore!.agentRuntimeArn,
                memoryArn: agentCore!.memoryArn,
                memoryId: agentCore!.memoryId,
                invocationRoleArn: agentCore!.invocationRoleArn,
                qualificationRevision: agentCore!.qualificationRevision,
                eventExpiryDays: agentCore!.eventExpiryDays,
                maxEstimatedSessionCostUsd:
                  agentCore!.maxEstimatedSessionCostUsd,
                maxIterations: agentCore!.maxIterations,
                maxOutputTokens: agentCore!.maxOutputTokens,
                timeoutSeconds: agentCore!.timeoutSeconds,
                instructions: String(params.baseInstructions ?? "You are a Paperclip agent."),
                runtimeContext,
              }
            : provider === "acpx"
              ? {
                  kind: "acpx",
                  agent: acpxProfile!.agent,
                  model: requestedModel,
                  acpxVersion: acpxProfile!.acpxVersion,
                  agentServerPackage: acpxProfile!.agentServerPackage,
                  agentServerVersion: acpxProfile!.agentServerVersion,
                  agentRuntimePackage: acpxProfile!.agentRuntimePackage,
                  agentRuntimeVersion: acpxProfile!.agentRuntimeVersion,
                  commandDigest: acpxProfile!.commandDigest,
                  sidecarCommand: process.execPath,
                  sidecarArgs: [acpxSidecarPath],
                  runtimeDirectory:
                    this.options.acpxRuntimeDirectory ??
                    resolve(this.#root, "acpx"),
                  normalizedSessionId: identity.normalizedSessionId,
                  runId: identity.runId,
                  cwd: String(params.cwd ?? tmpdir()),
                  instructions: String(
                    params.baseInstructions ?? "You are a Paperclip agent.",
                  ),
                  permissionPolicy: "interactive",
                  runtimeContext,
                }
              : {
                  kind: provider,
                  command:
                    provider === "opencode"
                      ? process.execPath
                      : (this.options.codexCommand ?? "codex"),
                  args:
                    provider === "opencode"
                      ? [opencodeProxyPath]
                      : (this.options.codexArgs ??
                        createIsolatedCodexAppServerArgs(
                          this.options.environment,
                          runtimeContext ? [codexHome, runtimeContext.instructions.bundle.rootPath, ...runtimeContext.skills.map((skill) => skill.bundle.rootPath)] : [],
                        )),
                  cwd: String(params.cwd ?? tmpdir()),
                  model: typeof params.model === "string" ? params.model : null,
                  instructions: String(
                    params.baseInstructions ?? "You are a Paperclip agent.",
                  ),
                  collaborationMode:
                    params.permissions ===
                    "paperclip-runner-workspace-read-only"
                      ? "plan"
                      : "default",
                  includeCollaborationModeInstructions:
                    provider === "codex" &&
                    record(params.config)
                      .include_collaboration_mode_instructions !== false,
                  includeSkillInstructions: provider === "codex" && runtimeContext !== null,
                  runtimeContext,
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
      lifecyclePolicy: this.options.lifecyclePolicy,
      runnerBinaryPath:
        this.options.runnerBinary ?? defaultCapabilityRunnerdBinary(),
      environment:
        provider === "opencode"
          ? {
              ...process.env,
              ...this.options.environment,
              PAPERCLIP_OPENCODE_COMMAND:
                this.options.opencodeCommand ?? "opencode",
              PAPERCLIP_OPENCODE_RUNTIME_DIR:
                this.options.opencodeRuntimeDirectory ??
                resolve(this.#root, "opencode"),
              PAPERCLIP_RUNNER_INSTANCE_ID: identity.runnerInstanceId,
              PAPERCLIP_RUN_ID: identity.runId,
              PAPERCLIP_NORMALIZED_SESSION_ID: identity.normalizedSessionId,
            }
          : provider === "acpx"
            ? {
                ...createSanitizedAcpxEnvironment(
                  this.options.environment,
                  acpxAgent!,
                ),
                PAPERCLIP_RUNNER_INSTANCE_ID: identity.runnerInstanceId,
                PAPERCLIP_RUN_ID: identity.runId,
                PAPERCLIP_NORMALIZED_SESSION_ID: identity.normalizedSessionId,
              }
            : provider === "claude_managed"
              ? createSanitizedClaudeManagedEnvironment(
                  this.options.environment,
                )
              : provider === "aws_agentcore"
                ? createSanitizedAwsAgentCoreEnvironment(
                    this.options.environment,
                  )
                : createSanitizedCodexEnvironment({ ...this.options.environment, HOME: codexHome, CODEX_HOME: codexHome }),
    });
    this.#handle = handle;
    this.#watchRunner(handle);
    this.#evidence.runnerPid = handle.child.pid ?? null;
    this.#evidence.runnerProcessGroupId = null;
    this.#publish();
    this.#pump = setInterval(() => this.#pumpEventsSafely(), 5);
    await this.#waitCommand("run.prepare");
    await this.#waitCommand("session.open");
    await this.#waitForProviderIdentity();
    this.#diagnostic("runnerd authenticated to the durable PRP control plane");
    return {
      thread: {
        id: this.#threadId,
        sessionId: this.#sessionId,
        model: params.model,
        modelProvider:
          provider === "claude_managed"
            ? "anthropic"
            : provider === "aws_agentcore"
              ? "amazon-bedrock"
              : provider === "opencode" && typeof params.model === "string"
                ? params.model.split("/", 1)[0]
                : provider === "acpx"
                  ? acpxAgent === "pi"
                    ? "openrouter"
                    : acpxAgent === "claude"
                      ? "anthropic"
                      : "openai"
                  : "openai",
      },
    };
  }

  async #resume(): Promise<void> {
    const desiredIdentity = this.options.prpIdentity;
    if (
      desiredIdentity === undefined ||
      !existsSync(resolve(this.#root, "runner", "runner-state.json"))
    ) {
      throw new Error("PRP provider resume state is unavailable");
    }
    const controlPlaneDirectory = resolve(this.#root, "control-plane");
    const identity = recoveredControlPlaneIdentity(
      controlPlaneDirectory,
      desiredIdentity,
    );
    this.#durableTurnId = identity.turnId;
    const attachingNewRun = identity.runId !== desiredIdentity.runId;
    const provider = this.options.provider ?? "codex";
    const codexHome = resolve(this.#root, "codex-home");
    if (provider === "codex") {
      await prepareIsolatedCodexHome({
        context: this.options.runtimeContext ?? null,
        codexHome,
        sourceCodexHome: this.options.environment?.CODEX_HOME,
        nativeMcp: nativeMcpLaunchBinding(this.options.environment),
      });
    }
    const core = new DurablePrpControlPlane({
      stateDirectory: controlPlaneDirectory,
      identity,
      onSemanticToolInput: async (call) =>
        unwrapToolResponse(
          await this.#handler({
            id: call.callId,
            method: "item/tool/call",
            params: {
              threadId: this.#threadId,
              turnId: this.#turnId,
              callId: call.callId,
              tool: call.operationId,
              arguments: call.input,
            },
          }),
        ),
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
      lifecyclePolicy: this.options.lifecyclePolicy,
      runnerBinaryPath:
        this.options.runnerBinary ?? defaultCapabilityRunnerdBinary(),
      environment:
        this.options.provider === "claude_managed"
          ? createSanitizedClaudeManagedEnvironment(this.options.environment)
          : this.options.provider === "aws_agentcore"
            ? createSanitizedAwsAgentCoreEnvironment(this.options.environment)
            : this.options.provider === "acpx"
              ? createSanitizedAcpxEnvironment(
                  this.options.environment,
                  this.options.acpxAgent ?? "pi",
                )
              : provider === "codex"
                ? createSanitizedCodexEnvironment({ ...this.options.environment, HOME: codexHome, CODEX_HOME: codexHome })
                : this.options.environment,
    });
    this.#handle = handle;
    this.#watchRunner(handle);
    this.#evidence.runnerPid = handle.child.pid ?? null;
    this.#evidence.runnerProcessGroupId = null;
    this.#publish();
    this.#pump = setInterval(() => this.#pumpEventsSafely(), 5);
    await this.#waitForProviderIdentity();
    if (
      attachingNewRun ||
      identity.turnId !== desiredIdentity.turnId ||
      identity.itemId !== desiredIdentity.itemId
    ) {
      const priorEvidenceSeq = core.store.state.ackedSourceSeq;
      const drainDeadline = Date.now() + 10_000;
      while (Date.now() < drainDeadline) {
        const durable = record(
          JSON.parse(
            readFileSync(
              resolve(this.#root, "runner", "runner-state.json"),
              "utf8",
            ),
          ),
        );
        if (Number(durable.ackedSourceSeq ?? 0) >= priorEvidenceSeq) break;
        this.#throwIfFailed();
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      const drained = record(
        JSON.parse(
          readFileSync(
            resolve(this.#root, "runner", "runner-state.json"),
            "utf8",
          ),
        ),
      );
      if (Number(drained.ackedSourceSeq ?? 0) < priorEvidenceSeq) {
        throw new Error(
          "runnerd did not drain prior-run evidence before attachment",
        );
      }
      await this.attachRun({
        runId: desiredIdentity.runId,
        turnId: desiredIdentity.turnId,
        itemId: desiredIdentity.itemId,
      });
    }
    this.#diagnostic(
      "runnerd restored its durable PRP session and provider thread",
    );
  }

  async #startTurn(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const input = Array.isArray(params.input) ? params.input.map(record) : [];
    const message = input
      .map((item) => (typeof item.text === "string" ? item.text : ""))
      .join("\n");
    const pendingTurnId = `turn_lab_${randomUUID().replaceAll("-", "")}`;
    this.#turnId = pendingTurnId;
    await this.#command("turn.start", { text: message });
    // Command completion only means runnerd accepted the command. Codex assigns
    // the authoritative turn identity in the subsequent turn/started event, so
    // do not expose the temporary transport identity to the strict driver.
    const deadline = Date.now() + 30_000;
    while (this.#turnId === pendingTurnId && Date.now() < deadline) {
      this.#throwIfFailed();
      this.#pumpEvents();
      if (this.#turnId !== pendingTurnId) break;
      if (this.#handle?.child.exitCode !== null)
        throw new Error("runnerd exited before provider turn startup");
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    if (this.#turnId === pendingTurnId)
      throw new Error("runnerd did not report the provider turn identity");
    return { turn: { id: this.#turnId, status: "inProgress" } };
  }

  async #command(
    type: string,
    payload: Record<string, unknown>,
    correlationId?: string,
  ): Promise<void> {
    const core = this.#core;
    if (core === null) throw new Error("PRP provider thread is not started");
    const commandId = correlationId
      ? `command_steer_${createHash("sha256")
          .update(`${this.#durableTurnId}:${correlationId}`)
          .digest("hex")
          .slice(0, 32)}`
      : `command_lab_${randomUUID().replaceAll("-", "")}`;
    const existing = core.store.state.commands.find(
      (command) => command.commandId === commandId,
    );
    if (existing) {
      if (
        existing.type !== type ||
        durableRecoveryInternals.canonicalJson(existing.payload) !==
          durableRecoveryInternals.canonicalJson(payload)
      ) {
        throw new Error(
          `PRP steering correlation ${correlationId} was reused with different content`,
        );
      }
    } else {
      core.queueCommand(type, payload, commandId, true);
    }
    await this.#waitCommand(type, commandId);
  }

  async #commandResult(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const core = this.#core;
    if (core === null) throw new Error("PRP provider thread is not started");
    const commandId = `command_lab_${randomUUID().replaceAll("-", "")}`;
    core.queueCommand(type, payload, commandId, true);
    await this.#waitCommand(type, commandId);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.#throwIfFailed();
      const event = core.store.state.committedEvents.find((candidate) => {
        if (candidate.eventType !== "provider.rpc_result") return false;
        return (
          record(record(candidate.envelope.payload).payload).commandId ===
          commandId
        );
      });
      const result = record(
        record(record(event?.envelope.payload).payload).result,
      );
      if (event !== undefined) return result;
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`PRP command ${type} omitted its provider result`);
  }

  async #waitForProviderIdentity(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.#throwIfFailed();
      this.#pumpEvents();
      if (
        this.#threadId.length > 0 &&
        (this.#evidence.providerExecutionKind === "remote_service" ||
          this.#evidence.providerPid !== null)
      )
        return;
      if (this.#handle?.child.exitCode !== null)
        throw new Error("runnerd exited before provider startup");
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error("runnerd did not report its provider identity");
  }

  async #waitCommand(type: string, commandId?: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      this.#throwIfFailed();
      const command = this.#core?.store.state.commands.find((candidate) =>
        commandId === undefined
          ? candidate.type === type
          : candidate.commandId === commandId,
      );
      if (command?.status === "completed") return;
      if (command !== undefined && command.status !== "pending") {
        throw new Error(
          `PRP command ${type} ${command.status}: ${JSON.stringify(command.result)}`,
        );
      }
      if (this.#handle?.child.exitCode !== null)
        throw new Error(`runnerd exited while waiting for ${type}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    throw new Error(`PRP command ${type} timed out`);
  }

  #pumpEvents(): void {
    this.#flushPendingTraceRehydrations();
    const events = this.#core?.store.state.committedEvents ?? [];
    while (this.#eventIndex < events.length) {
      const event = events[this.#eventIndex++];
      if (event.eventType === "harness.ready") {
        const started = record(record(event.envelope.payload).payload);
        const runtimeIdentity = record(started.runtimeIdentity);
        const descriptor = record(started.providerDescriptor);
        // Older durable snapshots serialized the enum fields in snake_case;
        // the provider descriptor is the canonical fallback during recovery.
        const pid =
          runtimeIdentity.processId ??
          runtimeIdentity.process_id ??
          descriptor.processId ??
          started.pid;
        const threadId = started.threadId;
        const sessionId = started.sessionId;
        if (typeof pid === "number") {
          this.#evidence.providerPid = pid;
          if (descriptor.driver === "acpx_runtime")
            this.#evidence.sidecarPid = pid;
          else this.#evidence.codexPid = pid;
        }
        if (typeof descriptor.driver === "string")
          this.#evidence.providerDriver = descriptor.driver;
        if (typeof descriptor.providerVersion === "string")
          this.#evidence.providerVersion = descriptor.providerVersion;
        if (
          descriptor.agent === "pi" ||
          descriptor.agent === "claude" ||
          descriptor.agent === "codex"
        )
          this.#evidence.acpxAgent = descriptor.agent;
        if (typeof descriptor.agentServerVersion === "string")
          this.#evidence.agentServerVersion = descriptor.agentServerVersion;
        if (typeof descriptor.agentRuntimeVersion === "string")
          this.#evidence.agentRuntimeVersion = descriptor.agentRuntimeVersion;
        if (typeof descriptor.acpProtocolVersion === "number")
          this.#evidence.acpProtocolVersion = descriptor.acpProtocolVersion;
        if (typeof descriptor.agentProcessId === "number")
          this.#evidence.agentPid = descriptor.agentProcessId;
        if (
          runtimeIdentity.executionKind === "local_process" ||
          runtimeIdentity.executionKind === "remote_service"
        ) {
          this.#evidence.providerExecutionKind = runtimeIdentity.executionKind;
        }
        if (runtimeIdentity.service === "anthropic_managed_agents") {
          this.#evidence.providerService = "anthropic_managed_agents";
        } else if (
          runtimeIdentity.service === "aws_bedrock_agentcore_harness"
        ) {
          this.#evidence.providerService = "aws_bedrock_agentcore_harness";
        }
        if (typeof threadId === "string") this.#threadId = threadId;
        if (typeof sessionId === "string") this.#sessionId = sessionId;
        this.#publish();
        continue;
      }
      if (event.eventType === "harness.diagnostic") {
        const diagnostic = record(record(event.envelope.payload).payload);
        if (
          diagnostic.providerMethod === "acpx/process" &&
          diagnostic.role === "acp_agent" &&
          typeof diagnostic.pid === "number"
        ) {
          this.#evidence.agentPid = diagnostic.pid;
          this.#publish();
        }
      }
      const eventPayload = record(event.envelope.payload).payload;
      const sessionUpdatePayload = record(eventPayload);
      const canonicalMethod = (
        {
          "turn.started": "turn/started",
          "item.started": "item/started",
          "item.delta": "item/agentMessage/delta",
          "item.completed": "item/completed",
          "turn.completed": "turn/completed",
          "turn.failed": "turn/completed",
          "turn.interrupted": "turn/completed",
          "turn.cancelled": "turn/completed",
          "usage.reported": "thread/tokenUsage/updated",
          "session.updated":
            sessionUpdatePayload.status === "budget_reached"
              ? "provider/budgetReached"
              : "provider/sessionUpdated",
        } as Record<string, string>
      )[event.eventType];
      const notifications =
        event.eventType === "provider.event"
          ? unwrapRunnerdProviderNotifications(eventPayload)
          : canonicalMethod
            ? [{ method: canonicalMethod, params: record(eventPayload) }]
            : [];
      for (const payload of notifications) {
        const method = payload.method;
        if (typeof method !== "string") continue;
        const rawParams = record(payload.params);
        const params =
          method === "thread/tokenUsage/updated"
            ? rehydrateRunnerdUsageNotification(
                rawParams,
                this.#threadId,
                this.#turnId,
              )
            : method === "turn/started" || method === "turn/completed"
              ? {
                  ...rawParams,
                  turnId: record(rawParams.turn).id ?? rawParams.turnId,
                }
              : rawParams;
        if (
          params.turnId === undefined &&
          typeof event.envelope.turnId === "string"
        ) {
          params.turnId = event.envelope.turnId;
        }
        const providerTurnId =
          method === "turn/started" || method === "turn/completed"
            ? (record(params.turn).id ?? params.turnId)
            : (params.turnId ?? record(params.turn).id);
        if (typeof providerTurnId === "string" && providerTurnId.length > 0) {
          this.#turnId = providerTurnId;
        }
        this.#queue.push({
          method,
          params,
          ...(this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH
            ? {
                paperclipTrace: {
                  sourceEventId: event.sourceEventId,
                  sourceEventType: event.eventType,
                },
              }
            : {}),
        });
      }
      if (this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH) {
        const pending = {
          sourceEventId: event.sourceEventId,
          eventType: event.eventType,
          visibleNotificationCount: notifications.length,
        };
        const traceResult = appendRunnerdRehydrationTrace(
          this.options.environment.PAPERCLIP_PROVIDER_TRACE_PATH,
          pending.sourceEventId,
          pending.eventType,
          pending.visibleNotificationCount,
          this.#nextTraceDebugSequence,
        );
        if (traceResult === "written") {
          this.#nextTraceDebugSequence += 1;
        } else if (
          traceResult === "retry" &&
          this.#pendingTraceRehydrations.length < 4_096
        ) {
          this.#pendingTraceRehydrations.push(pending);
        } else if (traceResult === "retry") {
          this.#traceRehydrationSpoolOverflow = true;
        }
      }
    }
  }

  #flushPendingTraceRehydrations(): void {
    const tracePath = this.options.environment?.PAPERCLIP_PROVIDER_TRACE_PATH;
    if (!tracePath) return;
    const retry: PendingTraceRehydration[] = [];
    for (const pending of this.#pendingTraceRehydrations) {
      const traceResult = appendRunnerdRehydrationTrace(
        tracePath,
        pending.sourceEventId,
        pending.eventType,
        pending.visibleNotificationCount,
        this.#nextTraceDebugSequence,
      );
      if (traceResult === "written") this.#nextTraceDebugSequence += 1;
      else if (traceResult === "retry") retry.push(pending);
    }
    this.#pendingTraceRehydrations = retry;

    const driverRetry: PendingDriverTraceInterpretation[] = [];
    for (const pending of this.#pendingDriverTraceInterpretations) {
      const traceResult = appendCodexDriverInterpretationTrace(
        tracePath,
        pending,
        this.#nextTraceDebugSequence,
      );
      if (traceResult === "written") this.#nextTraceDebugSequence += 1;
      else if (traceResult === "retry") driverRetry.push(pending);
    }
    this.#pendingDriverTraceInterpretations = driverRetry;
  }

  #pumpEventsSafely(): void {
    try {
      this.#pumpEvents();
    } catch (error) {
      this.#failTransport(
        new Error(
          `provider_transport_failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  #watchRunner(handle: RunnerProcessHandle): void {
    void handle.completion.then(
      (result) => {
        this.#evidence.runnerExited = true;
        this.#evidence.runnerExitCode = result.code;
        this.#evidence.runnerSignal = result.signal as NodeJS.Signals | null;
        const detail = result.stderr.trim() || result.stdout.trim();
        if (detail) this.#diagnostic(detail.slice(-4_096));
        this.#publish();
        if (this.#closed || this.#handle !== handle) return;
        const code = /provider_frame_too_large|stdout frame exceeded/i.test(
          detail,
        )
          ? "provider_frame_too_large"
          : "native_runner_process_exited";
        this.#failTransport(
          new Error(
            `${code}: runnerd exited unexpectedly${result.code === null ? "" : ` with code ${result.code}`}${detail ? `: ${detail.slice(-1_000)}` : ""}`,
          ),
        );
      },
      (error) => {
        if (this.#closed || this.#handle !== handle) return;
        this.#failTransport(
          new Error(
            `native_runner_process_exited: runnerd process failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      },
    );
  }

  #failTransport(error: Error): void {
    if (this.#failure !== null || this.#closed) return;
    this.#failure = error;
    if (this.#pump !== null) clearInterval(this.#pump);
    this.#pump = null;
    this.#diagnostic(error.message);
    this.#queue.close(error);
  }

  #throwIfFailed(): void {
    if (this.#failure !== null) throw this.#failure;
  }

  #diagnostic(message: string): void {
    this.#evidence.diagnostics.push(message);
    if (this.#evidence.diagnostics.length > 64)
      this.#evidence.diagnostics.shift();
    this.options.onDiagnostic?.(message);
    this.#publish();
  }

  #publish(): void {
    this.options.onEvidence?.(this.evidence());
  }
}

export function defaultCapabilityRunnerdBinary(): string {
  return resolve(
    packageRoot,
    `runner/target/debug/paperclip-runnerd${executableSuffix}`,
  );
}

/** Starts an authenticated durable PRP authority, runnerd, and Codex provider transport. */
export function createCapabilityRunnerdCodexTransport(
  options: CapabilityRunnerdCodexTransportOptions = {},
): CapabilityRunnerdCodexTransport {
  const transport = new DurablePrpCodexTransport(options);
  return { transport, evidence: () => transport.evidence() };
}

export const createRunnerdCodexTransport =
  createCapabilityRunnerdCodexTransport;
