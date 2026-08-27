ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "addressee_user_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_addressee_user_idx" ON "issue_thread_interactions" USING btree ("addressee_user_id");
