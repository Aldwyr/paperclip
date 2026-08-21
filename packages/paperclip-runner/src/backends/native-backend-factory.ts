import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type { NativeSessionBackend } from "../contracts/native-session-backend.js";
import type { CodexAppServerTransport } from "../drivers/codex/app-server-transport.js";
import { createCodexNativeSessionBackend } from "./codex-native-backend.js";
import { createOpenCodeNativeSessionBackend } from "./opencode-native-backend.js";

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
  codexTransportFactory?: () => CodexAppServerTransport;
  opencodeRuntimeDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  opencodeCommand?: string;
}

export function createNativeSessionBackend(
  input: NativeExecutionInputV1,
  options: NativeBackendFactoryOptions = {},
): NativeSessionBackend {
  if (input.provider.kind === "codex") {
    return createCodexNativeSessionBackend(input, {
      runnerInstanceId: options.runnerInstanceId,
      onSpawn: options.onSpawn,
      dynamicTools: options.dynamicTools,
      dynamicToolHandler: options.dynamicToolHandler,
      transportFactory: options.codexTransportFactory,
    });
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
