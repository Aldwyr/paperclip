export const QUALIFIED_ACPX_VERSION = "0.13.1" as const;
export const ACPX_DRIVER_KIND = "acpx_runtime" as const;
export const ACPX_DRIVER_PROTOCOL_VERSION = 1 as const;

export type QualifiedAcpxAgent = "pi" | "claude" | "codex";

export interface QualifiedAcpxProfile {
  driverKind: typeof ACPX_DRIVER_KIND;
  protocolVersion: typeof ACPX_DRIVER_PROTOCOL_VERSION;
  acpxVersion: typeof QUALIFIED_ACPX_VERSION;
  agent: QualifiedAcpxAgent;
  agentProfileVersion: 1;
  agentServerPackage: string;
  agentServerVersion: string;
  agentRuntimePackage: string | null;
  agentRuntimeVersion: string | null;
  commandDigest: string;
  qualificationModel: string;
  /**
   * Model identifier the pinned ACP server reports after accepting the exact
   * qualification model. Most agents echo the requested model. Claude's ACP
   * server deliberately exposes its stable SDK selector (`sonnet`) while the
   * SDK resolves that selector to the canonical wire model
   * (`claude-sonnet-5`). Paperclip verifies the exact request was accepted
   * before treating this identifier as the qualified effective model.
   */
  reportedModelId: string;
  permissionPolicy: "interactive";
}

/**
 * Digests bind the closed profile declaration (package, version, runtime and
 * model), not a caller-controlled executable. The environment probe separately
 * verifies the resolved package files before a billable prompt is admitted.
 */
export const QUALIFIED_ACPX_PROFILES: Readonly<Record<QualifiedAcpxAgent, QualifiedAcpxProfile>> = {
  pi: {
    driverKind: ACPX_DRIVER_KIND,
    protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION,
    agent: "pi",
    agentProfileVersion: 1,
    agentServerPackage: "pi-acp",
    agentServerVersion: "0.0.33",
    agentRuntimePackage: "@earendil-works/pi-coding-agent",
    agentRuntimeVersion: "0.84.2",
    commandDigest: "sha256:8c696f38296d53d0061fa11534570c5ddd951b63532aed30e0f1fcc676dc169f",
    qualificationModel: "openrouter/deepseek/deepseek-v4-flash-0731",
    reportedModelId: "openrouter/deepseek/deepseek-v4-flash-0731",
    permissionPolicy: "interactive",
  },
  claude: {
    driverKind: ACPX_DRIVER_KIND,
    protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION,
    agent: "claude",
    agentProfileVersion: 1,
    agentServerPackage: "@agentclientprotocol/claude-agent-acp",
    agentServerVersion: "0.70.0",
    agentRuntimePackage: null,
    agentRuntimeVersion: null,
    commandDigest: "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
    qualificationModel: "claude-sonnet-5",
    reportedModelId: "sonnet",
    permissionPolicy: "interactive",
  },
  codex: {
    driverKind: ACPX_DRIVER_KIND,
    protocolVersion: ACPX_DRIVER_PROTOCOL_VERSION,
    acpxVersion: QUALIFIED_ACPX_VERSION,
    agent: "codex",
    agentProfileVersion: 1,
    agentServerPackage: "@agentclientprotocol/codex-acp",
    agentServerVersion: "1.6.2",
    agentRuntimePackage: null,
    agentRuntimeVersion: null,
    commandDigest: "sha256:94049b3e3c3aee87de62703786e4fa81d031d7bd979f99bdf516d84f28791a79",
    qualificationModel: "gpt-5.6-sol",
    reportedModelId: "gpt-5.6-sol",
    permissionPolicy: "interactive",
  },
};

export function resolveQualifiedAcpxProfile(
  agent: QualifiedAcpxAgent,
  requestedModel: string,
): QualifiedAcpxProfile {
  const profile = QUALIFIED_ACPX_PROFILES[agent];
  if (requestedModel !== profile.qualificationModel) {
    throw new Error(
      `ACPX ${agent} profile requires exact model ${profile.qualificationModel}; received ${requestedModel}`,
    );
  }
  return structuredClone(profile);
}
