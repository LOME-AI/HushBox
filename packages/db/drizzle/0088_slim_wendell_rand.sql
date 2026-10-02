-- Every existing link is revoked: no URL holds a preimage of the placeholder hash below, so none can authenticate again.
UPDATE "shared_links" SET "revoked_at" = now() WHERE "revoked_at" IS NULL;--> statement-breakpoint
ALTER TABLE "shared_links" ADD COLUMN "link_auth_hash" "bytea";--> statement-breakpoint
UPDATE "shared_links" SET "link_auth_hash" = sha256(uuid_send(gen_random_uuid()));--> statement-breakpoint
ALTER TABLE "shared_links" ALTER COLUMN "link_auth_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_links" ADD CONSTRAINT "shared_links_link_auth_hash_unique" UNIQUE("link_auth_hash");
