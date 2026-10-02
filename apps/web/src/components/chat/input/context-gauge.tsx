import { TEST_IDS } from '@hushbox/shared';
import type * as React from 'react';
import type { ContextFillBand } from '@hushbox/shared';

interface ContextGaugeProps {
  /** Tokens the conversation and the draft take up. */
  readonly used: number;
  /** Tokens the model's context window holds. */
  readonly capacity: number;
  /**
   * The band the window has filled into, as the money layer answers it. The gauge
   * renders the band and never decides it: the near-capacity notice reads the same
   * verdict, and the percent shown is rounded, so a band decided here would be
   * decided on a different number.
   */
  readonly band: ContextFillBand;
}

/** How each band reads: the words that carry it without colour, and its fill mark. */
const BANDS: Readonly<Record<ContextFillBand, { words: string; mark: string }>> = {
  room_to_spare: { words: 'room to spare', mark: 'room' },
  filling_up: { words: 'filling up', mark: 'filling' },
  nearly_full: { words: 'nearly full', mark: 'full' },
};

/** Each third's resting tint, faintly in the colour of the band it marks. */
const THIRDS = [
  'rounded-l-full bg-[color-mix(in_srgb,var(--success)_26%,var(--meter-track))]',
  'bg-[color-mix(in_srgb,var(--warning)_26%,var(--meter-track))]',
  'rounded-r-full bg-[color-mix(in_srgb,var(--error)_26%,var(--meter-track))]',
] as const;

/** How much of one third a fill of `percent` covers, as a CSS percentage. */
function thirdFill(percent: number, third: number): string {
  const covered = Math.min(Math.max(percent * 3 - third * 100, 0), 100);
  return `${String(covered)}%`;
}

/**
 * The context gauge: how much of the model's context window the conversation
 * fills, as "Context", three tinted thirds and the percent. It is drawn to sit
 * on the composer field's top border like a fieldset legend. Its upper half,
 * down past the border's 1px, takes the page's colour; its lower half is clear,
 * so it shows the field's own fill in every state, a disabled field's included.
 *
 * On a coarse pointer its touch area grows up and out and stops at its lower
 * edge, so a tap just inside the field below it reaches the text box. While the
 * field holds focus, the field's ring rises around it as a tab of the ring's own
 * width and colour, so the ring reads whole where the gauge covers it; the tab
 * sits behind the gauge in the stacking context of the slot that seats it. The
 * gauge is never wider than the composer less its inset on each side; the bar
 * gives up its width to keep it so, while the label and the value keep theirs.
 */
export function ContextGauge({
  used,
  capacity,
  band,
}: Readonly<ContextGaugeProps>): React.JSX.Element {
  const percent = Math.round((used / capacity) * 100);
  const { words, mark } = BANDS[band];
  return (
    <div
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={Math.max(100, percent)}
      aria-valuenow={percent}
      aria-valuetext={`${String(percent)}%, ${words}`}
      data-band={mark}
      data-testid={TEST_IDS.capacityBar}
      className={[
        'group/gauge text-caption text-muted-foreground relative inline-flex max-w-[calc(100cqi-1.5rem)] items-center gap-2 rounded-sm px-1.5 py-0.5 leading-none',
        'bg-[linear-gradient(var(--background)_calc(50%+1px),transparent_calc(50%+1px))]',
        'hover:bg-accent hover:text-foreground hover:bg-none',
        // Forced colours drop the gradient, so the field's border would run through the words.
        'forced-colors:bg-[Canvas]',
        'pointer-coarse:before:absolute pointer-coarse:before:-inset-x-1 pointer-coarse:before:-top-2.5 pointer-coarse:before:bottom-0',
        'after:border-brand-red after:bg-background after:absolute after:-inset-x-1 after:-top-1 after:-z-1 after:hidden after:h-[calc(50%+2px)] after:rounded-t-[calc(var(--radius-sm)+4px)] after:border-2 after:border-b-0',
        'in-[[data-slot=composer]:has(>[data-slot=composer-field]:focus-within)]:after:block',
      ].join(' ')}
    >
      <span data-slot="context-gauge-label" className="shrink-0">
        Context
      </span>
      <span
        data-slot="context-gauge-bar"
        aria-hidden="true"
        className="grid h-1.5 w-18 min-w-0 shrink grid-cols-3 gap-0.5 forced-colors:forced-color-adjust-none"
      >
        {THIRDS.map((tint, third) => (
          <span
            key={tint}
            className={`relative overflow-hidden ${tint} forced-colors:bg-[GrayText]`}
          >
            <span
              data-slot="context-gauge-fill"
              className="bg-success group-data-[band=filling]/gauge:bg-warning group-data-[band=full]/gauge:bg-error absolute inset-y-0 left-0 forced-colors:bg-[CanvasText]"
              style={{ width: thirdFill(percent, third) }}
            />
          </span>
        ))}
      </span>
      <span
        data-slot="context-gauge-value"
        className="text-foreground min-w-[2.25ch] shrink-0 font-mono tabular-nums"
      >
        {`${String(percent)}%`}
      </span>
    </div>
  );
}
