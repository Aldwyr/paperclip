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
CREATE UNIQUE INDEX IF NOT EXISTS "provider_trace_records_run_unique" ON "provider_trace_records" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_trace_records_expiry_idx" ON "provider_trace_records" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_trace_records_company_created_idx" ON "provider_trace_records" USING btree ("company_id","created_at");--> statement-breakpoint
-- Compatibility repair: databases that ran this branch's former 0226 migration
-- have a journal timestamp newer than master's 0226_tan_colossus and can skip it.
-- Reassert the master index here, after every former branch migration timestamp.
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. IF NOT EXISTS makes this a no-op on databases that already ran 0226_tan_colossus.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_disposition_repair_idempotency_uq" ON "agent_wakeup_requests" USING btree ("company_id","idempotency_key") WHERE "agent_wakeup_requests"."idempotency_key" LIKE 'issue_disposition_repair:%' AND "agent_wakeup_requests"."status" <> 'skipped';
