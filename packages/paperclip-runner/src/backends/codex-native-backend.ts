import { createCodexTaskEnvelope } from "../contracts/codex.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type {
  NativeSessionBackend,
  PersistedNativeSession,
} from "../contracts/native-session-backend.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import type { CodexAppServerTransport } from "../drivers/codex/app-server-transport.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";
import { nativeSystemInstructions, nativeTaskConstraints } from "./runtime-context.js";

/**
 * Package-owned factory used by the Paperclip seam. Core supplies only the
 * closed native input; construction of the concrete Codex driver stays here.
 */
export function createCodexNativeSessionBackend(
  input: NativeExecutionInput,
  options: {
    runnerInstanceId?: string;
    onSpawn?: (meta: {
      pid: number;
      processGroupId: number | null;
      startedAt: string;
    }) => Promise<void>;
    transportFactory?: (context?: {
      providerRecoveryPolicy?: PersistedNativeSession["providerRecoveryPolicy"];
    }) => CodexAppServerTransport;
    dynamicTools?: readonly Readonly<Record<string, unknown>>[];
    dynamicToolHandler?: (call: {
      tool: string;
      callId: string;
      threadId: string;
      turnId: string;
      arguments: unknown;
    }) => Promise<unknown>;
  } = {},
): NativeSessionBackend {
  const providerIdentity = (() => {
    switch (input.provider.kind) {
      case "codex":
        return { kind: "codex_app_server", displayName: "Codex app-server", version: "codex-v2" };
      case "opencode":
        return { kind: "opencode_server", displayName: "OpenCode server", version: "1.18.17" };
      case "acpx":
        return { kind: "acpx_runtime", displayName: `${input.provider.agent === "pi" ? "Pi" : input.provider.agent === "claude" ? "Claude" : "Codex"} via ACPX`, version: "0.13.1" };
      case "claude_managed":
        return { kind: "claude_managed_agents_api", displayName: "Claude Managed Agent", version: input.provider.managedProfile.agentVersion };
      case "aws_agentcore":
        return { kind: "aws_agentcore_harness_api", displayName: "AWS AgentCore Harness", version: input.provider.agentCoreProfile.harnessVersion };
    }
  })();
  const codexCapabilities = input.provider.kind === "codex"
    ? {}
    : {
        steering: false,
        goals: false,
        threadLineage: false,
      };
  return new HarnessDriverBackend(new CodexAppServerDriver({
    ...(input.provider.model ? { model: input.provider.model } : {}),
    approvalPolicy: input.provider.kind === "codex" ? input.provider.approvalPolicy ?? "never" : "never",
    baseInstructions: nativeSystemInstructions(input),
    includeSkillInstructions: "runtimeContext" in input,
    requestedCollaborationMode: "executionMode" in input ? input.executionMode : "default",
    taskEnvelope: createCodexTaskEnvelope({
      objective: input.completionContract.contract.objective,
      contractRevision: input.completionContract.contract.revision,
      criteria: input.completionContract.contract.criteria,
      constraints: [
        "Work only inside the supplied working directory.",
        ...("executionMode" in input && input.executionMode === "plan" ? [
          "Use native plan collaboration mode and do not modify workspace files.",
          "Treat the supplied Paperclip planning context as the canonical pinned base revision.",
          "Complete one structured provider plan item; Paperclip will synchronize it after completion.",
          "Keep the final response to a short synchronization summary instead of repeating the full plan.",
        ] : []),
        ...nativeTaskConstraints(input),
        "Return one semantic completion result.",
      ],
    }),
    runnerInstanceId: options.runnerInstanceId ?? `paperclip-native-${input.binding.runId}`,
    onSpawn: options.onSpawn,
    transportFactory: options.transportFactory,
    dynamicTools: options.dynamicTools,
    dynamicToolHandler: options.dynamicToolHandler,
    driverIdentity: providerIdentity,
    capabilities: codexCapabilities,
    collaborationModes: input.provider.kind === "codex" ? ["default", "plan"] : ["default"],
    requireProviderSessionIdentity: options.transportFactory !== undefined,
  }));
}
