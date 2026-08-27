// A local, in-process denylist for the run-scoped credential (the local-agent
// JWT a run's sandbox uses to call back into the Paperclip API). The JWT is a
// stateless, signed token with no database row of its own, so a valid
// signature and an unexpired `exp` normally authenticate for the token's
// full lifetime. A run whose sandbox duplex control channel was lost cannot
// legitimately use its credential again, so the engine revokes it locally
// as soon as it detects the loss.
//
// This denylist lives in process memory only: it protects the current
// server process for the rest of that process's life, not across a restart.
// The token's own `exp` remains the durable backstop.
const revokedRunIds = new Set<string>();

/**
 * Revoke the run-scoped credential for one run. Idempotent: revoking an
 * already-revoked run is a no-op. Nothing in this module ever removes a run
 * from the set, so a later cleanup can never re-enable a revoked credential.
 */
export function revokeRunScopedCredential(runId: string): void {
  revokedRunIds.add(runId);
}

/** True when the run-scoped credential for `runId` was locally revoked. */
export function isRunScopedCredentialRevoked(runId: string): boolean {
  return revokedRunIds.has(runId);
}
