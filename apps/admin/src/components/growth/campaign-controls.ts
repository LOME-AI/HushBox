import { GROWTH_DIRECT_CAMPAIGN, GROWTH_UNKNOWN_CAMPAIGN } from '@hushbox/shared';
import type { AdminOpWire, GrowthCampaignStatus } from '@hushbox/shared';

export const CAMPAIGN_CREATE_OP = 'growth.campaign.create';
export const CAMPAIGN_ARCHIVE_OP = 'growth.campaign.archive';

/**
 * Whether to draw the campaign create and archive controls.
 *
 * The answer comes from the operations catalogue the screen was served, which
 * the plane already filtered by the caller's role — a viewer receives the growth
 * reads and no mutation. Nothing here reads a role: re-deciding an authorization
 * question the server has answered would be a second implementation of it, and
 * the two would drift.
 *
 * Drawing the controls is presentation only. The route stage refuses a viewer's
 * mutation and the engine refuses it again, so a control drawn by mistake
 * produces a refusal rather than an effect.
 */
export function canManageCampaigns(ops?: readonly AdminOpWire[]): boolean {
  if (ops === undefined) return false;
  const named = new Set(ops.map((op) => op.name));
  return named.has(CAMPAIGN_CREATE_OP) && named.has(CAMPAIGN_ARCHIVE_OP);
}

/**
 * The refusal of these two is the server's; this set only keeps the button off a
 * row the server would refuse. If it ever disagrees with the operation, the
 * operation wins and the reader sees a refusal instead of a hidden button.
 */
const SEEDED_TAGS: ReadonlySet<string> = new Set([GROWTH_DIRECT_CAMPAIGN, GROWTH_UNKNOWN_CAMPAIGN]);

/** Whether the archive control belongs on this campaign's row. */
export function isArchivable(
  campaign: Readonly<{ tag: string; status: GrowthCampaignStatus }>
): boolean {
  return campaign.status === 'active' && !SEEDED_TAGS.has(campaign.tag);
}
