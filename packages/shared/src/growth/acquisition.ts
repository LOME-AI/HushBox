import { z } from 'zod';

import { ROUTES } from '../platform/routes.ts';

import { GrowthChannel, GrowthSelfReportContext } from './enums.ts';
import { campaignTagSchema } from './patterns.ts';

/**
 * The platforms an account can be created from, and the source the
 * `device_platform` pgEnum is declared from — so the column's members and
 * their order are this tuple's, and neither side is a list kept in step with
 * the other. Narrower than the app's build targets: `android-direct` is a
 * distribution channel, and the client maps it to `android` before it reaches
 * any API, as it already does for device tokens.
 */
export const ACQUISITION_PLATFORMS = ['ios', 'android', 'web'] as const;

/**
 * The destinations a marketing click means the visitor is entering the
 * product, rather than reading another page of the site: the signup page and
 * the chat application, which the site's primary call to action points at.
 *
 * The funnel's entry step counts the auto-captured event names these routes
 * derive, so widening what that step measures is adding a route here — a later
 * landing page or pricing call to action needs no other edit and no new view.
 *
 * The entry step is computed when its view is read rather than stored, so
 * adding a route here changes the figure reported for weeks already recorded
 * as soon as the regenerated view is in place, not only for the weeks that
 * follow. A week's figure sums bucket maxima taken over the rows the list
 * admits, so widening the list moves a past week up or leaves it where it
 * was; the stored event rows keep what they recorded, so the narrower figure
 * stays derivable by running the shorter list against them.
 *
 * The names are always derived, never written beside this tuple: a literal
 * would be a second spelling of a name the beacon already produces from the
 * page's own markup, and the two would have to agree to be correct.
 */
export const PRODUCT_ENTRY_ROUTES = [ROUTES.SIGNUP, ROUTES.CHAT] as const;

/** Zod schema for a signup platform. */
export const AcquisitionPlatform = z.enum(ACQUISITION_PLATFORMS);
/** TypeScript type for a signup platform. */
export type AcquisitionPlatform = z.infer<typeof AcquisitionPlatform>;

/**
 * What registration records about where an account came from. Written once,
 * inside the registration transaction.
 *
 * `platform` is required because web, iOS and Android signups must be
 * distinguishable from day one and cannot be backfilled. `campaign` is the tag
 * the signup link carried; its absence is recorded as `direct` by the writer,
 * so the column is never null and the counts never need a null branch.
 */
export const acquisitionSchema = z.object({
  campaign: campaignTagSchema.optional(),
  platform: AcquisitionPlatform,
});

/** TypeScript type for the acquisition fields on the registration body. */
export type Acquisition = z.infer<typeof acquisitionSchema>;

/**
 * The two verbs the channel prompt sends. A discriminated union of strict
 * objects rather than one object with optional fields: a skip cannot carry a
 * channel and an answer cannot omit one, and neither can smuggle a field past
 * the schema — stripping an unknown key would have made this route the one
 * place a typed value could arrive unnoticed.
 *
 * `answer` is first-answer-wins and `skip` is monotonic, both server-side: the
 * client renders whichever prompt the server says is due and records nothing on
 * the device.
 */
export const selfReportActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('answer'),
    channel: GrowthChannel,
    context: GrowthSelfReportContext,
  }),
  z.strictObject({
    action: z.literal('skip'),
    context: GrowthSelfReportContext,
  }),
]);

/** TypeScript type for a channel-prompt action. */
export type SelfReportAction = z.infer<typeof selfReportActionSchema>;

/**
 * What the account's acquisition-source read returns: which prompt is due, or
 * `null` for none. The server owns the predicate; the field is required so a
 * client cannot read a missing key as "nothing due".
 */
export const acquisitionSourceViewSchema = z.object({
  duePrompt: GrowthSelfReportContext.nullable(),
});

/** TypeScript type for the acquisition-source read. */
export type AcquisitionSourceView = z.infer<typeof acquisitionSourceViewSchema>;
