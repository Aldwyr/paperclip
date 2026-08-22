import { and, asc, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companySecrets, remoteAgentProfiles } from "@paperclipai/db";

import { conflict, notFound, unprocessable } from "../errors.js";

export type RemoteAgentService = "anthropic_managed_agents" | "aws_bedrock_agentcore_harness";

export interface RemoteAgentProfileInput {
  profileKey: string;
  displayName: string;
  service: RemoteAgentService;
  configuration: Record<string, unknown>;
  credentialSecretId?: string | null;
  enabled: boolean;
  retentionAcknowledged: boolean;
  qualification?: Record<string, unknown>;
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw unprocessable(`${label} is required`);
  return value.trim();
}

function validateConfiguration(service: RemoteAgentService, configuration: Record<string, unknown>) {
  const keys = service === "aws_bedrock_agentcore_harness"
    ? ["region", "accountId", "harnessArn", "harnessVersion", "endpointArn", "endpointQualifier", "agentRuntimeArn", "memoryArn", "memoryId", "invocationRoleArn", "qualificationRevision", "defaultModel"]
    : ["anthropicAgentId", "agentVersion", "environmentId", "betaVersion", "defaultModel"];
  for (const key of keys) required(configuration[key], `configuration.${key}`);
  if (service === "aws_bedrock_agentcore_harness" && configuration.eventExpiryDays !== 90) {
    throw unprocessable("AWS AgentCore profile requires a 90-day Memory expiry");
  }
  if (service === "anthropic_managed_agents" && configuration.betaVersion !== "managed-agents-2026-04-01") {
    throw unprocessable("Anthropic profile beta version is not qualified");
  }
}

export function remoteAgentProfileService(db: Db) {
  async function list(companyId: string, service?: RemoteAgentService) {
    return db.select().from(remoteAgentProfiles)
      .where(service
        ? and(eq(remoteAgentProfiles.companyId, companyId), eq(remoteAgentProfiles.service, service))
        : eq(remoteAgentProfiles.companyId, companyId))
      .orderBy(asc(remoteAgentProfiles.displayName));
  }

  async function get(companyId: string, profileIdOrKey: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileIdOrKey);
    const rows = await db.select().from(remoteAgentProfiles).where(and(
      eq(remoteAgentProfiles.companyId, companyId),
      isUuid ? eq(remoteAgentProfiles.id, profileIdOrKey) : eq(remoteAgentProfiles.profileKey, profileIdOrKey),
    )).limit(1);
    return rows[0] ?? null;
  }

  async function requireQualified(companyId: string, profileIdOrKey: string, service?: RemoteAgentService) {
    const profile = await get(companyId, profileIdOrKey);
    if (!profile || service && profile.service !== service) throw notFound("Remote Agent profile not found");
    if (!profile.enabled || !profile.retentionAcknowledged || !profile.qualifiedAt) throw conflict("Remote Agent profile is not enabled and qualified");
    return profile;
  }

  async function upsert(companyId: string, input: RemoteAgentProfileInput) {
    const profileKey = required(input.profileKey, "Profile key");
    const displayName = required(input.displayName, "Display name");
    validateConfiguration(input.service, input.configuration);
    if (input.enabled && !input.retentionAcknowledged) throw unprocessable("Enabling a remote agent requires retention acknowledgement");
    if (input.service === "anthropic_managed_agents" && !input.credentialSecretId) throw unprocessable("Anthropic profiles require a credential secret reference");
    if (input.credentialSecretId) {
      const secret = await db.select({ id: companySecrets.id }).from(companySecrets).where(and(
        eq(companySecrets.companyId, companyId), eq(companySecrets.id, input.credentialSecretId),
        eq(companySecrets.scope, "company"), ne(companySecrets.status, "deleted"),
      )).limit(1);
      if (!secret[0]) throw unprocessable("Remote Agent credential secret reference is invalid");
    }
    const values = {
      companyId, profileKey, displayName, service: input.service,
      configuration: structuredClone(input.configuration),
      credentialSecretId: input.credentialSecretId ?? null,
      enabled: input.enabled, retentionAcknowledged: input.retentionAcknowledged,
      qualification: input.qualification ?? {}, qualifiedAt: input.enabled ? new Date() : null,
      updatedAt: new Date(),
    } as const;
    const [row] = await db.insert(remoteAgentProfiles).values(values).onConflictDoUpdate({
      target: [remoteAgentProfiles.companyId, remoteAgentProfiles.profileKey], set: values,
    }).returning();
    return row!;
  }

  return { list, get, requireQualified, upsert };
}
