import * as React from 'react';
import { formatRate } from './format-rate.js';
import { RankedRow } from './ranked-bars.js';
import { sourceSummary } from './source-summary.js';
import type { SourceCampaignSplit, SourceRow } from './source-summary.js';
import type { GrowthSourceCountWire } from '@hushbox/shared';

/**
 * What each figure in this panel is called, from one definition the row, its
 * accessible name and the column line above them all read. Two spellings of one
 * figure read as two figures.
 */
const COLUMNS = {
  answers: 'Answers',
  share: 'Share of answers',
  byCampaign: 'By campaign',
  primary: 'Primary source total',
} as const;

/**
 * A channel somebody named, with every figure the row states.
 *
 * It exists to narrow the summary's row: only the unanswered row carries a null
 * primary-source total, and that row is not ranked, so a shape without the null
 * is what the ranking actually holds.
 */
interface RankedChannel {
  readonly label: string;
  readonly answers: number;
  readonly byCampaign: readonly SourceCampaignSplit[];
  readonly primarySourceTotal: number;
}

/** The rows a ranking of answers can hold: the ones that named a channel. */
function rankedChannels(rows: readonly SourceRow[]): readonly RankedChannel[] {
  return rows.flatMap((row) => {
    // The null primary-source total is exactly the unanswered row's marker —
    // `sourceSummary` writes it for the null channel and for no other row — so
    // the one check both selects the answered rows and narrows the figure to a
    // number. Asking the channel as well would be a second condition that can
    // never disagree with this one.
    const { primarySourceTotal } = row;
    return primarySourceTotal === null
      ? []
      : [
          {
            label: row.label,
            answers: row.answers,
            byCampaign: row.byCampaign,
            primarySourceTotal,
          },
        ];
  });
}

/**
 * One channel's share of the accounts that answered, or that there is no rate
 * to state.
 *
 * The denominator is the accounts that answered rather than every account
 * counted: the ranking is of answers, and a share of every account would be a
 * different figure under the same per-cent sign. Nobody answering leaves it
 * nothing to be taken against, which `0.0%` would misreport as an answer that
 * came to none.
 */
function shareOfAnswered(answers: number, answered: number): string {
  return formatRate(answered === 0 ? null : answers / answered);
}

/** A campaign split in words, for a row's accessible name. */
function campaignWords(splits: readonly SourceCampaignSplit[]): string {
  return splits.map((split) => `${split.campaign} ${String(split.accounts)}`).join(', ');
}

/**
 * Everything one row draws, in words.
 *
 * The bar carries no figure a reader can take off it, and the row's own tab
 * stop is what a keyboard reader lands on, so the name states every figure the
 * row shows rather than the two on its first line.
 */
function rowName(row: RankedChannel, share: string): string {
  return [
    `${row.label}.`,
    `${COLUMNS.answers}: ${String(row.answers)}.`,
    `${COLUMNS.share}: ${share}.`,
    `${COLUMNS.byCampaign}: ${campaignWords(row.byCampaign)}.`,
    `${COLUMNS.primary}: ${String(row.primarySourceTotal)}.`,
  ].join(' ');
}

/**
 * What people said when asked where they heard about us — the closed-set
 * answers, ranked, with the campaign split each answering account carried.
 *
 * This is the only place a self-report appears, and there is no free text
 * anywhere in it: the answer is one of a fixed set, so nothing a person typed
 * can reach this screen.
 *
 * The accounts that named nothing are stated below the ranking rather than
 * inside it. They are the panel's denominator rather than one of its answers,
 * and a bar drawn for them would rank an absence among the channels.
 */
export function SourcesPanel({
  rows,
}: Readonly<{ rows: readonly GrowthSourceCountWire[] }>): React.JSX.Element {
  const summary = sourceSummary(rows);

  const { answeredRate } = summary;
  if (answeredRate === null) {
    return <p className="text-muted-foreground text-sm">No accounts were created in this range.</p>;
  }

  const ranked = rankedChannels(summary.rows);
  const unanswered = summary.rows.find((row) => row.channel === null);
  const largest = ranked[0]?.answers ?? 0;

  return (
    <figure className="m-0">
      {/* Both figure columns are named rather than only the count. A single
          right-aligned label sits above the rightmost column, which is the
          share, so it reads as a claim that a percentage is a count of answers.
          Named in one line rather than one label per column: a separate label
          per column would have to align with tracks the rows size to their own
          content, which is how a column word ends up over the wrong figure. */}
      <p className="text-muted-foreground mb-1 px-1 text-right text-xs uppercase">
        {COLUMNS.answers} <span aria-hidden="true">&middot;</span> {COLUMNS.share}
      </p>
      <ul className="list-none p-0">
        {ranked.map((row) => {
          const share = shareOfAnswered(row.answers, summary.answered);
          return (
            <RankedRow
              key={row.label}
              fillPercent={largest === 0 ? 0 : (row.answers / largest) * 100}
              accessibleName={rowName(row, share)}
              className="grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(0,auto)]"
            >
              {/* A channel is a word rather than a path, so it is set in the
                  interface face the rest of the panel reads in. */}
              <span className="relative truncate">{row.label}</span>
              <span className="relative truncate text-right tabular-nums">{row.answers}</span>
              <span className="relative truncate text-right text-xs tabular-nums">{share}</span>
              {/* The campaign split and the primary-source figure sit on the row
                  rather than behind a pointer: both are figures this panel
                  showed before it ranked, and content a hover reveals is
                  unreachable by keyboard and by touch. They take the row's ink
                  rather than the muted one because part of the line sits on the
                  fill, where muted ink falls under the contrast floor at the
                  softened tier. */}
              <span className="relative col-span-3 text-xs">
                {COLUMNS.byCampaign}:{' '}
                {row.byCampaign.map((split) => (
                  <span key={split.campaign} className="mr-2 inline-block">
                    {split.campaign} {split.accounts}
                  </span>
                ))}
                <span className="inline-block">
                  {COLUMNS.primary}: {row.primarySourceTotal}
                </span>
              </span>
            </RankedRow>
          );
        })}
      </ul>
      {unanswered !== undefined && (
        <p className="text-muted-foreground mt-1 px-1 text-xs">
          {unanswered.answers} accounts named no channel. {COLUMNS.byCampaign}:{' '}
          {unanswered.byCampaign.map((split) => (
            <span key={split.campaign} className="mr-2 inline-block">
              {split.campaign} {split.accounts}
            </span>
          ))}
          Their primary source falls back to the campaign.
        </p>
      )}
      <figcaption className="text-muted-foreground mt-2 text-xs">
        Answered {summary.answered} of {summary.accounts} accounts ({formatRate(answeredRate)}).
        Shares are of the {summary.answered} that answered. Primary source is the answer when given,
        otherwise the campaign.
      </figcaption>
    </figure>
  );
}
