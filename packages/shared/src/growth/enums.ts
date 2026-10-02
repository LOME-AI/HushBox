import { z } from 'zod';

/**
 * The growth closed sets. Each is the single source feeding a pgEnum in
 * `packages/db`, the Zod schemas below, and the admin wire contracts — so
 * adding a member is a deliberate enum migration, never ad-hoc data. Order is
 * the order the pgEnum declares, which Postgres also uses to compare values.
 */

/** Scroll-depth thresholds. Fixed names rather than derived ones: they describe the page, not an element on it. */
export const GROWTH_SCROLL_EVENTS = ['scroll-25', 'scroll-50', 'scroll-75', 'scroll-100'] as const;

/** The coarse device families a request is classified into. Deliberately four buckets: anything finer is a fingerprinting surface for no metric anyone reads. */
export const GROWTH_DEVICE = ['desktop', 'mobile', 'tablet', 'other'] as const;

/** The two aggregate grains. A visitor active in two hours is a member of two hourly sets, so hours cannot be summed into a day and both grains are counted at write time. */
export const GROWTH_GRAIN = ['hour', 'day'] as const;

/** The closed set a person may name as where they heard about HushBox. No free-text alternative exists: the answer is read by a model through a read-only database role, and no scrub separates a genuine answer from an instruction. */
export const GROWTH_CHANNELS = [
  'podcast',
  'search',
  'social',
  'friend',
  'ad',
  'newsletter',
  'article',
  'other',
] as const;

/**
 * The two moments the channel question is asked, in the order they occur. The
 * order is load-bearing twice: the skip is one ordered value compared with `<`
 * so a later skip cannot be undone by a stale tab, and Postgres compares the
 * pgEnum by declaration order.
 */
export const GROWTH_SELF_REPORT_CONTEXT = ['post_signup', 'first_payment'] as const;

/** The registration funnel steps counted in Redis. `finished` is absent on purpose: it is derived from the account rows, so the one fact has one home. */
export const GROWTH_FUNNEL_STEP = ['started'] as const;

/** Campaign lifecycle. Archived, never deleted — a campaign row is the referent of growth rows kept forever, and the Reversibility Iron Law forbids an admin operation that destroys it. */
export const GROWTH_CAMPAIGN_STATUS = ['active', 'archived'] as const;

/*
 * Every schema below is annotated pure so a bundler may drop it, and with it
 * the tuple it names. That is load-bearing rather than cosmetic: the signed-in
 * app must ship none of these names, `scripts/verify-bundle.ts` reads the built
 * artifact to prove it, and a `z.enum(...)` call at module scope is something a
 * bundler cannot prove side-effect-free on its own — so without the annotation
 * the top-level `@hushbox/shared` barrel drags all of them into every app that
 * imports anything at all from it.
 */

/** Zod schema for a scroll-threshold name. */
export const GrowthScrollEvent = /* @__PURE__ */ z.enum(GROWTH_SCROLL_EVENTS);
/** TypeScript type for a scroll-threshold name. */
export type GrowthScrollEvent = z.infer<typeof GrowthScrollEvent>;

/** Zod schema for a device family. */
export const GrowthDevice = /* @__PURE__ */ z.enum(GROWTH_DEVICE);
/** TypeScript type for a device family. */
export type GrowthDevice = z.infer<typeof GrowthDevice>;

/** Zod schema for an aggregate grain. */
export const GrowthGrain = /* @__PURE__ */ z.enum(GROWTH_GRAIN);
/** TypeScript type for an aggregate grain. */
export type GrowthGrain = z.infer<typeof GrowthGrain>;

/** Zod schema for a self-reported channel. */
export const GrowthChannel = /* @__PURE__ */ z.enum(GROWTH_CHANNELS);
/** TypeScript type for a self-reported channel. */
export type GrowthChannel = z.infer<typeof GrowthChannel>;

/** Zod schema for the moment the channel question was asked. */
export const GrowthSelfReportContext = /* @__PURE__ */ z.enum(GROWTH_SELF_REPORT_CONTEXT);
/** TypeScript type for the moment the channel question was asked. */
export type GrowthSelfReportContext = z.infer<typeof GrowthSelfReportContext>;

/** Zod schema for a funnel step. */
export const GrowthFunnelStep = /* @__PURE__ */ z.enum(GROWTH_FUNNEL_STEP);
/** TypeScript type for a funnel step. */
export type GrowthFunnelStep = z.infer<typeof GrowthFunnelStep>;

/** Zod schema for a campaign's lifecycle state. */
export const GrowthCampaignStatus = /* @__PURE__ */ z.enum(GROWTH_CAMPAIGN_STATUS);
/** TypeScript type for a campaign's lifecycle state. */
export type GrowthCampaignStatus = z.infer<typeof GrowthCampaignStatus>;
