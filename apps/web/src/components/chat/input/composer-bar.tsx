import type * as React from 'react';

interface ComposerBarProps {
  readonly modeControl?: React.ReactNode;
  readonly searchControl?: React.ReactNode;
  readonly effortControl?: React.ReactNode;
  readonly modelControl?: React.ReactNode;
  readonly estimate?: React.ReactNode;
  readonly send: React.ReactNode;
}

const GROUP = 'flex items-center gap-1.5 @max-composer-compact/composer:gap-1';
// A slot's own box and any empty control it is handed both drop out of the row.
const SLOT = 'contents *:empty:hidden';
// A composer chip's text label is the span directly inside its button. Stepping down to
// the icon keeps that label for readers and squares the chip to 2rem; a control with no
// such label, such as a bare icon button, is left as it is.
const SEARCH_ICON_ONLY =
  '@max-composer-compact/composer:[&_button>span]:sr-only @max-composer-compact/composer:[&_button:has(>span)]:w-8 @max-composer-compact/composer:[&_button:has(>span)]:px-0 @max-composer-compact/composer:[&_button:has(>span)]:justify-center';
const MODE_ICON_ONLY =
  '@max-composer-mode-icon/composer:[&_button>span]:sr-only @max-composer-mode-icon/composer:[&_button:has(>span)]:w-8 @max-composer-mode-icon/composer:[&_button:has(>span)]:px-0 @max-composer-mode-icon/composer:[&_button:has(>span)]:justify-center';
// Below this width the Search and Effort controls leave the bar.
const DROPPED_WHEN_MINIMAL = '@max-composer-minimal/composer:hidden';

/**
 * The composer's control row inside its field. Each slot is a `display: contents`
 * box, so its controls sit directly in their group's row and an unfilled slot
 * opens no gap. The left group never shrinks; the right group takes the squeeze.
 * It grows from a zero basis, and the model chip inside it is sized from zero up to
 * its own width, so the chip's name truncates before anything moves. The group's
 * floor is its content at its smallest (the chip at its own minimum, the estimate,
 * Send), and only once that floor no longer fits beside the left group does the
 * group wrap to a line of its own, rather than pushing Send past the field's edge.
 * A left group wider than the whole bar, as at large text on a phone, wraps its
 * own controls instead of overhanging the field.
 *
 * The row compacts by the width of the `composer` container, not the viewport's.
 * Below 34rem the gaps tighten, the estimate leaves the bar for the line above
 * the field, and the Search chip shows its icon alone; below 20.5rem the mode
 * chip does too; below 20rem the Search and Effort controls leave the bar. The
 * model chip switches to its short name at 34rem itself.
 */
export function ComposerBar({
  modeControl,
  searchControl,
  effortControl,
  modelControl,
  estimate,
  send,
}: Readonly<ComposerBarProps>): React.JSX.Element {
  return (
    <div
      data-slot="composer-bar"
      className="@max-composer-compact/composer:gap-1 @max-composer-compact/composer:px-1.5 flex flex-wrap items-center gap-1.5 px-2 pt-1.5 pb-2"
    >
      <div data-slot="composer-left" className={`${GROUP} max-w-full flex-none flex-wrap`}>
        <div data-slot="composer-mode" className={`${SLOT} ${MODE_ICON_ONLY}`}>
          {modeControl}
        </div>
        <div
          data-slot="composer-search"
          className={`${SLOT} ${SEARCH_ICON_ONLY} ${DROPPED_WHEN_MINIMAL}`}
        >
          {searchControl}
        </div>
        <div data-slot="composer-effort" className={`${SLOT} ${DROPPED_WHEN_MINIMAL}`}>
          {effortControl}
        </div>
      </div>
      <div data-slot="composer-right" className={`${GROUP} flex-1 justify-end-safe`}>
        {/* A zero width makes the chip's floor its own min-width, not its label's length. */}
        <div data-slot="composer-model" className={`${SLOT} *:w-0 *:max-w-max *:grow`}>
          {modelControl}
        </div>
        <div
          data-slot="composer-estimate"
          className={`${SLOT} @max-composer-compact/composer:hidden`}
        >
          {estimate}
        </div>
        {send}
      </div>
    </div>
  );
}

export type { ComposerBarProps };
