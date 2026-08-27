CREATE TABLE IF NOT EXISTS "issue_question_response_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"interaction_id" uuid NOT NULL,
	"source_run_id" uuid,
	"target_run_id" uuid,
	"target_turn_id" text,
	"correlation_id" text NOT NULL,
	"payload_sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"delivery_mode" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_question_response_deliveries_status_check" CHECK ("issue_question_response_deliveries"."status" IN ('pending', 'delivering', 'delivered', 'fallback_queued', 'failed')),
	CONSTRAINT "issue_question_response_deliveries_mode_check" CHECK ("issue_question_response_deliveries"."delivery_mode" IS NULL OR "issue_question_response_deliveries"."delivery_mode" IN ('steered', 'coalesced', 'wake_fallback'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "managed_agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"profile_key" text NOT NULL,
	"display_name" text NOT NULL,
	"service" text DEFAULT 'anthropic_managed_agents' NOT NULL,
	"anthropic_agent_id" text NOT NULL,
	"agent_version" text NOT NULL,
	"environment_id" text NOT NULL,
	"beta_version" text DEFAULT 'managed-agents-2026-04-01' NOT NULL,
	"default_model" text DEFAULT 'claude-sonnet-5' NOT NULL,
	"default_max_list_cost_cents" integer DEFAULT 100 NOT NULL,
	"api_key_secret_id" uuid NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"retention_acknowledged" boolean DEFAULT false NOT NULL,
	"qualification" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qualified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_agent_profiles_service_check" CHECK ("managed_agent_profiles"."service" = 'anthropic_managed_agents'),
	CONSTRAINT "managed_agent_profiles_beta_check" CHECK ("managed_agent_profiles"."beta_version" = 'managed-agents-2026-04-01'),
	CONSTRAINT "managed_agent_profiles_positive_budget_check" CHECK ("managed_agent_profiles"."default_max_list_cost_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_trace_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"status" text DEFAULT 'capturing' NOT NULL,
	"provider" text NOT NULL,
	"trace_ref" text NOT NULL,
	"frame_count" integer DEFAULT 0 NOT NULL,
	"byte_count" bigint DEFAULT 0 NOT NULL,
	"digest" text,
	"reason" text,
	"requested_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "addressee_user_id" text;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "issue_question_response_deliveries" ADD CONSTRAINT "issue_question_response_deliveries_target_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "managed_agent_profiles" ADD CONSTRAINT "managed_agent_profiles_api_key_secret_id_company_secrets_id_fk" FOREIGN KEY ("api_key_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "provider_trace_records" ADD CONSTRAINT "provider_trace_records_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "provider_trace_records" ADD CONSTRAINT "provider_trace_records_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
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
CREATE UNIQUE INDEX IF NOT EXISTS "issue_question_response_deliveries_interaction_uq" ON "issue_question_response_deliveries" USING btree ("interaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_question_response_deliveries_correlation_uq" ON "issue_question_response_deliveries" USING btree ("correlation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_question_response_deliveries_pending_idx" ON "issue_question_response_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_question_response_deliveries_company_issue_idx" ON "issue_question_response_deliveries" USING btree ("company_id","issue_id","created_at");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: This partial index covers a new question-response key prefix, so existing deployments have no matching rows; Drizzle applies migrations transactionally and cannot use CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_question_response_delivery_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'question-response:%' AND "agent_wakeup_requests"."status" NOT IN ('skipped', 'failed', 'cancelled');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "managed_agent_profiles_company_idx" ON "managed_agent_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "managed_agent_profiles_company_key_uq" ON "managed_agent_profiles" USING btree ("company_id","profile_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "managed_agent_profiles_company_resource_uq" ON "managed_agent_profiles" USING btree ("company_id","anthropic_agent_id","agent_version","environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_trace_records_run_unique" ON "provider_trace_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_trace_records_expiry_idx" ON "provider_trace_records" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_trace_records_company_created_idx" ON "provider_trace_records" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "remote_agent_profiles_company_idx" ON "remote_agent_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "remote_agent_profiles_company_key_uq" ON "remote_agent_profiles" USING btree ("company_id","profile_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_addressee_user_idx" ON "issue_thread_interactions" USING btree ("addressee_user_id");
