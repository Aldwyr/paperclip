import type {
  NativeAcpxAgent,
  NativeExecutionInputV2,
  NativeInteractionResponseEnvelope,
  NativePlanningContext,
  StrictCompletionContractInput,
} from "../../vendor/paperclip-runner/index.js";
import {
  parseNativeExecutionInput,
  resolveQualifiedAcpxProfile,
} from "../../vendor/paperclip-runner/index.js";

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
  provider?: "codex" | "opencode" | "claude_managed" | "aws_agentcore" | "acpx";
  acpxAgent?: NativeAcpxAgent;
  model?: string | null;
  managedProfile?: {
    profileId: string;
    anthropicAgentId: string;
    agentVersion: string;
    environmentId: string;
    betaVersion: "managed-agents-2026-04-01";
  };
  maxSessionListCostUsd?: number;
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
  };
  maxEstimatedSessionCostUsd?: number;
  invocationLimits?: { maxIterations: number; maxOutputTokens: number; timeoutSeconds: number };
  lifecyclePolicy?: NativeExecutionInputV2["session"]["lifecyclePolicy"];
  executionMode?: "default" | "plan";
  planningContext?: NativePlanningContext | null;
  interactionResponses?: NativeInteractionResponseEnvelope[];
  completionContract: {
    id: string;
    sha256: string;
    schemaVersion: string;
    contract: StrictCompletionContractInput;
  };
}): NativeExecutionInputV2 {
  if (input.issue.workMode !== "standard" && input.issue.workMode !== "planning") {
    throw new Error("native_execution_input_invalid: issue work mode must be standard or planning");
  }
  const executionMode = input.executionMode
    ?? (input.issue.workMode === "planning" ? "plan" : "default");
  const acpxProfile = input.provider === "acpx"
    ? resolveQualifiedAcpxProfile(
        input.acpxAgent ?? "pi",
        input.model ?? "",
      )
    : null;
  return parseNativeExecutionInput({
    schema: "paperclip.native-execution-input.v2",
    executionMode,
    planningContext: input.planningContext ?? null,
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
      workMode: input.issue.workMode,
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
          : input.provider === "aws_agentcore"
            ? "aws_agentcore_harness_api"
          : input.provider === "acpx"
            ? "acpx_runtime"
          : "codex_app_server",
      protocolVersion: 1,
      lifecyclePolicy: input.lifecyclePolicy ?? { mode: "per_turn", idleTimeoutMs: null },
    },
    provider: input.provider === "claude_managed"
      ? {
          kind: "claude_managed",
          model: input.model,
          managedProfile: input.managedProfile,
          maxSessionListCostUsd: input.maxSessionListCostUsd,
        }
      : input.provider === "aws_agentcore"
        ? {
            kind: "aws_agentcore",
            model: input.model,
            agentCoreProfile: input.agentCoreProfile,
            maxEstimatedSessionCostUsd: input.maxEstimatedSessionCostUsd,
            invocationLimits: input.invocationLimits,
          }
      : input.provider === "acpx"
        ? {
            kind: "acpx",
            agent: acpxProfile!.agent,
            model: input.model,
            permissionPolicy: "interactive",
            profile: {
              driverKind: acpxProfile!.driverKind,
              protocolVersion: acpxProfile!.protocolVersion,
              acpxVersion: acpxProfile!.acpxVersion,
              agent: acpxProfile!.agent,
              agentProfileVersion: acpxProfile!.agentProfileVersion,
              agentServerPackage: acpxProfile!.agentServerPackage,
              agentServerVersion: acpxProfile!.agentServerVersion,
              agentRuntimePackage: acpxProfile!.agentRuntimePackage,
              agentRuntimeVersion: acpxProfile!.agentRuntimeVersion,
              commandDigest: acpxProfile!.commandDigest,
            },
          }
        : {
            kind: input.provider ?? "codex",
            model: input.model ?? null,
          },
    completionContract: input.completionContract,
    interactionResponses: input.interactionResponses ?? [],
    credentialBindings: [],
  }) as NativeExecutionInputV2;
}
