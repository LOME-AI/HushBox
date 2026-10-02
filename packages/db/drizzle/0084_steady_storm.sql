CREATE TABLE "growth_hourly_product_entry" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"visitors" integer NOT NULL,
	"overflow" boolean DEFAULT false NOT NULL,
	CONSTRAINT "growth_hourly_product_entry_hour_unique" UNIQUE("hour"),
	CONSTRAINT "growth_hourly_product_entry_hour_utc" CHECK ("growth_hourly_product_entry"."hour" = date_trunc('hour', "growth_hourly_product_entry"."hour", 'UTC')),
	CONSTRAINT "growth_hourly_product_entry_visitors_non_negative" CHECK ("growth_hourly_product_entry"."visitors" >= 0)
);
