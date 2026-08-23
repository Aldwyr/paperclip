ALTER TABLE "issues" ADD COLUMN "superseded_by_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "superseded_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "lifecycle_policy" text DEFAULT 'independent' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_superseded_by_issue_id_issues_id_fk" FOREIGN KEY ("superseded_by_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD CONSTRAINT "routine_runs_superseded_by_run_id_routine_runs_id_fk" FOREIGN KEY ("superseded_by_run_id") REFERENCES "public"."routine_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_superseded_by_issue_idx" ON "issues" USING btree ("superseded_by_issue_id");--> statement-breakpoint
CREATE INDEX "routine_runs_superseded_by_run_idx" ON "routine_runs" USING btree ("superseded_by_run_id");