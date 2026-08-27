import { pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

// The durable record of a revoked run-scoped agent credential. The engine
// writes one row here when it revokes a run's local-agent JWT (for example,
// after it loses the sandbox duplex channel). The auth middleware denies a
// token whose (company_id, run_id) claims match a row here, even after a
// server restart clears the in-process cache.
//
// The table stores identifiers only, never the raw token.
//
// Bounded lifetime: `expiresAt` holds the writer's best-known expiry of the
// revoked token (the token TTL added to the revocation time). A row past its
// `expiresAt` denies nothing new, because the token it targets is already
// expired and rejected on that basis alone. A future retention job can use
// `expiresAt` to prune old rows; this table does not run that job itself.
export const runCredentialRevocations = pgTable(
  "run_credential_revocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    // The lookup path the auth middleware uses on every request, and the
    // idempotency anchor for a repeated revoke of the same run.
    companyRunUq: uniqueIndex("run_credential_revocations_company_run_uq").on(
      table.companyId,
      table.runId,
    ),
  }),
);
