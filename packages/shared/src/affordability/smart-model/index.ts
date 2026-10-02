/**
 * Smart Model's published surface. What a caller may ask for is an ANSWER — the
 * axis's cheapest option, the effort plan that fits a completion cap, what one
 * classifier answer named among the ids a turn presented. The apparatus behind
 * those answers stays behind the wall (`docs/BILLING.md` §Where the Code Lives):
 * the answer split, the per-dimension matchers and the budget ladder are absent
 * here, and a consumer reaching for one of them is evidence a producer is
 * missing rather than a case for widening this list.
 */

export * from './eligible-models.ts';
export * from './prompts.ts';
export { cheapestClassifierEffort, pickClassifiedEffortPlan } from './effort-dimension.ts';
export type { ClassifierEffortLevel } from './effort-dimension.ts';
export { resolveClassifierAnswer } from './answer-resolution.ts';
export type { ClassifierResolution } from './answer-resolution.ts';
