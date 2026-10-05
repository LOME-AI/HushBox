import * as React from 'react';
import { cn, Kbd, TEXTAREA_MIRROR_CLASSES, TEXTAREA_NATIVE_WRAP_CLASSES } from '@hushbox/ui';
import { useFormFactor } from '@hushbox/ui/platform';
import { visiblePrediction, type PredictionState } from '@/lib/prediction/state';

/**
 * How long after a finger or pen lifts from an accepting press the overlay still waits for the
 * click that tap generates. It bounds a long press, which ends with no click, and is far above
 * the release-to-click delay of a tap, which arrives within milliseconds.
 */
export const TAP_CLICK_WINDOW_MS = 1000;

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
 * A tap is a press and, after the release, a click the browser hit-tests afresh. Accepting on the
 * press re-lays the page out — the overlay goes, and on the new-chat page the stack around the
 * composer shifts — so that click can land on a control that has moved under the finger, the
 * model chip among them. A finger or pen press therefore swallows the one click that follows it,
 * and stops waiting for it once the press is cancelled, a new press begins, or
 * {@link TAP_CLICK_WINDOW_MS} passes after the release. A mouse press arms nothing: the node it
 * pressed is gone by the release, so it produces no click, and an armed swallow would eat the
 * user's next keyboard activation instead.
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
  const releaseClickSwallow = React.useRef<(() => void) | null>(null);
  React.useEffect(() => () => releaseClickSwallow.current?.(), []);
  if (prediction === null) return null;

  const swallowNextClick = (): void => {
    releaseClickSwallow.current?.();
    const swallow = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      release();
    };
    let windowTimer: ReturnType<typeof setTimeout> | undefined;
    const openWindow = (): void => {
      windowTimer = setTimeout(release, TAP_CLICK_WINDOW_MS);
    };
    const release = (): void => {
      clearTimeout(windowTimer);
      globalThis.removeEventListener('click', swallow, true);
      globalThis.removeEventListener('pointerup', openWindow, true);
      globalThis.removeEventListener('pointercancel', release, true);
      globalThis.removeEventListener('pointerdown', release, true);
      releaseClickSwallow.current = null;
    };
    globalThis.addEventListener('click', swallow, true);
    globalThis.addEventListener('pointerup', openWindow, { capture: true, once: true });
    globalThis.addEventListener('pointercancel', release, true);
    globalThis.addEventListener('pointerdown', release, true);
    releaseClickSwallow.current = release;
  };

  return (
    <div
      data-slot="prediction-overlay"
      aria-hidden="true"
      className={cn(
        'pointer-events-none absolute inset-x-0 top-0 overflow-visible select-none',
        TEXTAREA_NATIVE_WRAP_CLASSES,
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
          if (event.pointerType !== 'mouse') swallowNextClick();
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
