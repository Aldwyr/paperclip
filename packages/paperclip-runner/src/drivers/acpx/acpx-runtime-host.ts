import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAcpRuntime,
  createAgentRegistry,
  createRuntimeStore,
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpRuntime,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeOptions,
  type AcpRuntimeStatus,
  type AcpRuntimeTurn,
} from "acpx/runtime";

import {
  startRunnerToolBridge,
  type RunnerToolBridge,
} from "../runner-tool-bridge.js";
import {
  resolveQualifiedAcpxProfile,
  type QualifiedAcpxAgent,
  type QualifiedAcpxProfile,
} from "./qualified-profiles.js";

const PI_PERMISSION_TOOL = "__paperclip_runtime_permission";

type DynamicToolHandler = (call: {
  tool: string;
  callId: string;
  arguments: unknown;
}) => Promise<unknown>;

export interface AcpxRuntimeProcessIdentity {
  pid: number;
  processGroupId: number | null;
  startedAt: string;
}

export interface AcpxRuntimeUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
  totalTokens?: number;
  cost?: { amount: number; currency: "USD" };
}

export interface AcpxRuntimePermissionContext {
  request: AcpPermissionRequest;
  signal: AbortSignal;
}

export type AcpxRuntimeFactory = (options: AcpRuntimeOptions) => AcpRuntime;

interface SecureAcpRuntimeOptions extends AcpRuntimeOptions {
  /** Paperclip's 0.13.1 patch: evaluated immediately before ACP child spawn. */
  spawnEnvironment?: () => Record<string, string>;
  /** Paperclip's 0.13.1 patch: never persisted in ACPX session records. */
  onAgentSpawn?: (meta: { pid: number; startedAt: string }) => Promise<void> | void;
  onAgentStderr?: (chunk: string) => void;
  spawnCwd?: string;
}

export interface AcpxRuntimeHostOptions {
  runtimeDirectory: string;
  normalizedSessionId: string;
  workingDirectory: string;
  agent: QualifiedAcpxAgent;
  model: string;
  expectedIdentity?: {
    kind: "acpx";
    normalizedSessionId: string;
    acpxRecordId: string;
    backendSessionId: string;
    agentSessionId: string;
    profileDigest: string;
    workspaceDigest: string;
    requestedModel: string;
    effectiveModel: string;
  };
  environment?: NodeJS.ProcessEnv;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler: DynamicToolHandler;
  runtimeFactory?: AcpxRuntimeFactory;
  onPermissionRequest?: (
    context: AcpxRuntimePermissionContext,
  ) => Promise<AcpPermissionDecision | undefined>;
  onSpawn?: (meta: AcpxRuntimeProcessIdentity) => Promise<void>;
  onUsage?: (usage: AcpxRuntimeUsage) => void;
  onDiagnostic?: (message: string) => void;
  /** Host-only source paths; neither paths nor contents enter ACPX records. */
  managedCredentialSources?: { codexAuthPath?: string };
}

export interface AcpxRuntimeIdentity {
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
  requestedModel: string;
  effectiveModel: string;
  profile: QualifiedAcpxProfile;
  commandPath: string;
  commandDigest: string;
}

export async function inspectQualifiedAcpxInstallation(
  agent: QualifiedAcpxAgent,
  model: string,
): Promise<{
  profile: QualifiedAcpxProfile;
  commandPath: string;
  commandDigest: string;
  agentRuntimePath: string | null;
}> {
  const profile = resolveQualifiedAcpxProfile(agent, model);
  const command = await resolveAndVerifyCommand(profile);
  return {
    profile,
    commandPath: command.path,
    commandDigest: command.digest,
    agentRuntimePath: agent === "pi" ? await resolvePiRuntimeCommand(profile) : null,
  };
}

export class AcpxRuntimeHost {
  readonly #runtime: AcpRuntime;
  readonly #handle: AcpRuntimeHandle;
  readonly #bridge: RunnerToolBridge;
  readonly #identity: AcpxRuntimeIdentity;
  readonly #root: string;
  readonly #ephemeralCredentialFiles: string[];
  readonly #agentProcessIdentity: AcpxRuntimeProcessIdentity | null;
  #activeTurn: AcpRuntimeTurn | null = null;
  #closed = false;

  private constructor(input: {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    bridge: RunnerToolBridge;
    identity: AcpxRuntimeIdentity;
    root: string;
    ephemeralCredentialFiles: string[];
    agentProcessIdentity: AcpxRuntimeProcessIdentity | null;
  }) {
    this.#runtime = input.runtime;
    this.#handle = input.handle;
    this.#bridge = input.bridge;
    this.#identity = input.identity;
    this.#root = input.root;
    this.#ephemeralCredentialFiles = input.ephemeralCredentialFiles;
    this.#agentProcessIdentity = input.agentProcessIdentity;
  }

  static async open(options: AcpxRuntimeHostOptions): Promise<AcpxRuntimeHost> {
    const profile = resolveQualifiedAcpxProfile(options.agent, options.model);
    const cwd = validateWorkspace(options.workingDirectory);
    const root = sessionRoot(options.runtimeDirectory, options.normalizedSessionId);
    const stateDir = join(root, "acpx-state");
    const homeDir = join(root, "home");
    const configDir = join(root, "config");
    const dataDir = join(root, "data");
    const cacheDir = join(root, "cache");
    const agentHome = join(root, `${options.agent}-home`);
    for (const directory of [root, stateDir, homeDir, configDir, dataDir, cacheDir, agentHome]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    if (options.expectedIdentity) {
      await verifyExpectedIdentity(options.expectedIdentity, root, options.normalizedSessionId, cwd, profile, options.model);
    }
    await writeFile(join(root, "workspace"), `${cwd}\n`, { mode: 0o600 });
    if (options.agent === "pi") {
      await writeFile(join(agentHome, "settings.json"), `${JSON.stringify({
        quietStartup: true,
        defaultProjectTrust: "never",
        enableInstallTelemetry: false,
      })}\n`, { mode: 0o600 });
    }
    const ephemeralCredentialFiles = options.agent === "codex"
      ? await stageManagedCodexCredential(agentHome, options)
      : [];

    const command = await resolveAndVerifyCommand(profile);
    const piCommand = options.agent === "pi" ? await resolvePiRuntimeCommand(profile) : null;
    const piExtension = fileURLToPath(new URL("./pi-paperclip-extension.js", import.meta.url));
    const piPermissionRules = new Set<string>();
    const bridge = await startRunnerToolBridge({
      tools: normalizeBridgeTools(options.dynamicTools ?? []),
      privateTools: options.agent === "pi" ? [{
        name: PI_PERMISSION_TOOL,
        description: "Runner-internal Pi permission gate.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["operation", "target", "inputClass"],
          properties: {
            operation: { enum: ["write", "edit", "bash"] },
            target: { type: ["string", "null"], maxLength: 4_096 },
            inputClass: { enum: ["workspace_mutation", "command"] },
          },
        },
      }] : [],
      handler: async (call) => {
        if (call.tool !== PI_PERMISSION_TOOL) return options.dynamicToolHandler(call);
        return requestPiPermission(options, call.callId, call.arguments, call.signal, piPermissionRules);
      },
    });
    const agentEnvironment = sanitizedAgentEnvironment(options.environment ?? process.env, {
      HOME: homeDir,
      XDG_CONFIG_HOME: configDir,
      XDG_DATA_HOME: dataDir,
      XDG_CACHE_HOME: cacheDir,
      ...(options.agent === "pi" ? {
        PI_CODING_AGENT_DIR: agentHome,
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        PI_ACP_PI_COMMAND: piCommand!,
        PI_ACP_PI_ARGS_JSON: JSON.stringify([
          "--no-extensions", "--extension", piExtension,
          "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
        ]),
        PAPERCLIP_RUNNER_BRIDGE_URL: bridge.url,
        PAPERCLIP_RUNNER_BRIDGE_TOKEN: bridge.secret,
        PAPERCLIP_WORKSPACE_ROOT: cwd,
        PAPERCLIP_RUNTIME_ROOT: root,
      } : {}),
      ...(options.agent === "claude" ? { CLAUDE_CONFIG_DIR: agentHome } : {}),
      ...(options.agent === "codex" ? { CODEX_HOME: agentHome } : {}),
      PAPERCLIP_ACPX_PROFILE: options.agent,
    }, options.agent);
    const safeSessionEnvironment = withoutCredentials(agentEnvironment);
    const mcpServers: NonNullable<AcpRuntimeOptions["mcpServers"]> = options.agent === "pi" ? [] : [{
      type: "http",
      name: "paperclip",
      url: bridge.url,
      headers: [{ name: "Authorization", value: `Bearer ${bridge.secret}` }],
    }];
    const routeAgentStderr = createAgentStderrRouter(
      agentEnvironment,
      options.onUsage,
      options.onDiagnostic,
    );
    let agentProcessIdentity: AcpxRuntimeProcessIdentity | null = null;
    const runtimeOptions: SecureAcpRuntimeOptions = {
      cwd,
      spawnCwd: cwd,
      sessionStore: createRuntimeStore({ stateDir }),
      agentRegistry: createAgentRegistry({
        overrides: { [options.agent]: [process.execPath, command.path] },
      }),
      mcpServers,
      permissionMode: "approve-reads",
      nonInteractivePermissions: "fail",
      permissionPolicy: {
        autoApprove: ["read", "search", "list"],
        escalate: ["execute", "write", "edit", "delete", "move"],
        defaultAction: "escalate",
      },
      elicitationModes: ["form", "url"],
      onPermissionRequest: async (request, context) => {
        // Claude Code asks its ACP client to authorize every MCP invocation,
        // including calls to Paperclip's own authenticated semantic bridge.
        // Those calls must reach PRP, whose attached run catalog and schema
        // checks are the authority. Treating this duplicate provider prompt as
        // a human approval prevents even read-only semantic tools from running.
        // Built-in filesystem/process calls do not have this closed namespace
        // and continue through the durable interactive permission flow.
        if (options.agent === "claude" && isRunnerOwnedSemanticPermission(request)) {
          return { outcome: "allow_once" };
        }
        return options.onPermissionRequest
          ? options.onPermissionRequest({ request, signal: context.signal })
          : { outcome: "reject_once" };
      },
      spawnEnvironment: () => ({ ...agentEnvironment }),
      onAgentStderr: routeAgentStderr,
      onAgentSpawn: async (meta) => {
        agentProcessIdentity = { pid: meta.pid, processGroupId: null, startedAt: meta.startedAt };
        await options.onSpawn?.(agentProcessIdentity);
      },
    };
    const runtimeFactory = options.runtimeFactory ?? ((input) => createAcpRuntime(input));
    const runtime = runtimeFactory(runtimeOptions);
    let handle: AcpRuntimeHandle | null = null;
    try {
      handle = await runtime.ensureSession({
        sessionKey: profileSessionKey(options.normalizedSessionId, cwd, profile, options.model),
        agent: options.agent,
        mode: "persistent",
        cwd,
        sessionOptions: {
          model: options.model,
          systemPrompt: { append: paperclipAcpSystemPrompt() },
          env: safeSessionEnvironment,
        },
      });
      const status = await requireVerifiedModel(runtime, handle, profile);
      const backendSessionId = requiredIdentity(status.backendSessionId ?? handle.backendSessionId, "backend session");
      const identity: AcpxRuntimeIdentity = {
        acpxRecordId: requiredIdentity(status.acpxRecordId ?? handle.acpxRecordId, "ACPX record"),
        backendSessionId,
        // ACPX 0.13.1 exposes the ACP protocol session as backendSessionId for
        // agents (including pi-acp) that do not advertise a second native
        // thread identity. Preserve that real ACP session identity explicitly
        // instead of inventing a random or Paperclip-owned identifier.
        agentSessionId: requiredIdentity(status.agentSessionId ?? handle.agentSessionId ?? backendSessionId, "agent session"),
        requestedModel: options.model,
        effectiveModel: requiredIdentity(status.models?.currentModelId, "effective model"),
        profile,
        commandPath: command.path,
        commandDigest: command.digest,
      };
      await writeFile(join(root, "identity.json"), `${JSON.stringify({
        acpxRecordId: identity.acpxRecordId,
        backendSessionId: identity.backendSessionId,
        agentSessionId: identity.agentSessionId,
        requestedModel: identity.requestedModel,
        effectiveModel: identity.effectiveModel,
        profileDigest: profile.commandDigest,
      }, null, 2)}\n`, { mode: 0o600 });
      return new AcpxRuntimeHost({
        runtime,
        handle,
        bridge,
        identity,
        root,
        ephemeralCredentialFiles,
        agentProcessIdentity,
      });
    } catch (error) {
      if (handle) {
        await runtime.close({ handle, reason: "ACPX startup failed", discardPersistentState: false }).catch(() => {});
      }
      await bridge.close().catch(() => {});
      await removeEphemeralCredentialFiles(ephemeralCredentialFiles);
      throw error;
    }
  }

  identity(): AcpxRuntimeIdentity {
    return structuredClone(this.#identity);
  }

  async status(): Promise<AcpRuntimeStatus> {
    if (!this.#runtime.getStatus) return {};
    return normalizeQualifiedModelStatus(
      await this.#runtime.getStatus({ handle: this.#handle }),
      this.#identity.profile,
    );
  }

  startTurn(input: { requestId: string; text: string; signal?: AbortSignal }): AcpRuntimeTurn {
    if (this.#closed) throw new Error("ACPX runtime host is closed");
    if (this.#activeTurn) throw new Error("ACPX runtime host already has an active turn");
    const turn = this.#runtime.startTurn({
      handle: this.#handle,
      text: input.text,
      mode: "prompt",
      requestId: input.requestId,
      signal: input.signal,
    });
    this.#activeTurn = turn;
    void turn.result.finally(() => {
      if (this.#activeTurn === turn) this.#activeTurn = null;
    });
    return turn;
  }

  async cancel(reason = "Paperclip turn interrupted"): Promise<void> {
    const turn = this.#activeTurn;
    if (turn) await turn.cancel({ reason });
    else await this.#runtime.cancel({ handle: this.#handle, reason });
  }

  async close(input: { reason: string; discardPersistentState?: boolean }): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#activeTurn?.cancel({ reason: input.reason }).catch(() => {});
    try {
      const discardPersistentState = input.discardPersistentState ?? false;
      try {
        await this.#runtime.close({
          handle: this.#handle,
          reason: input.reason,
          discardPersistentState,
        });
      } catch (error) {
        // Some qualified ACP agents (currently Pi) do not implement the
        // optional session/close control required for remote destruction.
        // Still close the live owner and descendants, but retain the provider
        // record rather than leaking a process or pretending it was deleted.
        if (!discardPersistentState || runtimeErrorCode(error) !== "ACP_BACKEND_UNSUPPORTED_CONTROL") {
          throw error;
        }
        await this.#runtime.close({
          handle: this.#handle,
          reason: `${input.reason} (retaining unsupported backend record)`,
          discardPersistentState: false,
        });
      }
    } finally {
      await this.#bridge.close().catch(() => {});
      await removeEphemeralCredentialFiles(this.#ephemeralCredentialFiles);
    }
  }

  runtimeRoot(): string { return this.#root; }

  processIdentity(): AcpxRuntimeProcessIdentity | null {
    return this.#agentProcessIdentity === null ? null : { ...this.#agentProcessIdentity };
  }
}

function runtimeErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  return typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

function isRunnerOwnedSemanticPermission(request: AcpPermissionRequest): boolean {
  const raw = request.raw as unknown as Record<string, unknown>;
  const toolCall = raw.toolCall;
  if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) return false;
  const call = toolCall as Record<string, unknown>;
  const meta = call._meta;
  const claudeCode = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>).claudeCode
    : null;
  const metadataToolName = claudeCode && typeof claudeCode === "object" && !Array.isArray(claudeCode)
    ? (claudeCode as Record<string, unknown>).toolName
    : null;
  return [call.name, call.title, metadataToolName].some((value) => (
    typeof value === "string" && value.startsWith("mcp__paperclip__")
  ));
}

async function stageManagedCodexCredential(
  agentHome: string,
  options: AcpxRuntimeHostOptions,
): Promise<string[]> {
  if (options.environment?.OPENAI_API_KEY || options.environment?.CODEX_API_KEY) return [];
  const source = options.managedCredentialSources?.codexAuthPath ?? join(homedir(), ".codex", "auth.json");
  let metadata;
  try {
    metadata = await stat(source);
  } catch {
    return [];
  }
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 256 * 1024) {
    throw new Error("Managed Codex credential source is not a bounded regular file");
  }
  const credential = await readFile(source);
  try {
    const parsed = JSON.parse(credential.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid credential document");
    }
  } catch {
    credential.fill(0);
    throw new Error("Managed Codex credential source is malformed");
  }
  const destination = join(agentHome, "auth.json");
  try {
    await writeFile(destination, credential, { mode: 0o600 });
    await chmod(destination, 0o600);
  } finally {
    credential.fill(0);
  }
  return [destination];
}

async function removeEphemeralCredentialFiles(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => rm(path, { force: true }).catch(() => {})));
}

async function verifyExpectedIdentity(
  expected: NonNullable<AcpxRuntimeHostOptions["expectedIdentity"]>,
  root: string,
  normalizedSessionId: string,
  cwd: string,
  profile: QualifiedAcpxProfile,
  model: string,
): Promise<void> {
  if (
    expected.normalizedSessionId !== normalizedSessionId
    || expected.profileDigest !== profile.commandDigest
    || expected.workspaceDigest !== workspaceDigest(cwd)
    || expected.requestedModel !== model
    || expected.effectiveModel !== model
  ) throw new Error("ACPX recovery identity conflicts with the immutable session configuration");
  let persisted: Record<string, unknown>;
  try {
    persisted = JSON.parse(await readFile(join(root, "identity.json"), "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("ACPX recovery identity record is missing or malformed");
  }
  if (
    persisted.acpxRecordId !== expected.acpxRecordId
    || persisted.backendSessionId !== expected.backendSessionId
    || persisted.agentSessionId !== expected.agentSessionId
    || persisted.profileDigest !== expected.profileDigest
    || persisted.requestedModel !== expected.requestedModel
    || persisted.effectiveModel !== expected.effectiveModel
  ) throw new Error("ACPX recovery identity does not match the persisted runtime record");
}

async function requireVerifiedModel(
  runtime: AcpRuntime,
  handle: AcpRuntimeHandle,
  profile: QualifiedAcpxProfile,
): Promise<AcpRuntimeStatus> {
  if (!runtime.getStatus) throw new Error("ACPX agent cannot verify its effective model");
  const requestedModel = profile.qualificationModel;
  let status = await runtime.getStatus({ handle });

  // A distinct reported selector is an explicit part of a pinned profile, not
  // a fuzzy alias. Re-apply the user's exact canonical model through ACP so a
  // stale/default session cannot be mistaken for the qualified model merely
  // because it currently reports the same selector.
  if (profile.reportedModelId !== requestedModel) {
    if (!runtime.setConfigOption) {
      throw new Error("ACPX agent cannot verify its canonical model through ACP config options");
    }
    await runtime.setConfigOption({ handle, key: "model", value: requestedModel });
    status = await runtime.getStatus({ handle });
  } else if (status.models?.currentModelId !== requestedModel && runtime.setConfigOption) {
    await runtime.setConfigOption({ handle, key: "model", value: requestedModel });
    status = await runtime.getStatus({ handle });
  }
  if (status.models?.currentModelId !== profile.reportedModelId) {
    throw new Error(
      `ACPX effective model mismatch: requested ${requestedModel}, expected ACP selector ${profile.reportedModelId}, received ${status.models?.currentModelId ?? "unverified"}`,
    );
  }
  return normalizeQualifiedModelStatus(status, profile);
}

function normalizeQualifiedModelStatus(
  status: AcpRuntimeStatus,
  profile: QualifiedAcpxProfile,
): AcpRuntimeStatus {
  if (status.models?.currentModelId !== profile.reportedModelId) return status;
  return {
    ...status,
    models: {
      ...status.models,
      currentModelId: profile.qualificationModel,
      availableModelIds: status.models.availableModelIds.map((modelId) => (
        modelId === profile.reportedModelId ? profile.qualificationModel : modelId
      )),
    },
  };
}

async function resolveAndVerifyCommand(profile: QualifiedAcpxProfile): Promise<{ path: string; digest: string }> {
  const packageJsonPath = resolvePackageJson(profile.agentServerPackage);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (packageJson.version !== profile.agentServerVersion) {
    throw new Error(
      `ACPX ${profile.agent} package version mismatch: expected ${profile.agentServerVersion}, received ${packageJson.version ?? "unknown"}`,
    );
  }
  const relativeBin = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.[Object.keys(packageJson.bin)[0] ?? ""];
  if (!relativeBin) throw new Error(`ACPX ${profile.agent} package does not expose an executable`);
  const path = resolve(dirname(packageJsonPath), relativeBin);
  const digest = `sha256:${createHash("sha256").update(await readFile(path)).digest("hex")}`;
  if (digest !== profile.commandDigest) {
    throw new Error(`ACPX ${profile.agent} executable digest does not match the qualified profile`);
  }
  return { path, digest };
}

async function resolvePiRuntimeCommand(profile: QualifiedAcpxProfile): Promise<string> {
  if (!profile.agentRuntimePackage || !profile.agentRuntimeVersion) {
    throw new Error("Qualified Pi profile omitted its harness runtime");
  }
  const packageJsonPath = resolvePackageJsonFromEntrypoint(profile.agentRuntimePackage);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    version?: string;
    bin?: string | Record<string, string>;
  };
  if (packageJson.version !== profile.agentRuntimeVersion) {
    throw new Error(`Pi runtime version mismatch: expected ${profile.agentRuntimeVersion}`);
  }
  const relativeBin = typeof packageJson.bin === "string"
    ? packageJson.bin
    : packageJson.bin?.pi;
  if (!relativeBin) throw new Error("Qualified Pi runtime does not expose the pi executable");
  return resolve(dirname(packageJsonPath), relativeBin);
}

function resolvePackageJson(packageName: string): string {
  return createRequire(import.meta.url).resolve(`${packageName}/package.json`);
}

function resolvePackageJsonFromEntrypoint(packageName: string): string {
  // The qualified Pi runtime intentionally has no package root export. It is
  // a direct dependency of this package, so resolve its owned installation
  // relative to both source and built driver locations without consulting PATH.
  return fileURLToPath(new URL(`../../../node_modules/${packageName}/package.json`, import.meta.url));
}

async function requestPiPermission(
  options: AcpxRuntimeHostOptions,
  callId: string,
  input: unknown,
  signal: AbortSignal,
  acceptedRules: Set<string>,
): Promise<{ decision: "accept" | "accept_for_session" | "decline" | "cancel" }> {
  const value = input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const operation = value.operation === "write" || value.operation === "edit" || value.operation === "bash"
    ? value.operation
    : "unknown";
  const target = typeof value.target === "string" ? value.target.slice(0, 4_096) : null;
  const rule = JSON.stringify({ operation, target });
  if (acceptedRules.has(rule)) return { decision: "accept_for_session" };
  if (!options.onPermissionRequest || signal.aborted) return { decision: "cancel" };
  const inferredKind = operation === "bash" ? "execute" : "edit";
  const decision = await options.onPermissionRequest({
    request: {
      sessionId: options.normalizedSessionId,
      inferredKind,
      raw: {
        sessionId: options.normalizedSessionId,
        toolCall: {
          toolCallId: callId,
          kind: inferredKind,
          status: "pending",
          title: operation === "bash"
            ? "Allow Pi to run a command in the workspace?"
            : `Allow Pi to ${operation} ${target ?? "a workspace file"}?`,
        },
        options: [
          { optionId: "accept", name: "Allow once", kind: "allow_once" },
          { optionId: "accept_for_session", name: "Allow for this session", kind: "allow_always" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
      },
    },
    signal,
  });
  if (decision?.outcome === "allow_always") {
    acceptedRules.add(rule);
    return { decision: "accept_for_session" };
  }
  if (decision?.outcome === "allow_once") return { decision: "accept" };
  if (decision?.outcome === "cancel") return { decision: "cancel" };
  return { decision: "decline" };
}

function sanitizedAgentEnvironment(
  source: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  agent: QualifiedAcpxAgent,
): Record<string, string> {
  const allowedExact = new Set([
    "PATH", "LANG", "LANGUAGE", "TZ", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  ]);
  const credentialNames = agent === "pi"
    ? ["OPENROUTER_API_KEY"]
    : agent === "claude"
      ? ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]
      : ["OPENAI_API_KEY", "CODEX_API_KEY"];
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!value) continue;
    if (allowedExact.has(key) || key.startsWith("LC_") || credentialNames.includes(key)) {
      environment[key] = value;
    }
  }
  Object.assign(environment, overrides);
  return environment;
}

function withoutCredentials(environment: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)$/i.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

function redactDiagnostic(
  value: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  let redacted = value;
  for (const [key, secret] of Object.entries(environment)) {
    if (!secret || !/(?:KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)$/i.test(key) || secret.length < 4) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted.replace(/(key|token|secret|password|authorization)\s*[:=]\s*[^\s,}\]]+/gi, "$1=[REDACTED]").slice(-8_192);
}

function sessionRoot(runtimeDirectory: string, normalizedSessionId: string): string {
  const safe = normalizedSessionId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  if (!safe || safe === "." || safe === "..") throw new Error("Invalid normalized ACPX session id");
  return join(resolve(runtimeDirectory), "acpx", safe);
}

function workspaceDigest(cwd: string): string {
  return `sha256:${createHash("sha256").update(resolve(cwd)).digest("hex")}`;
}

function validateWorkspace(value: string): string {
  const cwd = resolve(value);
  if (!value.trim() || cwd === dirname(cwd)) throw new Error("ACPX working directory must not be a filesystem root");
  return cwd;
}

function profileSessionKey(
  normalizedSessionId: string,
  cwd: string,
  profile: QualifiedAcpxProfile,
  model: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      normalizedSessionId,
      cwd,
      agent: profile.agent,
      model,
      reportedModelId: profile.reportedModelId,
      commandDigest: profile.commandDigest,
      driverKind: profile.driverKind,
      protocolVersion: profile.protocolVersion,
    }))
    .digest("hex");
  return `paperclip-${digest}`;
}

function requiredIdentity(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} identity is missing`);
  return value;
}

const PI_USAGE_PREFIX = "[paperclip-pi-usage-v1]";

function createAgentStderrRouter(
  environment: NodeJS.ProcessEnv,
  onUsage?: (usage: AcpxRuntimeUsage) => void,
  onDiagnostic?: (message: string) => void,
): (chunk: string) => void {
  let pending = "";
  return (chunk) => {
    pending = `${pending}${chunk}`.slice(-128 * 1024);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith(PI_USAGE_PREFIX)) {
        const usage = parsePiUsage(line.slice(PI_USAGE_PREFIX.length));
        if (usage) onUsage?.(usage);
        else onDiagnostic?.("Pi emitted a malformed bounded usage notification.");
        continue;
      }
      if (line) onDiagnostic?.(redactDiagnostic(line, environment));
    }
  };
}

function parsePiUsage(serialized: string): AcpxRuntimeUsage | null {
  if (Buffer.byteLength(serialized) > 8 * 1024) return null;
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    const usage: AcpxRuntimeUsage = {};
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cachedReadTokens",
      "cachedWriteTokens",
      "thoughtTokens",
      "totalTokens",
    ] as const) {
      const amount = value[key];
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) usage[key] = amount;
    }
    const cost = value.cost;
    if (typeof cost === "object" && cost !== null && !Array.isArray(cost)) {
      const amount = (cost as Record<string, unknown>).amount;
      if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) {
        usage.cost = { amount, currency: "USD" };
      }
    }
    return Object.keys(usage).length > 0 ? usage : null;
  } catch {
    return null;
  }
}

function paperclipAcpSystemPrompt(): string {
  return [
    "You are running inside Paperclip Runner.",
    "Use only the semantic Paperclip tools made available for the attached run.",
    "Work only inside the supplied workspace.",
    "Do not discover user or project skills, plugins, MCP servers, prompts, or configuration.",
    "Finish through paperclip_finish or paperclip_block exactly once.",
  ].join("\n");
}

/** PRP names semantic tools by operationId; MCP and Pi name them `name`. */
function normalizeBridgeTools(
  tools: readonly Readonly<Record<string, unknown>>[],
): Array<Readonly<Record<string, unknown>>> {
  return tools.map((tool) => ({
    name: typeof tool.name === "string" ? tool.name : tool.operationId,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

export type { AcpRuntimeEvent, AcpRuntimeTurn, AcpRuntimeStatus };
