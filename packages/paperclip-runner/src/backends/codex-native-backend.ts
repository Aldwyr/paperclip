import { createCodexTaskEnvelope } from "../contracts/codex.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { NativeSessionBackend } from "../contracts/native-session-backend.js";
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
    transportFactory?: () => CodexAppServerTransport;
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
  return new HarnessDriverBackend(new CodexAppServerDriver({
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
  }));
}
