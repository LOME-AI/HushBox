DROP VIEW "public"."marketing_hourly";--> statement-breakpoint
CREATE VIEW "public"."marketing_hourly" AS (
    select
      "growth_visitors"."bucket" as bucket,
      'total'::text as family,
      null::text as path,
      null::text as referrer_host,
      null::text as campaign,
      null::text as country,
      null::text as region,
      null::text as device,
      "growth_visitors"."visitors" as visitors,
      null::integer as landings,
      "growth_visitors"."overflow" as overflow
    from "growth_visitors"
    where "growth_visitors"."grain" = 'hour'
    union all
    select
      "growth_paths"."bucket",
      'path'::text,
      "growth_paths"."path",
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      "growth_paths"."visitors",
      "growth_paths"."landings",
      "growth_paths"."overflow"
    from "growth_paths"
    where "growth_paths"."grain" = 'hour'
    union all
    select
      "growth_referrers"."bucket",
      'referrer'::text,
      "growth_referrers"."path",
      "growth_referrers"."referrer_host",
      null::text,
      null::text,
      null::text,
      null::text,
      "growth_referrers"."visitors",
      null::integer,
      "growth_referrers"."overflow"
    from "growth_referrers"
    where "growth_referrers"."grain" = 'hour'
    union all
    select
      "growth_campaign_paths"."bucket",
      'campaign'::text,
      "growth_campaign_paths"."path",
      null::text,
      "growth_campaign_paths"."campaign",
      null::text,
      null::text,
      null::text,
      "growth_campaign_paths"."visitors",
      null::integer,
      "growth_campaign_paths"."overflow"
    from "growth_campaign_paths"
    where "growth_campaign_paths"."grain" = 'hour'
    union all
    select
      "growth_geo"."bucket",
      'geo'::text,
      null::text,
      null::text,
      null::text,
      "growth_geo"."country",
      "growth_geo"."region",
      "growth_geo"."device"::text,
      "growth_geo"."visitors",
      null::integer,
      "growth_geo"."overflow"
    from "growth_geo"
    where "growth_geo"."grain" = 'hour'
  
    union all
    select
      "growth_hourly_product_entry"."hour",
      'product-entry'::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      null::text,
      "growth_hourly_product_entry"."visitors",
      null::integer,
      "growth_hourly_product_entry"."overflow"
    from "growth_hourly_product_entry"
  );