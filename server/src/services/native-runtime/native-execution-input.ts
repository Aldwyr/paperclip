import type {
  NativeExecutionInputV1,
  NativeInteractionResponseEnvelope,
  StrictCompletionContractInput,
} from "../../vendor/paperclip-runner/index.js";
import { parseNativeExecutionInput } from "../../vendor/paperclip-runner/index.js";

/** Closed constructor: callers cannot spread legacy context or environment data. */
export function buildNativeExecutionInput(input: {
  companyId: string;
  runId: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    description: string | null;
    workMode: string;
  };
  taskPrompt: string;
  agentId: string;
  workspace: {
    id: string;
    cwd: string;
    repoUrl: string | null;
    repoRef: string | null;
    branchName: string | null;
  };
  normalizedSessionId: string | null;
  provider?: "codex" | "opencode" | "claude_managed";
  model?: string | null;
  managedProfile?: {
    profileId: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: "managed-agents-2026-04-01";
  };
  maxSessionListCostUsd?: number;
  lifecyclePolicy?: NativeExecutionInputV1["session"]["lifecyclePolicy"];
  interactionResponses?: NativeInteractionResponseEnvelope[];
  completionContract: {
    id: string;
    sha256: string;
    schemaVersion: string;
    contract: StrictCompletionContractInput;
  };
}): NativeExecutionInputV1 {
  if (input.issue.workMode !== "standard") {
    throw new Error("native_execution_input_invalid: issue work mode must be standard");
  }
  return parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v1",
    binding: {
      companyId: input.companyId,
      runId: input.runId,
      issueId: input.issue.id,
      agentId: input.agentId,
      executionWorkspaceId: input.workspace.id,
    },
    task: {
      identifier: input.issue.identifier ?? input.issue.id,
      title: input.issue.title,
      description: input.issue.description,
      prompt: input.taskPrompt,
      workMode: "standard",
    },
    workspace: {
      cwd: input.workspace.cwd,
      repoUrl: input.workspace.repoUrl,
      repoRef: input.workspace.repoRef,
      branchName: input.workspace.branchName,
    },
    session: {
      normalizedSessionId: input.normalizedSessionId,
      driverKind: input.provider === "opencode"
        ? "opencode_server"
        : input.provider === "claude_managed"
          ? "claude_managed_agents_api"
          : "codex_app_server",
      protocolVersion: 1,
      lifecyclePolicy: input.lifecyclePolicy ?? { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: input.provider === "claude_managed" ? {
      kind: "claude_managed",
      model: input.model,
      managedProfile: input.managedProfile,
      maxSessionListCostUsd: input.maxSessionListCostUsd,
    } : {
      kind: input.provider ?? "codex",
      model: input.model ?? null,
    },
    completionContract: input.completionContract,
    interactionResponses: input.interactionResponses ?? [],
    credentialBindings: [],
  });
}
