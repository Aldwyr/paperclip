import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type {
  NativeSessionBackend,
  PersistedNativeSession,
} from "../contracts/native-session-backend.js";
import type { CodexAppServerTransport } from "../drivers/codex/app-server-transport.js";
import { createCodexNativeSessionBackend } from "./codex-native-backend.js";
import { createOpenCodeNativeSessionBackend } from "./opencode-native-backend.js";
import type { AcpxRuntimeFactory } from "../drivers/acpx/acpx-runtime-host.js";

export interface NativeBackendFactoryOptions {
  runnerInstanceId?: string;
  onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  dynamicToolHandler?: (call: {
    tool: string;
    callId: string;
    threadId: string;
    turnId: string;
    arguments: unknown;
  }) => Promise<unknown>;
  codexTransportFactory?: (context?: {
    providerRecoveryPolicy?: PersistedNativeSession["providerRecoveryPolicy"];
  }) => CodexAppServerTransport;
  opencodeRuntimeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  opencodeCommand?: string;
  acpxRuntimeDirectory?: string;
  acpxRuntimeFactory?: AcpxRuntimeFactory;
}

export function createNativeSessionBackend(
  input: NativeExecutionInput,
  options: NativeBackendFactoryOptions = {},
): NativeSessionBackend {
  if (options.codexTransportFactory) {
    return createCodexNativeSessionBackend(input, {
      runnerInstanceId: options.runnerInstanceId,
      onSpawn: options.onSpawn,
      dynamicTools: options.dynamicTools,
      dynamicToolHandler: options.dynamicToolHandler,
      transportFactory: options.codexTransportFactory,
    });
  }
  if (input.provider.kind === "codex") {
    return createCodexNativeSessionBackend(input, {
      runnerInstanceId: options.runnerInstanceId,
      onSpawn: options.onSpawn,
      dynamicTools: options.dynamicTools,
      dynamicToolHandler: options.dynamicToolHandler,
    });
  }
  if (input.provider.kind === "claude_managed" || input.provider.kind === "aws_agentcore") {
    throw new Error(`${input.provider.kind === "claude_managed" ? "Claude Agent" : "AWS AgentCore"} native backend requires the runnerd remote-provider transport`);
  }
  if (input.provider.kind === "acpx") {
    throw new Error("ACPX native backend requires the runnerd transport");
  }
  if (!options.opencodeRuntimeDirectory) {
    throw new Error("OpenCode native backend requires an instance runtime directory");
  }
  return createOpenCodeNativeSessionBackend(input, {
    runnerInstanceId: options.runnerInstanceId,
    onSpawn: options.onSpawn,
    runtimeDirectory: options.opencodeRuntimeDirectory,
    environment: options.environment,
    command: options.opencodeCommand,
    dynamicTools: options.dynamicTools,
    dynamicToolHandler: options.dynamicToolHandler,
  });
}
