import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { completionContracts } from "@paperclipai/db";
import type { StrictCompletionContractInput } from "../../vendor/paperclip-runner/index.js";
import { nativeSha256 } from "./canonical.js";

export const NATIVE_COMPLETION_CONTRACT_SCHEMA = "paperclip.completion-contract.v1";
export const NATIVE_COMPLETION_POLICY_VERSION = "phase6-v3";

export function resolveNativeCompletionPolicy(issue: {
  reviewPolicy?: string | null;
}) {
  const externalReviewRequired = issue.reviewPolicy === "human_only"
    || issue.reviewPolicy === "not_creator";
  return externalReviewRequired
    ? { risk: "standard", completionAuthority: "server_arbiter" } as const
    : { risk: "low", completionAuthority: "agent_claim_policy" } as const;
}

export function buildNativeCompletionContract(
  issue: { title: string; description: string | null },
  immediateRequest?: string | null,
): StrictCompletionContractInput {
  const followUp = immediateRequest?.trim();
  return {
    revision: "1",
    objective: followUp ? `Respond to the latest comment on ${issue.title}` : issue.title,
    criteria: [{
      id: "objective",
      requirement: followUp || issue.description?.trim() || `Complete: ${issue.title}`,
    }],
  };
}

export async function ensureNativeCompletionContract(input: {
  db: Db;
  companyId: string;
  issue: {
    id: string;
    title: string;
    description: string | null;
    reviewPolicy?: string | null;
  };
  actorId: string;
  immediateRequest?: string | null;
}) {
  const contract = buildNativeCompletionContract(input.issue, input.immediateRequest);
  const completionPolicy = resolveNativeCompletionPolicy(input.issue);
  const canonicalSha256 = nativeSha256({
    schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
    policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
    ...completionPolicy,
    contract,
  });
  const existing = await input.db
    .select()
    .from(completionContracts)
    .where(and(
      eq(completionContracts.companyId, input.companyId),
      eq(completionContracts.issueId, input.issue.id),
      eq(completionContracts.canonicalSha256, canonicalSha256),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (existing) return { row: existing, contract };

  const latest = await input.db
    .select({ revision: completionContracts.revision, id: completionContracts.id })
    .from(completionContracts)
    .where(and(
      eq(completionContracts.companyId, input.companyId),
      eq(completionContracts.issueId, input.issue.id),
    ))
    .orderBy(desc(completionContracts.revision))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const [row] = await input.db.insert(completionContracts).values({
    companyId: input.companyId,
    issueId: input.issue.id,
    revision: (latest?.revision ?? 0) + 1,
    schemaVersion: NATIVE_COMPLETION_CONTRACT_SCHEMA,
    policyVersion: NATIVE_COMPLETION_POLICY_VERSION,
    // Ordinary issues use the model's schema-valid claim. Explicit human
    // review policies retain server authority so completion materializes an
    // owned review interaction instead of bypassing the issue policy.
    ...completionPolicy,
    incompleteCriteriaPolicy: "preserve_non_terminal",
    contractJson: contract as unknown as Record<string, unknown>,
    canonicalSha256,
    createdByActorType: "system",
    createdByActorId: input.actorId,
    supersedesContractId: latest?.id ?? null,
  }).returning();
  if (!row) throw new Error("native_completion_contract_not_persisted");
  return { row, contract };
}
