import { GROWTH_CHANNELS, type GrowthChannel, type GrowthSourceCountWire } from '@hushbox/shared';

/**
 * How each closed-set channel is written on screen. The set is a database enum,
 * so a member added there needs a label here; the type below is what makes the
 * omission a compile error rather than a blank cell.
 */
export const CHANNEL_LABELS: Readonly<Record<GrowthChannel, string>> = {
  podcast: 'Podcast',
  search: 'Search',
  social: 'Social',
  friend: 'Friend or colleague',
  ad: 'Ad',
  newsletter: 'Newsletter',
  article: 'Article or review',
  other: 'Other',
};

/** How many accounts carrying one campaign named a channel. */
export interface SourceCampaignSplit {
  readonly campaign: string;
  readonly accounts: number;
}

/** One row of the sources panel. */
export interface SourceRow {
  /** The channel named, or null for the accounts that named none. */
  readonly channel: GrowthChannel | null;
  readonly label: string;
  readonly answers: number;
  readonly byCampaign: readonly SourceCampaignSplit[];
  /**
   * Accounts whose primary source is this channel. Null on the unanswered row:
   * an account that named nothing falls back to its campaign, so its primary
   * source is a campaign tag rather than any channel.
   */
  readonly primarySourceTotal: number | null;
}

export interface SourceSummary {
  readonly rows: readonly SourceRow[];
  readonly accounts: number;
  readonly answered: number;
  readonly answeredRate: number | null;
}

const UNANSWERED_LABEL = '(no answer)';

function isChannel(value: string | null): value is GrowthChannel {
  return value !== null && (GROWTH_CHANNELS as readonly string[]).includes(value);
}

/**
 * The sources panel's rows: the closed-set answers counted, split by the
 * campaign each answering account carried, with the accounts that answered
 * nothing kept as their own row rather than folded away.
 */
export function sourceSummary(counts: readonly GrowthSourceCountWire[]): SourceSummary {
  const answers = new Map<GrowthChannel | null, Map<string, number>>();
  const primaries = new Map<string, number>();
  let accounts = 0;
  let answered = 0;

  for (const count of counts) {
    accounts += count.accounts;
    const channel = isChannel(count.selfReportedChannel) ? count.selfReportedChannel : null;
    if (channel !== null) answered += count.accounts;
    const byCampaign = answers.get(channel) ?? new Map<string, number>();
    byCampaign.set(count.campaign, (byCampaign.get(count.campaign) ?? 0) + count.accounts);
    answers.set(channel, byCampaign);
    primaries.set(count.primarySource, (primaries.get(count.primarySource) ?? 0) + count.accounts);
  }

  const rows = [...answers.entries()].map(([channel, byCampaign]) => ({
    channel,
    label: channel === null ? UNANSWERED_LABEL : CHANNEL_LABELS[channel],
    answers: [...byCampaign.values()].reduce((total, value) => total + value, 0),
    byCampaign: [...byCampaign.entries()]
      .map(([campaign, value]) => ({ campaign, accounts: value }))
      .toSorted((left, right) => right.accounts - left.accounts),
    primarySourceTotal: channel === null ? null : (primaries.get(channel) ?? 0),
  }));

  // Answered channels by size, then the unanswered row — it is the panel's
  // denominator rather than one of its answers, so it reads last whatever
  // its size.
  const ordered = rows.toSorted((left, right) => {
    if (left.channel === null) return 1;
    if (right.channel === null) return -1;
    return right.answers - left.answers;
  });

  return {
    rows: ordered,
    accounts,
    answered,
    answeredRate: accounts === 0 ? null : answered / accounts,
  };
}
