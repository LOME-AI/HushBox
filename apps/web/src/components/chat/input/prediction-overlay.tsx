import * as React from 'react';
import { cn, Kbd, TEXTAREA_MIRROR_CLASSES, TEXTAREA_WRAP_CLASSES } from '@hushbox/ui';
import { useFormFactor } from '@hushbox/ui/platform';
import { visiblePrediction, type PredictionState } from '@/lib/prediction/state';

interface PredictionOverlayProps {
  readonly state: PredictionState;
  /** Take the visible prediction into the composer. */
  readonly onAccept: () => void;
}

/**
 * The predicted continuation, drawn as a transparent-prefix mirror of the
 * composer.
 *
 * The overlay repeats the typed value in transparent text and then the
 * prediction, over a textarea carrying the same font, size and padding — which
 * is why the box metrics come from the textarea primitive itself rather than
 * being restated here. The browser's own line breaking therefore lands the
 * prediction exactly where the caret sits, which is why there is no measurement
 * code here and no mid-value prediction anywhere: an overlay cannot reflow the
 * glyphs beneath it.
 *
 * The box is pinned to the top and full width but never to the bottom: a
 * bottom pin would force its height to the textarea's own (typed-text-only)
 * height and clip a completion whose wrapped lines run past it. Left
 * unclipped, the overlay grows to whatever the mirrored text needs instead.
 * A completion tall enough to have grown past the composer's own box never
 * reaches this render: `completion-too-tall` is a suppression reason in its
 * own right, computed from the same measured height this growth would
 * produce, so `visiblePrediction` withholds the whole prediction before an
 * overflowing one ever gets here.
 *
 * `visiblePrediction` is the sole source of what renders. It already withholds
 * an answer while an input method composes, while any suppression predicate
 * holds, and while the held answer belongs to different text — so no
 * combination of props can put a prediction on screen in those states.
 *
 * `aria-hidden` because a screen-reader user hears the prediction through the
 * composer's live region instead; a mirrored copy of their own typing announced
 * twice is worse than silence. The Tab hint inherits that same `aria-hidden`
 * scope — the keyboard behavior it advertises needs no separate announcement.
 */
export function PredictionOverlay({
  state,
  onAccept,
}: Readonly<PredictionOverlayProps>): React.JSX.Element | null {
  const prediction = visiblePrediction(state);
  const { pointer } = useFormFactor();
  if (prediction === null) return null;

  return (
    <div
      data-slot="prediction-overlay"
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 overflow-visible select-none',
        TEXTAREA_WRAP_CLASSES,
        TEXTAREA_MIRROR_CLASSES
      )}
    >
      <span data-slot="prediction-mirror-prefix" className="text-transparent">
        {state.typedText}
      </span>
      <span
        data-slot="prediction-text"
        className="text-prediction pointer-events-auto underline decoration-dotted underline-offset-4"
        onPointerDown={(event) => {
          // The composer must keep focus and the caret must not move, so the
          // press is consumed here rather than being allowed to reach the
          // textarea underneath.
          event.preventDefault();
          onAccept();
        }}
      >
        {prediction.completion}
      </span>
      {pointer === 'fine' && (
        <>
          {' '}
          <Kbd
            combo="Tab"
            data-slot="prediction-hint"
            className="pointer-events-none align-middle"
          />
        </>
      )}
    </div>
  );
}
