import * as React from 'react';
import { AnimatedHeight, cn } from '@hushbox/ui';
import { cutAtWordBoundary } from '@/lib/utils/word-boundary-cut';
import {
  PREDICTION_SUGGESTION_LISTBOX_ID,
  suggestionRowId,
  useActiveSuggestionIndex,
} from './use-prompt-prediction';

/**
 * Characters of typed text a row repeats ahead of its prediction.
 *
 * The tail is context, not content: it exists so the eye can see where each
 * prediction attaches. The budget is set by the narrowest screen the composer
 * runs on — at this type size a wider tail would push the prediction, which is
 * the part being compared, off the row on a small phone.
 */
const TAIL_CHARACTER_BUDGET = 32;

/** Predictions worth offering at once, past which the list stops being scannable. */
const MAX_SUGGESTION_ROWS = 4;

/**
 * Predictions below which the list has nothing to offer.
 *
 * `candidates` never carries the completion already drawn at the caret —
 * shaping excludes it — so even one candidate is a real alternative worth
 * offering, and the floor is one row rather than two.
 */
const MIN_SUGGESTION_ROWS = 1;

/**
 * The stretch of typed text every row repeats, cut at a word boundary.
 *
 * Cutting from the original string rather than rejoining words keeps whatever
 * spacing the user typed, so the tail reads as their own text.
 */
function suggestionTail(typedText: string): string {
  return cutAtWordBoundary(typedText, TAIL_CHARACTER_BUDGET);
}

interface SuggestionRowsProps {
  readonly typedText: string;
  readonly candidates: readonly string[];
  /** Omit to render the rows as pure reserved space. */
  readonly onSelect: ((completion: string) => void) | undefined;
  /**
   * The row holding the keyboard's virtual focus, or `null` while none does.
   * Ignored on the reserved (non-interactive) rendering, which never becomes
   * the target of a keypress in the first place.
   */
  readonly activeIndex: number | null;
}

function SuggestionRows({
  typedText,
  candidates,
  onSelect,
  activeIndex,
}: Readonly<SuggestionRowsProps>): React.JSX.Element {
  const tail = suggestionTail(typedText);
  const elided = tail !== typedText;
  const interactive = onSelect !== undefined;

  return (
    <div
      // `p-1` (4px) is deliberate, not decorative: every row's focus/active ring is
      // Tailwind's `ring-2`, an outward box-shadow with a 2px spread and no offset,
      // painted entirely outside the row's border box. `AnimatedHeight` clips at
      // this div's own border edge (its `overflow-hidden` cannot be removed — see
      // `AnimatedHeight`'s own doc comment), so with no padding here the ring had
      // nowhere to render except outside that clip: cut off top-of-first,
      // bottom-of-last, and both flanks of every row. 4px of padding on all four
      // sides gives the ring's 2px spread room to land inside the clip, with a 2px
      // margin against subpixel rounding, on every row including the first and
      // last.
      className="mt-2 flex flex-col gap-0.5 p-1"
      {...(interactive ? { id: PREDICTION_SUGGESTION_LISTBOX_ID, role: 'listbox' } : {})}
    >
      {candidates.map((completion, index) => {
        const active = interactive && index === activeIndex;
        return (
          // Slot identity is positional, not content-based: row N stays the
          // same DOM node when one settled set replaces another, so the
          // content changes under the reader rather than the rows being torn
          // down.
          <button
            key={index}
            type="button"
            data-slot={
              interactive ? 'prediction-suggestion-row' : 'prediction-suggestion-reserve-row'
            }
            {...(interactive
              ? { id: suggestionRowId(index), role: 'option', 'aria-selected': active }
              : { tabIndex: -1 })}
            {...(onSelect === undefined
              ? {}
              : {
                  onClick: (): void => {
                    onSelect(completion);
                  },
                })}
            className={cn(
              'hover:bg-accent focus-visible:ring-ring flex w-full items-baseline overflow-hidden rounded-md px-3 py-1 text-left text-sm focus-visible:ring-2 focus-visible:outline-hidden',
              // The keyboard's virtual focus never lands DOM focus on the row —
              // it stays on the composer — so the row's own focus-visible ring
              // never lights up on its own; this reproduces it for whichever
              // row the keyboard is virtually on.
              active && 'ring-ring ring-2 outline-hidden'
            )}
          >
            <span data-slot="prediction-suggestion-tail" className="shrink-0 whitespace-pre">
              {elided ? `…${tail}` : tail}
            </span>
            <span
              data-slot="prediction-suggestion-completion"
              className="text-prediction min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-pre underline decoration-dotted underline-offset-4"
            >
              {completion}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The rows to draw, or `null` for a list with nothing to say. */
function rowsToDraw(candidates: readonly string[]): readonly string[] | null {
  if (candidates.length < MIN_SUGGESTION_ROWS) return null;
  return candidates.slice(0, MAX_SUGGESTION_ROWS);
}

interface PredictionSuggestionListProps {
  /** The composer's value, whose tail every row repeats. */
  readonly typedText: string;
  /** The rival continuations behind the inline hint; never the hint itself. */
  readonly candidates: readonly string[];
  /** Receives the chosen continuation; the caller appends it to its own value. */
  readonly onSelect: (completion: string) => void;
}

/**
 * The rival continuations behind the inline hint, offered as a list under the
 * composer.
 *
 * A row is the typed tail in the composer's own colour followed by that row's
 * prediction in the inline hint's exact treatment, so the two surfaces read as
 * one feature. The tail is identical on every row, which is what lets the eye
 * run down the coloured segments and compare only what differs.
 *
 * Nothing to offer and nothing arrived yet are the same rendering — no spinner
 * and no placeholder — so a prediction that never comes is indistinguishable
 * from a feature that is not there.
 */
export function PredictionSuggestionList({
  typedText,
  candidates,
  onSelect,
}: Readonly<PredictionSuggestionListProps>): React.JSX.Element {
  const rows = React.useMemo(() => rowsToDraw(candidates), [candidates]);
  const activeIndex = useActiveSuggestionIndex();
  return (
    <AnimatedHeight>
      {rows === null ? null : (
        <SuggestionRows
          typedText={typedText}
          candidates={rows}
          onSelect={onSelect}
          activeIndex={activeIndex}
        />
      )}
    </AnimatedHeight>
  );
}

type PredictionSuggestionListSpacerProps = Omit<PredictionSuggestionListProps, 'onSelect'>;

/**
 * The list's height, reserved above the composer instead of below it.
 *
 * `ChatWelcome`'s column is centred, so a list appearing under the composer
 * would pull the composer up by half its height. This renders the identical
 * subtree ahead of the greeting: the same height then enters the column twice,
 * once on each side of the composer, and a centred column that grows equally
 * above and below leaves everything between the two additions exactly where it
 * was. It is the list component itself rather than a matching constant because
 * a reserved height that has to be kept in step with a real one drifts the
 * first time a row's type size changes.
 *
 * It is `invisible` rather than `display: none` deliberately — hidden
 * visibility still lays out, which is the whole point, and it takes the rows
 * out of the tab order and the accessibility tree at the same time.
 */
export function PredictionSuggestionListSpacer({
  typedText,
  candidates,
}: Readonly<PredictionSuggestionListSpacerProps>): React.JSX.Element {
  const rows = React.useMemo(() => rowsToDraw(candidates), [candidates]);
  return (
    <div data-slot="prediction-suggestion-spacer" aria-hidden="true" className="invisible">
      <AnimatedHeight>
        {rows === null ? null : (
          <SuggestionRows
            typedText={typedText}
            candidates={rows}
            onSelect={undefined}
            activeIndex={null}
          />
        )}
      </AnimatedHeight>
    </div>
  );
}
