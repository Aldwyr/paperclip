CREATE TABLE IF NOT EXISTS "connection_grant_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" DROP CONSTRAINT IF EXISTS "connection_grant_delegations_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" ADD CONSTRAINT "connection_grant_delegations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" DROP CONSTRAINT IF EXISTS "connection_grant_delegations_agent_id_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" ADD CONSTRAINT "connection_grant_delegations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" DROP CONSTRAINT IF EXISTS "connection_grant_delegations_company_grant_fk";
--> statement-breakpoint
ALTER TABLE "connection_grant_delegations" ADD CONSTRAINT "connection_grant_delegations_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connection_grant_delegations_company_agent_idx" ON "connection_grant_delegations" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connection_grant_delegations_grant_agent_uq" ON "connection_grant_delegations" USING btree ("grant_id","agent_id");
--> statement-breakpoint
INSERT INTO "user_secret_definitions" (
	"company_id", "key", "name", "description", "provider", "managed_mode",
	"provider_config_id", "provider_metadata", "created_by_agent_id", "created_by_user_id"
)
SELECT DISTINCT
	s."company_id",
	'tool_oauth.' || s."id"::text,
	s."name",
	'Personal connection credential migrated to user scope.',
	s."provider",
	s."managed_mode",
	s."provider_config_id",
	s."provider_metadata",
	s."created_by_agent_id",
	s."created_by_user_id"
FROM "company_secrets" s
JOIN "connection_grants" g ON g."company_id" = s."company_id" AND g."kind" = 'user'
CROSS JOIN LATERAL jsonb_array_elements(g."credential_secret_refs") ref
WHERE s."id"::text = ref ->> 'secretId'
	AND s."scope" = 'company'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "company_secrets" s
SET
	"scope" = 'user',
	"owner_user_id" = owner_map."owner_user_id",
	"user_secret_definition_id" = d."id",
	"updated_at" = now()
FROM (
	SELECT s2."id" AS "secret_id", min(g."subject_user_id") AS "owner_user_id"
	FROM "company_secrets" s2
	JOIN "connection_grants" g ON g."company_id" = s2."company_id" AND g."kind" = 'user'
	CROSS JOIN LATERAL jsonb_array_elements(g."credential_secret_refs") ref
	WHERE s2."id"::text = ref ->> 'secretId' AND s2."scope" = 'company'
	GROUP BY s2."id"
	HAVING count(DISTINCT g."subject_user_id") = 1
) owner_map
JOIN "user_secret_definitions" d ON d."key" = 'tool_oauth.' || owner_map."secret_id"::text AND d."deleted_at" IS NULL
WHERE s."id" = owner_map."secret_id" AND d."company_id" = s."company_id";
