CREATE TYPE "public"."growth_channel" AS ENUM('podcast', 'search', 'social', 'friend', 'ad', 'newsletter', 'article', 'other');--> statement-breakpoint
CREATE TYPE "public"."growth_self_report_context" AS ENUM('post_signup', 'first_payment');--> statement-breakpoint
CREATE TABLE "user_acquisition" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"campaign" text NOT NULL,
	"platform" "device_platform" NOT NULL,
	"self_reported_channel" "growth_channel",
	"self_reported_context" "growth_self_report_context",
	"self_reported_at" timestamp with time zone,
	"self_report_skipped" "growth_self_report_context",
	CONSTRAINT "user_acquisition_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "user_acquisition_self_report_complete" CHECK (("user_acquisition"."self_reported_channel" is null) = ("user_acquisition"."self_reported_context" is null)
        and ("user_acquisition"."self_reported_channel" is null) = ("user_acquisition"."self_reported_at" is null))
);
--> statement-breakpoint
ALTER TABLE "user_acquisition" ADD CONSTRAINT "user_acquisition_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_acquisition" ADD CONSTRAINT "user_acquisition_campaign_campaigns_tag_fk" FOREIGN KEY ("campaign") REFERENCES "public"."campaigns"("tag") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_acquisition_campaign_idx" ON "user_acquisition" USING btree ("campaign");