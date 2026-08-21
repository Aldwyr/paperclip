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
DO $$
DECLARE
	ambiguous_secret record;
BEGIN
	SELECT
		s."id" AS "secret_id",
		count(DISTINCT g."subject_user_id") AS "personal_owner_count",
		count(*) FILTER (WHERE other_g."id" IS NOT NULL) AS "organization_reference_count",
		count(*) FILTER (WHERE c."id" IS NOT NULL) AS "connection_reference_count"
	INTO ambiguous_secret
	FROM "company_secrets" s
	JOIN "connection_grants" g
		ON g."company_id" = s."company_id"
		AND g."kind" = 'user'
	CROSS JOIN LATERAL jsonb_array_elements(g."credential_secret_refs") personal_ref
	LEFT JOIN "connection_grants" other_g
		ON other_g."company_id" = s."company_id"
		AND other_g."kind" <> 'user'
		AND EXISTS (
			SELECT 1
			FROM jsonb_array_elements(other_g."credential_secret_refs") other_ref
			WHERE other_ref ->> 'secretId' = s."id"::text
		)
	LEFT JOIN "tool_connections" c
		ON c."company_id" = s."company_id"
		AND EXISTS (
			SELECT 1
			FROM jsonb_array_elements(c."credential_secret_refs") connection_ref
			WHERE connection_ref ->> 'secretId' = s."id"::text
		)
	WHERE s."id"::text = personal_ref ->> 'secretId'
		AND s."scope" = 'company'
	GROUP BY s."id"
	HAVING count(DISTINCT g."subject_user_id") <> 1
		OR count(*) FILTER (WHERE other_g."id" IS NOT NULL) > 0
		OR count(*) FILTER (WHERE c."id" IS NOT NULL) > 0
	LIMIT 1;

	IF FOUND THEN
		RAISE EXCEPTION 'Cannot migrate personal connection credential %: legacy ownership is ambiguous', ambiguous_secret."secret_id"
			USING ERRCODE = '23514',
				DETAIL = format(
					'personal owners=%s, organization grant references=%s, connection references=%s',
					ambiguous_secret."personal_owner_count",
					ambiguous_secret."organization_reference_count",
					ambiguous_secret."connection_reference_count"
				),
				HINT = 'Reauthorize the affected personal connection grants with one credential per user before retrying this migration.';
	END IF;
END $$;
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
