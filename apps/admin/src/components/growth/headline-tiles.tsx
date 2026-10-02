import * as React from 'react';
import { NO_COUNT } from './absent-figure.js';
import { DataDisclosure } from './data-disclosure.js';
import { formatVisitorCount } from './funnel-math.js';
import { headlineWeeks, isStated, isWithheld, weekOnWeekChange } from './headline-figures.js';
import { dayOf } from './growth-window.js';
import { Sparkline } from './sparkline.js';
import { summedQualifier } from './summed-label.js';
import type { HeadlineFigure, WeekOnWeekChange } from './headline-figures.js';

/**
 * What the tile figure covers against what the line beside it covers.
 *
 * The two are different spans — the figure is one week, the line is the ladder's
 * whole range — and a reader given both without being told would take the line
 * for a drawing of the number above it. A figure read for the week on screen
 * alone holds a single point and so draws nothing, and the sentence says so
 * rather than leaving a claim standing over a tile with no line under it.
 */
export const TREND_SPAN_NOTE =
  'Each figure is the week selected above. Where a line is drawn beside one, it covers every week the ladder carries; a figure counted for that one week alone carries none. A change is stated where the week before holds a count of its own and neither count was cut by a ceiling.';

/**
 * One figure's value in one week, or the words for an absent count where that
 * figure holds no point in it. A nought there would state a count of none.
 */
function valueAt(figure: HeadlineFigure, week: string): string {
  const point = figure.spark.find((each) => each.week === week);
  return point === undefined ? NO_COUNT : formatVisitorCount(point.value, point.overflow);
}

/**
 * How a figure moved since the week before, in words rather than in colour: a
 * direction told apart by hue alone is lost to a reader who cannot tell the two
 * hues apart, and the two chart colours that would carry it clear neither
 * contrast floor at this size.
 */
function changeSentence(moved: WeekOnWeekChange): string {
  const since = `from ${moved.previousDay}`;
  if (moved.change === 0) return `No change ${since}`;
  const size = formatVisitorCount(Math.abs(moved.change), null);
  return `${moved.change > 0 ? 'Up' : 'Down'} ${size} ${since}`;
}

/** What the week-by-week table holds, as its caption and as the name of the box it scrolls in. */
const TABLE_CAPTION = 'Each figure week by week, as the lines above draw it';

/** The comparison a tile states, where there is one to state. */
function WeekOnWeek({ figure }: Readonly<{ figure: HeadlineFigure }>): React.JSX.Element | null {
  const moved = weekOnWeekChange(figure);
  if (moved === null) return null;
  return <p className="text-muted-foreground mt-1 text-xs tabular-nums">{changeSentence(moved)}</p>;
}

/**
 * The figures the page leads with. A figure the ladder cannot answer is
 * stated as unavailable with its reason rather than drawn as a zero: a zero
 * asserts that nobody was counted, which is a different claim from the one this
 * page is able to make.
 *
 * The trend lines are drawings and nothing else; the table below carries every
 * point they are drawn from, which is what lets them be hidden from assistive
 * technology. It is rendered on every pass and only hidden visually, so a reader
 * who never presses the control still reaches it.
 */
export function HeadlineTiles({
  figures,
}: Readonly<{ figures: readonly HeadlineFigure[] }>): React.JSX.Element {
  const weeks = headlineWeeks(figures);
  const stated = figures.filter((figure) => isStated(figure));

  return (
    <figure className="m-0">
      <div
        data-slot="headline-tiles"
        className="grid auto-rows-fr grid-cols-2 gap-2 lg:grid-cols-4"
      >
        {figures.map((figure) => (
          <div
            key={figure.label}
            data-slot="headline-tile"
            className="border-border bg-card flex flex-col rounded-md border p-3"
          >
            {/* Both parts of the line naming a figure — the noun and the chip
                qualifying it — may shrink below their own longest word and
                break inside it. Each is an item of a flex line, whose implicit
                minimum is that word, so at a large text size the tile is
                narrower than the word and the item was drawn across the tile's
                border. Nothing is truncated either way: the qualifier is what
                makes the figure beside it a lower bound rather than a total,
                and the noun is what the figure is of. */}
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
              <span data-slot="headline-noun" className="min-w-0 break-words">
                {figure.noun}
              </span>
              {figure.bucketing === null ? null : (
                <span
                  data-slot="headline-bucketing"
                  className="border-border bg-secondary min-w-0 rounded-full border px-1.5 break-words"
                >
                  {summedQualifier(figure.bucketing)}
                </span>
              )}
            </p>
            {isWithheld(figure) ? (
              <>
                <p className="text-muted-foreground mt-1 text-lg">Unavailable</p>
                <p className="text-muted-foreground mt-1 text-xs">{figure.unavailableReason}</p>
              </>
            ) : (
              <>
                <p className="mt-1 text-2xl tabular-nums">
                  {formatVisitorCount(figure.value, figure.overflow)}
                </p>
                <WeekOnWeek figure={figure} />
                {/* The line sits on the tile's floor rather than under the
                    figure, so four tiles of different text lengths still draw
                    their lines on one baseline to be compared across. */}
                <span className="mt-auto block pt-1">
                  <Sparkline points={figure.spark} />
                </span>
              </>
            )}
          </div>
        ))}
      </div>

      {weeks.length > 0 && (
        <DataDisclosure
          label={TABLE_CAPTION}
          table={
            <table className="w-full text-left text-sm">
              <caption>{TABLE_CAPTION}</caption>
              <thead>
                <tr className="text-muted-foreground text-xs uppercase">
                  <th scope="col" className="py-1 pr-2 font-semibold">
                    Week
                  </th>
                  {stated.map((figure) => (
                    <th
                      key={figure.label}
                      scope="col"
                      className="py-1 pl-2 text-right font-semibold"
                    >
                      {figure.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((week) => (
                  <tr key={week} className="border-border border-b">
                    <th scope="row" className="py-1 pr-2 font-mono text-xs font-normal">
                      {dayOf(new Date(week))}
                    </th>
                    {stated.map((figure) => (
                      <td key={figure.label} className="py-1 pl-2 text-right tabular-nums">
                        {valueAt(figure, week)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          }
        />
      )}

      <figcaption className="text-muted-foreground mt-2 text-xs">{TREND_SPAN_NOTE}</figcaption>
    </figure>
  );
}
