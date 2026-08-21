import { createCodexTaskEnvelope } from "../contracts/codex.js";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type { NativeSessionBackend } from "../contracts/native-session-backend.js";
import { CodexAppServerDriver } from "../drivers/codex/codex-app-server-driver.js";
import type { CodexAppServerTransport } from "../drivers/codex/app-server-transport.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";

/**
 * Package-owned factory used by the Paperclip seam. Core supplies only the
 * closed native input; construction of the concrete Codex driver stays here.
 */
export function createCodexNativeSessionBackend(
  input: NativeExecutionInputV1,
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
    taskEnvelope: createCodexTaskEnvelope({
      objective: input.completionContract.contract.objective,
      contractRevision: input.completionContract.contract.revision,
      criteria: input.completionContract.contract.criteria,
      constraints: [
        "Work only inside the supplied working directory.",
        "Do not discover or invoke skills.",
        "Do not call a control-plane API.",
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
