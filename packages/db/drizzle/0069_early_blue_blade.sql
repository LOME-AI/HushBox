ALTER TABLE "shared_links" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "shared_links" ADD CONSTRAINT "shared_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shared_links_created_by_idx" ON "shared_links" USING btree ("created_by");