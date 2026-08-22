import { createCodexTaskEnvelope } from "../contracts/codex.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { NativeSessionBackend } from "../contracts/native-session-backend.js";
import { AcpxRuntimeDriver, type AcpxRuntimeDriverOptions } from "../drivers/acpx/acpx-runtime-driver.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";

export function createAcpxNativeSessionBackend(
  input: NativeExecutionInput,
  options: Omit<AcpxRuntimeDriverOptions, "agent" | "model" | "taskEnvelope">,
): NativeSessionBackend {
  if (input.provider.kind !== "acpx") {
    throw new Error("ACPX native backend requires a persisted ACPX provider profile");
  }
  return new HarnessDriverBackend(new AcpxRuntimeDriver({
    ...options,
    agent: input.provider.agent,
    model: input.provider.model,
    taskEnvelope: createCodexTaskEnvelope({
      objective: input.completionContract.contract.objective,
      contractRevision: input.completionContract.contract.revision,
      criteria: input.completionContract.contract.criteria,
      constraints: [
        "Work only inside the supplied working directory.",
        "Use only runner-authorized semantic Paperclip tools.",
        "Do not discover user or project configuration, skills, plugins, or MCP servers.",
        "Return one semantic completion result through paperclip_finish or paperclip_block.",
      ],
    }),
  }));
}
