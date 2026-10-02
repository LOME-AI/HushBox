CREATE VIEW "public"."acquisition_sources" AS (
    select
      date_trunc('week', "users"."created_at", 'UTC') as user_created_week,
      "user_acquisition"."campaign" as campaign,
      "user_acquisition"."self_reported_channel"::text as self_reported_channel,
      "user_acquisition"."self_reported_context"::text as self_reported_context,
      coalesce("user_acquisition"."self_reported_channel"::text, "user_acquisition"."campaign") as primary_source
    from "user_acquisition"
    join "users" on "users"."id" = "user_acquisition"."user_id"
  );--> statement-breakpoint
CREATE VIEW "public"."funnel_weekly" AS (
    select
      coalesce(anonymous.week, ladder.week) as week,
      coalesce(anonymous.campaign, ladder.campaign) as campaign,
      coalesce(anonymous.visitors_daily_summed, 0) as visitors_daily_summed,
      coalesce(anonymous.signup_clicks_hourly_summed, 0) as signup_clicks_hourly_summed,
      coalesce(ladder.started, 0) as started,
      coalesce(ladder.finished, 0) as finished,
      coalesce(ladder.verified, 0) as verified,
      coalesce(ladder.activated, 0) as activated,
      coalesce(ladder.returned_week_1, 0) as returned_week_1,
      coalesce(ladder.first_paid, 0) as first_paid,
      coalesce(ladder.revenue_nano_usd, 0) as revenue_nano_usd
    from (
      select
        coalesce(campaign_visitors.week, signup_clicks.week) as week,
        coalesce(campaign_visitors.campaign, signup_clicks.campaign) as campaign,
        coalesce(campaign_visitors.total, 0) as visitors_daily_summed,
        coalesce(signup_clicks.total, 0) as signup_clicks_hourly_summed
      from (
        select
          date_trunc('week', campaign_days.bucket, 'UTC') as week,
          campaign_days.campaign as campaign,
          sum(campaign_days.busiest_page)::integer as total
        from (
          select
            "growth_campaign_paths"."bucket" as bucket,
            "growth_campaign_paths"."campaign" as campaign,
            max("growth_campaign_paths"."visitors") as busiest_page
          from "growth_campaign_paths"
          where "growth_campaign_paths"."grain" = 'day'
          group by 1, 2
        ) campaign_days
        group by 1, 2
      ) campaign_visitors
      full outer join (
        select
          date_trunc('week', signup_hours.hour, 'UTC') as week,
          signup_hours.campaign as campaign,
          sum(signup_hours.busiest_page)::integer as total
        from (
          select
            "growth_hourly_events"."hour" as hour,
            "growth_hourly_events"."campaign" as campaign,
            max("growth_hourly_events"."visitors") as busiest_page
          from "growth_hourly_events"
          where "growth_hourly_events"."event_name" = 'link:/signup'
          group by 1, 2
        ) signup_hours
        group by 1, 2
      ) signup_clicks
        on signup_clicks.week = campaign_visitors.week
       and signup_clicks.campaign = campaign_visitors.campaign
    ) anonymous
    full outer join (

    select
      coalesce(started_weeks.week, cohort_weeks.week) as week,
      coalesce(started_weeks.campaign, cohort_weeks.campaign) as campaign,
      coalesce(started_weeks.started, 0) as started,
      coalesce(cohort_weeks.finished, 0) as finished,
      coalesce(cohort_weeks.verified, 0) as verified,
      coalesce(cohort_weeks.activated, 0) as activated,
      coalesce(cohort_weeks.returned_week_1, 0) as returned_week_1,
      coalesce(cohort_weeks.first_paid, 0) as first_paid,
      coalesce(cohort_weeks.revenue_nano_usd, 0) as revenue_nano_usd
    from (
      select
        date_trunc('week', "growth_hourly_funnel"."hour", 'UTC') as week,
        "growth_hourly_funnel"."campaign" as campaign,
        sum("growth_hourly_funnel"."registrations")::integer as started
      from "growth_hourly_funnel"
      where "growth_hourly_funnel"."step" = 'started'
      group by 1, 2
    ) started_weeks
    full outer join (
      select
        date_trunc('week', "users"."created_at", 'UTC') as week,
        "user_acquisition"."campaign" as campaign,
        count(*)::integer as finished,
        (count(*) filter (where "users"."email_verified"))::integer as verified,
        (count(*) filter (where account_facts.activated))::integer as activated,
        (count(*) filter (where account_facts.returned_week_1))::integer as returned_week_1,
        (count(*) filter (where account_facts.first_paid))::integer as first_paid,
        sum(account_facts.revenue_nano_usd)::bigint as revenue_nano_usd
      from "user_acquisition"
      join "users" on "users"."id" = "user_acquisition"."user_id"
      join lateral (
        select
          exists (
            select 1 from "usage_records"
            where "usage_records"."sender_user_id" = "users"."id"
          ) as activated,
          exists (
            select 1 from "usage_records"
            where "usage_records"."sender_user_id" = "users"."id"
              and "usage_records"."created_at" >= "users"."created_at" + interval '7 days'
          ) as returned_week_1,
          exists (
            select 1 from "payments"
            where "payments"."user_id" = "users"."id"
              and "payments"."status" = 'completed'
          ) as first_paid,
          (
            select coalesce(sum("ledger_entries"."amount_nano_usd"), 0)
            from "ledger_entries"
            join "wallets" on "wallets"."id" = "ledger_entries"."wallet_id"
            where "wallets"."user_id" = "users"."id"
              and "wallets"."type" = 'purchased'
              and "ledger_entries"."kind" in ('deposit', 'clawback', 'refund')
          ) as revenue_nano_usd
      ) account_facts on true
      group by 1, 2
    ) cohort_weeks
      on cohort_weeks.week = started_weeks.week
     and cohort_weeks.campaign = started_weeks.campaign
  ) ladder
      on ladder.week = anonymous.week
     and ladder.campaign = anonymous.campaign
  );--> statement-breakpoint
CREATE VIEW "public"."growth_weekly" AS (

    select
      coalesce(started_weeks.week, cohort_weeks.week) as week,
      coalesce(started_weeks.campaign, cohort_weeks.campaign) as campaign,
      coalesce(started_weeks.started, 0) as started,
      coalesce(cohort_weeks.finished, 0) as finished,
      coalesce(cohort_weeks.verified, 0) as verified,
      coalesce(cohort_weeks.activated, 0) as activated,
      coalesce(cohort_weeks.returned_week_1, 0) as returned_week_1,
      coalesce(cohort_weeks.first_paid, 0) as first_paid,
      coalesce(cohort_weeks.revenue_nano_usd, 0) as revenue_nano_usd
    from (
      select
        date_trunc('week', "growth_hourly_funnel"."hour", 'UTC') as week,
        "growth_hourly_funnel"."campaign" as campaign,
        sum("growth_hourly_funnel"."registrations")::integer as started
      from "growth_hourly_funnel"
      where "growth_hourly_funnel"."step" = 'started'
      group by 1, 2
    ) started_weeks
    full outer join (
      select
        date_trunc('week', "users"."created_at", 'UTC') as week,
        "user_acquisition"."campaign" as campaign,
        count(*)::integer as finished,
        (count(*) filter (where "users"."email_verified"))::integer as verified,
        (count(*) filter (where account_facts.activated))::integer as activated,
        (count(*) filter (where account_facts.returned_week_1))::integer as returned_week_1,
        (count(*) filter (where account_facts.first_paid))::integer as first_paid,
        sum(account_facts.revenue_nano_usd)::bigint as revenue_nano_usd
      from "user_acquisition"
      join "users" on "users"."id" = "user_acquisition"."user_id"
      join lateral (
        select
          exists (
            select 1 from "usage_records"
            where "usage_records"."sender_user_id" = "users"."id"
          ) as activated,
          exists (
            select 1 from "usage_records"
            where "usage_records"."sender_user_id" = "users"."id"
              and "usage_records"."created_at" >= "users"."created_at" + interval '7 days'
          ) as returned_week_1,
          exists (
            select 1 from "payments"
            where "payments"."user_id" = "users"."id"
              and "payments"."status" = 'completed'
          ) as first_paid,
          (
            select coalesce(sum("ledger_entries"."amount_nano_usd"), 0)
            from "ledger_entries"
            join "wallets" on "wallets"."id" = "ledger_entries"."wallet_id"
            where "wallets"."user_id" = "users"."id"
              and "wallets"."type" = 'purchased'
              and "ledger_entries"."kind" in ('deposit', 'clawback', 'refund')
          ) as revenue_nano_usd
      ) account_facts on true
      group by 1, 2
    ) cohort_weeks
      on cohort_weeks.week = started_weeks.week
     and cohort_weeks.campaign = started_weeks.campaign
  );--> statement-breakpoint
CREATE VIEW "public"."marketing_daily" AS (
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
    where "growth_visitors"."grain" = 'day'
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
    where "growth_paths"."grain" = 'day'
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
    where "growth_referrers"."grain" = 'day'
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
    where "growth_campaign_paths"."grain" = 'day'
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
    where "growth_geo"."grain" = 'day'
  );--> statement-breakpoint
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
  );