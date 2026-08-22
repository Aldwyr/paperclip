CREATE TABLE IF NOT EXISTS "remote_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_key" text NOT NULL,
	"display_name" text NOT NULL,
	"service" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_secret_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"retention_acknowledged" boolean DEFAULT false NOT NULL,
	"qualification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qualified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "remote_agent_profiles_service_check" CHECK ("remote_agent_profiles"."service" in ('anthropic_managed_agents', 'aws_bedrock_agentcore_harness'))
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "remote_agent_profiles" ADD CONSTRAINT "remote_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "remote_agent_profiles" ADD CONSTRAINT "remote_agent_profiles_credential_secret_id_company_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_agent_profiles_company_idx" ON "remote_agent_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "remote_agent_profiles_company_key_uq" ON "remote_agent_profiles" USING btree ("company_id","profile_key");--> statement-breakpoint
INSERT INTO "remote_agent_profiles" (
	"id", "company_id", "profile_key", "display_name", "service", "configuration",
	"credential_secret_id", "enabled", "retention_acknowledged", "qualification",
	"qualified_at", "created_at", "updated_at"
)
SELECT
	"id", "company_id", "profile_key", "display_name", 'anthropic_managed_agents',
	jsonb_build_object(
		'anthropicAgentId', "anthropic_agent_id",
		'agentVersion', "agent_version",
		'environmentId', "environment_id",
		'betaVersion', "beta_version",
		'defaultModel', "default_model",
		'defaultMaxListCostCents', "default_max_list_cost_cents"
	),
	"api_key_secret_id", "enabled", "retention_acknowledged", "qualification",
	"qualified_at", "created_at", "updated_at"
FROM "managed_agent_profiles"
ON CONFLICT ("company_id", "profile_key") DO NOTHING;
