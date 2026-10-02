CREATE TYPE "public"."growth_campaign_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."growth_device" AS ENUM('desktop', 'mobile', 'tablet', 'other');--> statement-breakpoint
CREATE TYPE "public"."growth_funnel_step" AS ENUM('started');--> statement-breakpoint
CREATE TYPE "public"."growth_grain" AS ENUM('hour', 'day');--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tag" text NOT NULL,
	"label" text NOT NULL,
	"status" "growth_campaign_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_tag_unique" UNIQUE("tag"),
	CONSTRAINT "campaigns_tag_format" CHECK ("campaigns"."tag" ~ '^[a-z0-9-]{1,40}$'),
	CONSTRAINT "campaigns_label_length" CHECK (length("campaigns"."label") <= 100)
);
--> statement-breakpoint
CREATE TABLE "growth_campaign_paths" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"grain" "growth_grain" NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"campaign" text NOT NULL,
	"path" text NOT NULL,
	"visitors" integer NOT NULL,
	"overflow" boolean DEFAULT false NOT NULL,
	CONSTRAINT "growth_campaign_paths_grain_bucket_campaign_path_unique" UNIQUE("grain","bucket","campaign","path"),
	CONSTRAINT "growth_campaign_paths_bucket_grain" CHECK ("growth_campaign_paths"."bucket" = date_trunc("growth_campaign_paths"."grain"::text, "growth_campaign_paths"."bucket", 'UTC')),
	CONSTRAINT "growth_campaign_paths_path_format" CHECK ("growth_campaign_paths"."path" ~ '^/[a-z0-9/-]*$' and length("growth_campaign_paths"."path") <= 200),
	CONSTRAINT "growth_campaign_paths_visitors_non_negative" CHECK ("growth_campaign_paths"."visitors" >= 0)
);
--> statement-breakpoint
CREATE TABLE "growth_daily_path_reach" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"day" date NOT NULL,
	"landing_path" text NOT NULL,
	"reached_path" text NOT NULL,
	"visitors" integer NOT NULL,
	CONSTRAINT "growth_daily_path_reach_day_landing_reached_unique" UNIQUE("day","landing_path","reached_path"),
	CONSTRAINT "growth_daily_path_reach_landing_path_format" CHECK ("growth_daily_path_reach"."landing_path" ~ '^/[a-z0-9/-]*$' and length("growth_daily_path_reach"."landing_path") <= 200),
	CONSTRAINT "growth_daily_path_reach_reached_path_format" CHECK ("growth_daily_path_reach"."reached_path" ~ '^/[a-z0-9/-]*$' and length("growth_daily_path_reach"."reached_path") <= 200),
	CONSTRAINT "growth_daily_path_reach_visitors_non_negative" CHECK ("growth_daily_path_reach"."visitors" >= 0)
);
--> statement-breakpoint
CREATE TABLE "growth_geo" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"grain" "growth_grain" NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"region" text DEFAULT '' NOT NULL,
	"device" "growth_device" NOT NULL,
	"visitors" integer NOT NULL,
	"overflow" boolean DEFAULT false NOT NULL,
	CONSTRAINT "growth_geo_grain_bucket_country_region_device_unique" UNIQUE("grain","bucket","country","region","device"),
	CONSTRAINT "growth_geo_bucket_grain" CHECK ("growth_geo"."bucket" = date_trunc("growth_geo"."grain"::text, "growth_geo"."bucket", 'UTC')),
	CONSTRAINT "growth_geo_country_format" CHECK ("growth_geo"."country" ~ '^[A-Z]{2}$' or "growth_geo"."country" = ''),
	CONSTRAINT "growth_geo_region_format" CHECK ("growth_geo"."region" ~ '^[A-Z]{2}$' or "growth_geo"."region" = ''),
	CONSTRAINT "growth_geo_region_requires_us" CHECK ("growth_geo"."region" = '' or "growth_geo"."country" = 'US'),
	CONSTRAINT "growth_geo_visitors_non_negative" CHECK ("growth_geo"."visitors" >= 0)
);
--> statement-breakpoint
CREATE TABLE "growth_hourly_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"campaign" text NOT NULL,
	"event_name" text NOT NULL,
	"path" text NOT NULL,
	"visitors" integer NOT NULL,
	"overflow" boolean DEFAULT false NOT NULL,
	CONSTRAINT "growth_hourly_events_hour_campaign_event_path_unique" UNIQUE("hour","campaign","event_name","path"),
	CONSTRAINT "growth_hourly_events_hour_utc" CHECK ("growth_hourly_events"."hour" = date_trunc('hour', "growth_hourly_events"."hour", 'UTC')),
	CONSTRAINT "growth_hourly_events_event_name_format" CHECK ("growth_hourly_events"."event_name" ~ '^[a-z0-9][a-z0-9:/._-]*$' and length("growth_hourly_events"."event_name") <= 80),
	CONSTRAINT "growth_hourly_events_path_format" CHECK ("growth_hourly_events"."path" ~ '^/[a-z0-9/-]*$' and length("growth_hourly_events"."path") <= 200),
	CONSTRAINT "growth_hourly_events_visitors_non_negative" CHECK ("growth_hourly_events"."visitors" >= 0)
);
--> statement-breakpoint
CREATE TABLE "growth_hourly_funnel" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"campaign" text NOT NULL,
	"step" "growth_funnel_step" NOT NULL,
	"registrations" integer NOT NULL,
	CONSTRAINT "growth_hourly_funnel_hour_campaign_step_unique" UNIQUE("hour","campaign","step"),
	CONSTRAINT "growth_hourly_funnel_hour_utc" CHECK ("growth_hourly_funnel"."hour" = date_trunc('hour', "growth_hourly_funnel"."hour", 'UTC')),
	CONSTRAINT "growth_hourly_funnel_registrations_non_negative" CHECK ("growth_hourly_funnel"."registrations" >= 0)
);
--> statement-breakpoint
CREATE TABLE "growth_paths" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"grain" "growth_grain" NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"path" text NOT NULL,
	"visitors" integer NOT NULL,
	"landings" integer NOT NULL,
	"overflow" boolean DEFAULT false NOT NULL,
	CONSTRAINT "growth_paths_grain_bucket_path_unique" UNIQUE("grain","bucket","path"),
	CONSTRAINT "growth_paths_bucket_grain" CHECK ("growth_paths"."bucket" = date_trunc("growth_paths"."grain"::text, "growth_paths"."bucket", 'UTC')),
	CONSTRAINT "growth_paths_path_format" CHECK ("growth_paths"."path" ~ '^/[a-z0-9/-]*$' and length("growth_paths"."path") <= 200),
	CONSTRAINT "growth_paths_visitors_non_negative" CHECK ("growth_paths"."visitors" >= 0),
	CONSTRAINT "growth_paths_landings_within_visitors" CHECK ("growth_paths"."landings" >= 0 and "growth_paths"."landings" <= "growth_paths"."visitors")
);
--> statement-breakpoint
CREATE TABLE "growth_referrers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"grain" "growth_grain" NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"path" text NOT NULL,
	"referrer_host" text NOT NULL,
	"visitors" integer NOT NULL,
	"overflow" boolean DEFAULT false NOT NULL,
	CONSTRAINT "growth_referrers_grain_bucket_path_host_unique" UNIQUE("grain","bucket","path","referrer_host"),
	CONSTRAINT "growth_referrers_bucket_grain" CHECK ("growth_referrers"."bucket" = date_trunc("growth_referrers"."grain"::text, "growth_referrers"."bucket", 'UTC')),
	CONSTRAINT "growth_referrers_path_format" CHECK ("growth_referrers"."path" ~ '^/[a-z0-9/-]*$' and length("growth_referrers"."path") <= 200),
	CONSTRAINT "growth_referrers_host_format" CHECK ("growth_referrers"."referrer_host" ~ '^[a-z0-9][a-z0-9.-]*$' and length("growth_referrers"."referrer_host") <= 253),
	CONSTRAINT "growth_referrers_visitors_non_negative" CHECK ("growth_referrers"."visitors" >= 0)
);
--> statement-breakpoint
CREATE TABLE "growth_visitors" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"grain" "growth_grain" NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"visitors" integer NOT NULL,
	"overflow" boolean DEFAULT false NOT NULL,
	CONSTRAINT "growth_visitors_grain_bucket_unique" UNIQUE("grain","bucket"),
	CONSTRAINT "growth_visitors_bucket_grain" CHECK ("growth_visitors"."bucket" = date_trunc("growth_visitors"."grain"::text, "growth_visitors"."bucket", 'UTC')),
	CONSTRAINT "growth_visitors_visitors_non_negative" CHECK ("growth_visitors"."visitors" >= 0)
);
--> statement-breakpoint
ALTER TABLE "growth_campaign_paths" ADD CONSTRAINT "growth_campaign_paths_campaign_campaigns_tag_fk" FOREIGN KEY ("campaign") REFERENCES "public"."campaigns"("tag") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_hourly_events" ADD CONSTRAINT "growth_hourly_events_campaign_campaigns_tag_fk" FOREIGN KEY ("campaign") REFERENCES "public"."campaigns"("tag") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_hourly_funnel" ADD CONSTRAINT "growth_hourly_funnel_campaign_campaigns_tag_fk" FOREIGN KEY ("campaign") REFERENCES "public"."campaigns"("tag") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "growth_campaign_paths_campaign_idx" ON "growth_campaign_paths" USING btree ("campaign");--> statement-breakpoint
CREATE INDEX "growth_hourly_events_campaign_idx" ON "growth_hourly_events" USING btree ("campaign");--> statement-breakpoint
CREATE INDEX "growth_hourly_funnel_campaign_idx" ON "growth_hourly_funnel" USING btree ("campaign");--> statement-breakpoint
CREATE INDEX "growth_paths_path_bucket_idx" ON "growth_paths" USING btree ("path","bucket");--> statement-breakpoint
CREATE INDEX "growth_referrers_host_bucket_idx" ON "growth_referrers" USING btree ("referrer_host","bucket");--> statement-breakpoint
-- The two tags every growth row falls back to: 'direct' when a visit carries no
-- campaign, 'unknown' when it carries one no campaign row claims. Both are
-- referents of rows kept forever, so the archive operation refuses them.
INSERT INTO "campaigns" ("tag", "label", "status") VALUES
	('direct', 'Direct', 'active'),
	('unknown', 'Unknown', 'active')
ON CONFLICT ("tag") DO NOTHING;
