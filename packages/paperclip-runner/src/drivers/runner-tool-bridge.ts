import {
  canonicalOpenCodeMcpToolName,
  startOpenCodeMcpBridge,
  type OpenCodeMcpBridge,
} from "./opencode/mcp-bridge.js";

/** Provider-neutral name for the authenticated semantic bridge. */
export type RunnerToolBridge = OpenCodeMcpBridge;
export const canonicalRunnerToolName = canonicalOpenCodeMcpToolName;
export const startRunnerToolBridge = startOpenCodeMcpBridge;

