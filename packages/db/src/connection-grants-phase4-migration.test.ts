import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync(
  path.join(import.meta.dirname, "migrations/0229_sticky_nightcrawler.sql"),
  "utf8",
);

describe("connection grants phase 4 migration", () => {
  it("adds named-agent standing delegations", () => {
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS "connection_grant_delegations"`);
    expect(sql).toContain(`"connection_grant_delegations_grant_agent_uq"`);
    expect(sql).toContain(`FOREIGN KEY ("company_id","grant_id")`);
  });

  it("can replay after schema state moves ahead of the migration journal", () => {
    expect(sql).toContain(`DROP CONSTRAINT IF EXISTS "connection_grant_delegations_company_grant_fk"`);
    expect(sql).toContain(`CREATE INDEX IF NOT EXISTS "connection_grant_delegations_company_agent_idx"`);
    expect(sql).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS "connection_grant_delegations_grant_agent_uq"`);
    expect(sql).toContain(`ON CONFLICT DO NOTHING`);
  });

  it("moves personal grant secrets to their owner's user scope", () => {
    expect(sql).toContain(`g."kind" = 'user'`);
    expect(sql).toContain(`"scope" = 'user'`);
    expect(sql).toContain(`"owner_user_id" = owner_map."owner_user_id"`);
    expect(sql).toContain(`"user_secret_definition_id" = d."id"`);
    expect(sql).toContain(`HAVING count(DISTINCT g."subject_user_id") = 1`);
  });
});
