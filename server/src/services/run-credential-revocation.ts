import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { runCredentialRevocations } from "@paperclipai/db";
import { resolveAgentJwtTtlSeconds } from "../agent-auth-jwt.js";
import { logger } from "../middleware/logger.js";

// The durable store for a revoked run-scoped credential (the local-agent JWT
// a run's sandbox uses to call back into the Paperclip API). The JWT is a
// stateless, signed token with no database row of its own, so a valid
// signature and an unexpired `exp` normally authenticate for the token's
// full lifetime. A run whose sandbox duplex control channel was lost cannot
// legitimately use its credential again, so the engine revokes it as soon as
// it detects the loss.
//
// The row is the source of truth and survives a server restart. It stores
// identifiers only, never the raw token. See run_credential_revocations in
// the schema package for the bounded-lifetime rule.

/**
 * Durably revoke the run-scoped credential for one run, in one company.
 * Idempotent: revoking an already-revoked run is a no-op, because the table
 * carries a unique constraint on (company_id, run_id) and this call ignores
 * a conflict on it.
 *
 * Throws on a write fault. The caller must treat that as a failed-closed
 * terminal path, not a silent success — an unrevoked credential is a live
 * capability, so a revocation that did not durably land must not be reported
 * as done.
 */
export async function revokeRunScopedCredential(
  db: Db,
  input: { companyId: string; runId: string },
): Promise<void> {
  const revokedAt = new Date();
  const expiresAt = new Date(revokedAt.getTime() + resolveAgentJwtTtlSeconds() * 1000);
  await db
    .insert(runCredentialRevocations)
    .values({
      companyId: input.companyId,
      runId: input.runId,
      revokedAt,
      expiresAt,
    })
    .onConflictDoNothing();
}

/**
 * True when the run-scoped credential for `companyId`/`runId` was durably
 * revoked. Fails closed: a lookup fault is reported as revoked, so a caller
 * that denies on `true` also denies on a database fault. State this as the
 * availability trade-off it is — a database fault then denies every
 * run-scoped token, not only the revoked ones.
 */
export async function isRunScopedCredentialRevoked(
  db: Db,
  input: { companyId: string; runId: string },
): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: runCredentialRevocations.id })
      .from(runCredentialRevocations)
      .where(
        and(
          eq(runCredentialRevocations.companyId, input.companyId),
          eq(runCredentialRevocations.runId, input.runId),
        ),
      );
    return rows.length > 0;
  } catch (err) {
    logger.error(
      { err, companyId: input.companyId, runId: input.runId },
      "Run-scoped credential revocation lookup failed; denying the request (fail closed)",
    );
    return true;
  }
}
