import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import { applyPendingMigrations, inspectMigrations } from "./client.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const MIGRATION_FILE = "0229_sticky_nightcrawler.sql";
const migrationSql = fs.readFileSync(
  path.join(import.meta.dirname, "migrations", MIGRATION_FILE),
  "utf8",
);
const cleanups: Array<() => Promise<void>> = [];
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function migrationHash() {
  return createHash("sha256").update(migrationSql).digest("hex");
}

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("connection grants phase 4 migration", () => {
  it("adds replay-safe named-agent standing delegations", () => {
    expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS "connection_grant_delegations"`);
    expect(migrationSql).toContain(`"connection_grant_delegations_grant_agent_uq"`);
    expect(migrationSql).toContain(`FOREIGN KEY ("company_id","grant_id")`);
    expect(migrationSql).toContain(`DROP CONSTRAINT IF EXISTS "connection_grant_delegations_company_grant_fk"`);
    expect(migrationSql).toContain(`CREATE INDEX IF NOT EXISTS "connection_grant_delegations_company_agent_idx"`);
    expect(migrationSql).toContain(`ON CONFLICT DO NOTHING`);
  });

  it("fails ambiguous personal-secret ownership closed with reauthorization guidance", () => {
    expect(migrationSql).toContain(`Cannot migrate personal connection credential`);
    expect(migrationSql).toContain(`Reauthorize the affected personal connection grants`);
    expect(migrationSql).toContain(`count(DISTINCT g."subject_user_id") <> 1`);
    expect(migrationSql).toContain(`other_g."kind" <> 'user'`);
    expect(migrationSql).toContain(`jsonb_array_elements(c."credential_secret_refs")`);
  });
});

describeEmbeddedPostgres("connection grants phase 4 executable migration", () => {
  it("converts one owner and rejects two-owner or mixed legacy references", async () => {
    const database = await startEmbeddedPostgresTestDatabase("paperclip-connection-phase4-migration-");
    cleanups.push(database.cleanup);
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });

    async function rewindMigration() {
      await sql`DELETE FROM "drizzle"."__drizzle_migrations" WHERE "hash" = ${migrationHash()}`;
      expect(await inspectMigrations(database.connectionString)).toMatchObject({
        status: "needsMigrations",
        pendingMigrations: [MIGRATION_FILE],
      });
    }

    async function seedLegacyCredential(input: {
      ownerUserIds: string[];
      includeOrganizationGrant?: boolean;
      includeConnectionReference?: boolean;
    }) {
      const companyId = randomUUID();
      const applicationId = randomUUID();
      const connectionId = randomUUID();
      const secretId = randomUUID();
      await sql`
        INSERT INTO "companies" ("id", "name", "issue_prefix")
        VALUES (${companyId}, ${`Phase 4 ${companyId}`}, ${`P${companyId.slice(0, 5)}`})
      `;
      await sql`
        INSERT INTO "tool_applications" ("id", "company_id", "name", "type")
        VALUES (${applicationId}, ${companyId}, ${`App ${applicationId}`}, 'mcp_http')
      `;
      await sql`
        INSERT INTO "tool_connections" (
          "id", "company_id", "application_id", "name", "uid", "transport", "credential_secret_refs"
        ) VALUES (
          ${connectionId}, ${companyId}, ${applicationId}, ${`Connection ${connectionId}`},
          ${`connection-${connectionId}`}, 'mcp_remote',
          ${sql.json(input.includeConnectionReference ? [{ secretId, version: "latest" }] : [])}
        )
      `;
      await sql`
        INSERT INTO "company_secrets" ("id", "company_id", "key", "name", "scope")
        VALUES (${secretId}, ${companyId}, ${`secret-${secretId}`}, ${`Secret ${secretId}`}, 'company')
      `;
      for (const ownerUserId of input.ownerUserIds) {
        await sql`
          INSERT INTO "connection_grants" (
            "company_id", "connection_id", "kind", "subject_user_id", "credential_secret_refs"
          ) VALUES (
            ${companyId}, ${connectionId}, 'user', ${ownerUserId},
            ${sql.json([{ secretId, version: "latest" }])}
          )
        `;
      }
      if (input.includeOrganizationGrant) {
        await sql`
          INSERT INTO "connection_grants" (
            "company_id", "connection_id", "kind", "credential_secret_refs"
          ) VALUES (
            ${companyId}, ${connectionId}, 'organization',
            ${sql.json([{ secretId, version: "latest" }])}
          )
        `;
      }
      return { companyId, secretId, ownerUserId: input.ownerUserIds[0]! };
    }

    try {
      const valid = await seedLegacyCredential({ ownerUserIds: ["alice"] });
      await rewindMigration();
      await applyPendingMigrations(database.connectionString);
      const converted = await sql<{
        scope: string;
        owner_user_id: string | null;
        user_secret_definition_id: string | null;
      }[]>`
        SELECT "scope", "owner_user_id", "user_secret_definition_id"
        FROM "company_secrets"
        WHERE "id" = ${valid.secretId}
      `;
      expect(converted).toEqual([{
        scope: "user",
        owner_user_id: valid.ownerUserId,
        user_secret_definition_id: expect.any(String),
      }]);

      const ambiguous = await seedLegacyCredential({ ownerUserIds: ["alice", "bob"] });
      await rewindMigration();
      await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow(
        /legacy ownership is ambiguous/,
      );

      await sql`DELETE FROM "company_secrets" WHERE "company_id" = ${ambiguous.companyId}`;
      await sql`DELETE FROM "companies" WHERE "id" = ${ambiguous.companyId}`;
      await seedLegacyCredential({
        ownerUserIds: ["carol"],
        includeOrganizationGrant: true,
        includeConnectionReference: true,
      });
      await expect(applyPendingMigrations(database.connectionString)).rejects.toThrow(
        /legacy ownership is ambiguous/,
      );
    } finally {
      await sql.end();
    }
  }, 45_000);
});
