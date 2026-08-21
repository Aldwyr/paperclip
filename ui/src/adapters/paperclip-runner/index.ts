import type { UIAdapterModule } from "../types";
import { parseCodexStdoutLine, buildPaperclipRunnerConfig } from "@paperclipai/adapter-codex-local/ui";
import { CodexLocalConfigFields } from "../codex-local/config-fields";

export const paperclipRunnerUIAdapter: UIAdapterModule = {
  type: "paperclip_runner",
  label: "Paperclip Runner",
  parseStdoutLine: parseCodexStdoutLine,
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: buildPaperclipRunnerConfig,
};
