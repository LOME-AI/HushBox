import { z } from 'zod';

/**
 * A campaign's operator-facing name — the one thing about a campaign a human
 * types. The bound below is the single authority for its length: it is
 * interpolated into the `campaigns.label` column check and enforced by the
 * admin contract that mints one, so an over-long label is refused at the
 * request boundary rather than surfacing as a constraint violation from the
 * database.
 */
export const GROWTH_CAMPAIGN_LABEL_MAX_LENGTH = 100;

/** The label as the minting operation accepts one: trimmed, non-blank, within the column's bound. */
export const campaignLabelSchema = z.string().trim().min(1).max(GROWTH_CAMPAIGN_LABEL_MAX_LENGTH);
