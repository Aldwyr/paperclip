ALTER TABLE "connection_grant_members" DROP CONSTRAINT IF EXISTS "connection_grant_members_grant_id_connection_grants_id_fk";
--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_company_id_uq" UNIQUE("company_id","id");--> statement-breakpoint
ALTER TABLE "connection_grant_members" ADD CONSTRAINT "connection_grant_members_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE cascade ON UPDATE no action;
