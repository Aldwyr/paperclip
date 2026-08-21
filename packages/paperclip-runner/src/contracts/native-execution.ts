import type { PrpStructuredRunResult, PrpTerminalState } from "../protocol/replay-contract.js";

export const NATIVE_EXECUTION_INPUT_SCHEMA = "paperclip.native-execution-input.v1" as const;
export const NATIVE_MODEL_ENVELOPE_SCHEMA = "paperclip.native-model-envelope.v1" as const;

export interface StrictCompletionContractInput {
  revision: string;
  objective: string;
  criteria: Array<{ id: string; requirement: string }>;
}

export interface NativeInteractionResponseEnvelope {
  interactionId: string;
  kind: "request_confirmation" | "ask_user_questions";
  response: Record<string, unknown>;
}

export interface NativeCredentialBindingRef {
  bindingId: string;
  service: string;
  destination: string;
  expiresAt: string | null;
  displayName: string | null;
}

export type NativeSessionLifecyclePolicy =
  | { mode: "per_turn"; idleTimeoutMs: null }
  | { mode: "warm"; idleTimeoutMs: number };

export interface NativeManagedAgentProfileSnapshot {
  profileId: string;
  anthropicAgentId: string;
  agentVersion: string;
  environmentId: string;
  betaVersion: "managed-agents-2026-04-01";
}

export type NativeProviderConfig =
  | { kind: "codex"; model: string | null }
  | { kind: "opencode"; model: string }
  | {
      kind: "claude_managed";
      model: string;
      managedProfile: NativeManagedAgentProfileSnapshot;
      maxSessionListCostUsd: number;
    };

export interface NativeExecutionInputV1 {
  schema: typeof NATIVE_EXECUTION_INPUT_SCHEMA;
  binding: {
    companyId: string;
    runId: string;
    issueId: string;
    agentId: string;
    executionWorkspaceId: string;
  };
  task: {
    identifier: string;
    title: string;
    description: string | null;
    /** Redacted, server-authored task markdown including the current wake comment. */
    prompt: string;
    workMode: "standard";
  };
  workspace: {
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  session: {
    normalizedSessionId: string | null;
    driverKind: "codex_app_server" | "opencode_server" | "claude_managed_agents_api";
    protocolVersion: 1;
    lifecyclePolicy: NativeSessionLifecyclePolicy;
  };
  provider: NativeProviderConfig;
  completionContract: {
    id: string;
    sha256: string;
    schemaVersion: string;
    contract: StrictCompletionContractInput;
  };
  interactionResponses: NativeInteractionResponseEnvelope[];
  credentialBindings: NativeCredentialBindingRef[];
}

/** The only task data that may enter provider-visible model input. */
export interface NativeModelEnvelopeV1 {
  schema: typeof NATIVE_MODEL_ENVELOPE_SCHEMA;
  task: NativeExecutionInputV1["task"];
  /** Remote providers have no Paperclip workspace mounted in their service. */
  workspace: Pick<NativeExecutionInputV1["workspace"], "cwd"> | null;
  completionContract: StrictCompletionContractInput;
  interactionResponses: NativeInteractionResponseEnvelope[];
}

export interface NativeSessionExecutionResult {
  result: PrpStructuredRunResult;
  terminal: PrpTerminalState;
  turnId: string | null;
  normalizedSessionId: string;
  providerSessionId: string | null;
  driverKind: string;
  driverVersion: string;
  nativeEventCount: number;
  highestContiguousSourceSeq: number;
  usage: Record<string, unknown> | null;
}

export class NativeExecutionInputError extends Error {
  readonly code = "native_execution_input_invalid" as const;

  constructor(message: string) {
    super(message);
    this.name = "NativeExecutionInputError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeExecutionInputError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new NativeExecutionInputError(`${path} contains unknown field ${unknown[0]}`);
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new NativeExecutionInputError(`${path} must be a non-empty string`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

/**
 * Strictly validates the closed Paperclip-to-runner launch contract. This is
 * intentionally not an extensible metadata bag: new fields require a contract
 * revision and an explicit security review.
 */
export function parseNativeExecutionInput(value: unknown): NativeExecutionInputV1 {
  const input = record(value, "input");
  exactKeys(input, [
    "schema",
    "binding",
    "task",
    "workspace",
    "session",
    "provider",
    "completionContract",
    "interactionResponses",
    "credentialBindings",
  ], "input");
  if (input.schema !== NATIVE_EXECUTION_INPUT_SCHEMA) {
    throw new NativeExecutionInputError(`input.schema must be ${NATIVE_EXECUTION_INPUT_SCHEMA}`);
  }

  const binding = record(input.binding, "input.binding");
  exactKeys(binding, ["companyId", "runId", "issueId", "agentId", "executionWorkspaceId"], "input.binding");
  const task = record(input.task, "input.task");
  exactKeys(task, ["identifier", "title", "description", "prompt", "workMode"], "input.task");
  const workspace = record(input.workspace, "input.workspace");
  exactKeys(workspace, ["cwd", "repoUrl", "repoRef", "branchName"], "input.workspace");
  const session = record(input.session, "input.session");
  exactKeys(session, ["normalizedSessionId", "driverKind", "protocolVersion", "lifecyclePolicy"], "input.session");
  const completionContract = record(input.completionContract, "input.completionContract");
  exactKeys(completionContract, ["id", "sha256", "schemaVersion", "contract"], "input.completionContract");
  const contract = record(completionContract.contract, "input.completionContract.contract");
  exactKeys(contract, ["revision", "objective", "criteria"], "input.completionContract.contract");

  if (task.workMode !== "standard") throw new NativeExecutionInputError("input.task.workMode must be standard");
  if (
    (
      session.driverKind !== "codex_app_server"
      && session.driverKind !== "opencode_server"
      && session.driverKind !== "claude_managed_agents_api"
    )
    || session.protocolVersion !== 1
  ) {
    throw new NativeExecutionInputError("input.session must select a supported protocol version 1 driver");
  }
  const lifecyclePolicyValue = session.lifecyclePolicy === undefined
    ? { mode: "per_turn", idleTimeoutMs: null }
    : record(session.lifecyclePolicy, "input.session.lifecyclePolicy");
  exactKeys(lifecyclePolicyValue, ["mode", "idleTimeoutMs"], "input.session.lifecyclePolicy");
  let lifecyclePolicy: NativeSessionLifecyclePolicy;
  if (lifecyclePolicyValue.mode === "per_turn") {
    if (lifecyclePolicyValue.idleTimeoutMs !== null) {
      throw new NativeExecutionInputError("input.session.lifecyclePolicy.idleTimeoutMs must be null for per_turn");
    }
    lifecyclePolicy = { mode: "per_turn", idleTimeoutMs: null };
  } else if (lifecyclePolicyValue.mode === "warm") {
    if (!Number.isSafeInteger(lifecyclePolicyValue.idleTimeoutMs) || Number(lifecyclePolicyValue.idleTimeoutMs) <= 0) {
      throw new NativeExecutionInputError("input.session.lifecyclePolicy.idleTimeoutMs must be a positive integer for warm");
    }
    lifecyclePolicy = { mode: "warm", idleTimeoutMs: Number(lifecyclePolicyValue.idleTimeoutMs) };
  } else {
    throw new NativeExecutionInputError("input.session.lifecyclePolicy.mode must be per_turn or warm");
  }
  const provider = input.provider === undefined
    ? { kind: "codex", model: null }
    : record(input.provider, "input.provider");
  if (provider.kind !== "codex" && provider.kind !== "opencode" && provider.kind !== "claude_managed") {
    throw new NativeExecutionInputError("input.provider.kind must be codex, opencode, or claude_managed");
  }
  exactKeys(
    provider,
    provider.kind === "claude_managed"
      ? ["kind", "model", "managedProfile", "maxSessionListCostUsd"]
      : ["kind", "model"],
    "input.provider",
  );
  if (
    (provider.kind === "codex" && session.driverKind !== "codex_app_server")
    || (provider.kind === "opencode" && session.driverKind !== "opencode_server")
    || (provider.kind === "claude_managed" && session.driverKind !== "claude_managed_agents_api")
  ) {
    throw new NativeExecutionInputError("input.provider.kind does not match input.session.driverKind");
  }
  const providerModel = provider.model === null || provider.model === undefined
    ? null
    : text(provider.model, "input.provider.model");
  if (provider.kind === "opencode" && (providerModel === null || !providerModel.includes("/"))) {
    throw new NativeExecutionInputError("input.provider.model is required for opencode in provider/model form");
  }
  let parsedProvider: NativeProviderConfig;
  if (provider.kind === "claude_managed") {
    if (providerModel === null) {
      throw new NativeExecutionInputError("input.provider.model is required for claude_managed");
    }
    const managedProfile = record(provider.managedProfile, "input.provider.managedProfile");
    exactKeys(
      managedProfile,
      ["profileId", "anthropicAgentId", "agentVersion", "environmentId", "betaVersion"],
      "input.provider.managedProfile",
    );
    if (managedProfile.betaVersion !== "managed-agents-2026-04-01") {
      throw new NativeExecutionInputError(
        "input.provider.managedProfile.betaVersion must be managed-agents-2026-04-01",
      );
    }
    if (
      typeof provider.maxSessionListCostUsd !== "number"
      || !Number.isFinite(provider.maxSessionListCostUsd)
      || provider.maxSessionListCostUsd <= 0
    ) {
      throw new NativeExecutionInputError("input.provider.maxSessionListCostUsd must be a positive finite number");
    }
    parsedProvider = {
      kind: "claude_managed",
      model: providerModel,
      managedProfile: {
        profileId: text(managedProfile.profileId, "input.provider.managedProfile.profileId"),
        anthropicAgentId: text(
          managedProfile.anthropicAgentId,
          "input.provider.managedProfile.anthropicAgentId",
        ),
        agentVersion: text(managedProfile.agentVersion, "input.provider.managedProfile.agentVersion"),
        environmentId: text(managedProfile.environmentId, "input.provider.managedProfile.environmentId"),
        betaVersion: "managed-agents-2026-04-01",
      },
      maxSessionListCostUsd: provider.maxSessionListCostUsd,
    };
  } else if (provider.kind === "opencode") {
    parsedProvider = { kind: "opencode", model: providerModel! };
  } else {
    parsedProvider = { kind: "codex", model: providerModel };
  }
  if (!Array.isArray(contract.criteria) || contract.criteria.length === 0) {
    throw new NativeExecutionInputError("input.completionContract.contract.criteria must not be empty");
  }
  const criteria = contract.criteria.map((entry, index) => {
    const criterion = record(entry, `input.completionContract.contract.criteria[${index}]`);
    exactKeys(criterion, ["id", "requirement"], `input.completionContract.contract.criteria[${index}]`);
    return { id: text(criterion.id, `criteria[${index}].id`), requirement: text(criterion.requirement, `criteria[${index}].requirement`) };
  });

  if (!Array.isArray(input.interactionResponses) || !Array.isArray(input.credentialBindings)) {
    throw new NativeExecutionInputError("interactionResponses and credentialBindings must be arrays");
  }
  const interactionResponses = input.interactionResponses.map((entry, index) => {
    const response = record(entry, `input.interactionResponses[${index}]`);
    exactKeys(response, ["interactionId", "kind", "response"], `input.interactionResponses[${index}]`);
    if (response.kind !== "request_confirmation" && response.kind !== "ask_user_questions") {
      throw new NativeExecutionInputError(`input.interactionResponses[${index}].kind is unsupported`);
    }
    const kind: NativeInteractionResponseEnvelope["kind"] = response.kind;
    return {
      interactionId: text(response.interactionId, `input.interactionResponses[${index}].interactionId`),
      kind,
      response: structuredClone(record(response.response, `input.interactionResponses[${index}].response`)),
    };
  });
  const credentialBindings = input.credentialBindings.map((entry, index) => {
    const bindingRef = record(entry, `input.credentialBindings[${index}]`);
    exactKeys(bindingRef, ["bindingId", "service", "destination", "expiresAt", "displayName"], `input.credentialBindings[${index}]`);
    return {
      bindingId: text(bindingRef.bindingId, `credentialBindings[${index}].bindingId`),
      service: text(bindingRef.service, `credentialBindings[${index}].service`),
      destination: text(bindingRef.destination, `credentialBindings[${index}].destination`),
      expiresAt: nullableText(bindingRef.expiresAt, `credentialBindings[${index}].expiresAt`),
      displayName: nullableText(bindingRef.displayName, `credentialBindings[${index}].displayName`),
    };
  });

  return {
    schema: NATIVE_EXECUTION_INPUT_SCHEMA,
    binding: {
      companyId: text(binding.companyId, "input.binding.companyId"),
      runId: text(binding.runId, "input.binding.runId"),
      issueId: text(binding.issueId, "input.binding.issueId"),
      agentId: text(binding.agentId, "input.binding.agentId"),
      executionWorkspaceId: text(binding.executionWorkspaceId, "input.binding.executionWorkspaceId"),
    },
    task: {
      identifier: text(task.identifier, "input.task.identifier"),
      title: text(task.title, "input.task.title"),
      description: nullableText(task.description, "input.task.description"),
      // `prompt` was added after native run inputs were already persisted.
      // Recovery must retain those runs, so derive the same bounded model
      // prompt from their task fields instead of making them unrecoverable.
      prompt: text(task.prompt ?? task.description ?? task.title, "input.task.prompt"),
      workMode: "standard",
    },
    workspace: {
      cwd: text(workspace.cwd, "input.workspace.cwd"),
      repoUrl: nullableText(workspace.repoUrl, "input.workspace.repoUrl"),
      repoRef: nullableText(workspace.repoRef, "input.workspace.repoRef"),
      branchName: nullableText(workspace.branchName, "input.workspace.branchName"),
    },
    session: {
      normalizedSessionId: nullableText(session.normalizedSessionId, "input.session.normalizedSessionId"),
      driverKind: session.driverKind,
      protocolVersion: 1,
      lifecyclePolicy,
    },
    provider: parsedProvider,
    completionContract: {
      id: text(completionContract.id, "input.completionContract.id"),
      sha256: text(completionContract.sha256, "input.completionContract.sha256"),
      schemaVersion: text(completionContract.schemaVersion, "input.completionContract.schemaVersion"),
      contract: {
        revision: text(contract.revision, "input.completionContract.contract.revision"),
        objective: text(contract.objective, "input.completionContract.contract.objective"),
        criteria,
      },
    },
    interactionResponses,
    credentialBindings,
  };
}

export function buildNativeModelEnvelope(input: NativeExecutionInputV1): NativeModelEnvelopeV1 {
  return {
    schema: NATIVE_MODEL_ENVELOPE_SCHEMA,
    task: structuredClone(input.task),
    workspace: input.provider.kind === "claude_managed" ? null : { cwd: input.workspace.cwd },
    completionContract: structuredClone(input.completionContract.contract),
    interactionResponses: structuredClone(input.interactionResponses),
  };
}
