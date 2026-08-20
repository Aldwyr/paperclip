CREATE TABLE "connection_grant_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_grant_members_subject_type_check" CHECK ("connection_grant_members"."subject_type" in ('user'))
);
--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT "connection_grants_kind_check";--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT "connection_grants_subject_check";--> statement-breakpoint
ALTER TABLE "connection_grants" DROP CONSTRAINT "connection_grants_default_check";--> statement-breakpoint
DROP INDEX "connection_grants_default_uq";--> statement-breakpoint
UPDATE "connection_grants" SET "kind" = 'organization' WHERE "kind" = 'workspace';--> statement-breakpoint
INSERT INTO "connection_grants" (
	"company_id", "connection_id", "kind", "credential_secret_refs", "status", "is_default",
	"created_by_agent_id", "created_by_user_id", "created_at", "updated_at"
)
SELECT
	c."company_id", c."id", 'organization', c."credential_secret_refs", 'active', true,
	c."created_by_agent_id", c."created_by_user_id", c."created_at", c."updated_at"
FROM "tool_connections" c
WHERE NOT EXISTS (
	SELECT 1 FROM "connection_grants" g
	WHERE g."connection_id" = c."id" AND g."is_default" = true
);--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN "credential_policy" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_grant_members" ADD CONSTRAINT "connection_grant_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grant_members" ADD CONSTRAINT "connection_grant_members_grant_id_connection_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."connection_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_grant_members_company_subject_idx" ON "connection_grant_members" USING btree ("company_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_grant_members_grant_subject_uq" ON "connection_grant_members" USING btree ("grant_id","subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connection_grants_default_uq" ON "connection_grants" USING btree ("connection_id") WHERE "connection_grants"."is_default" = true and "connection_grants"."kind" = 'organization';--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_kind_check" CHECK ("connection_grants"."kind" in ('organization', 'user'));--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_subject_check" CHECK (("connection_grants"."kind" = 'user' and "connection_grants"."subject_user_id" is not null) or ("connection_grants"."kind" = 'organization' and "connection_grants"."subject_user_id" is null));--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_default_check" CHECK ("connection_grants"."is_default" = false or "connection_grants"."kind" = 'organization');--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_credential_policy_check" CHECK ("tool_connections"."credential_policy" in ('shared', 'per_user', 'per_user_with_fallback'));
