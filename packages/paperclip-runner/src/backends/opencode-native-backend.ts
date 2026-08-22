import { createCodexTaskEnvelope } from "../contracts/codex.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { NativeSessionBackend } from "../contracts/native-session-backend.js";
import { OpenCodeServerDriver, type OpenCodeServerDriverOptions } from "../drivers/opencode/opencode-server-driver.js";
import { HarnessDriverBackend } from "./harness-driver-backend.js";

export function createOpenCodeNativeSessionBackend(
  input: NativeExecutionInput,
  options: Omit<OpenCodeServerDriverOptions, "model" | "taskEnvelope">,
): NativeSessionBackend {
  if (input.provider.kind !== "opencode" || !input.provider.model) {
    throw new Error("OpenCode native backend requires a persisted OpenCode provider/model selection");
  }
  return new HarnessDriverBackend(new OpenCodeServerDriver({
    ...options,
    model: input.provider.model,
    taskEnvelope: createCodexTaskEnvelope({
      objective: input.completionContract.contract.objective,
      contractRevision: input.completionContract.contract.revision,
      criteria: input.completionContract.contract.criteria,
      constraints: [
        "Work only inside the supplied working directory.",
        "Do not discover or invoke skills.",
        "Do not call a control-plane API.",
        "Return one semantic completion result through paperclip_finish or paperclip_block.",
      ],
    }),
  }));
}
