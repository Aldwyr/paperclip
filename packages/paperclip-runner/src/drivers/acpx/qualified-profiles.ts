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
    commandDigest: "sha256:5d06b5cfe819b1acd75e8d9dea4766e76a40a64b82549eda08c3835f18bdac24",
    qualificationModel: "openrouter/deepseek/deepseek-v4-flash-0731",
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
    commandDigest: "sha256:8c7fc8af156596668a95ce23d52309f70ad576e75bac6dc209d30378bdbb8ebe",
    qualificationModel: "gpt-5.6-sol",
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
