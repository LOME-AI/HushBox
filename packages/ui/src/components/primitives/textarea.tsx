import * as React from 'react';

import { cn } from '../../lib/utilities';

/**
 * The type scale anything drawing text over this textarea must repeat, so its
 * glyphs size with the ones beneath them.
 *
 * Split from {@link TEXTAREA_MIRROR_CLASSES} because an overlay that positions
 * itself absolutely needs the sizing without the padding — taking the padding
 * too would move its first glyph.
 */
export const TEXTAREA_TYPE_SCALE_CLASSES = 'text-base md:text-sm';

/**
 * The box metrics a transparent mirror overlay must repeat to sit exactly over
 * this textarea's own glyphs: the padding that places the first one, and the
 * type scale that sizes all of them.
 *
 * Published rather than copied because a mirror that carries its own set drifts
 * the moment either changes here, and a drifted mirror renders no error — it
 * just puts text in the wrong place, which no gate can see.
 */
export const TEXTAREA_MIRROR_CLASSES = `px-3 py-2 ${TEXTAREA_TYPE_SCALE_CLASSES}`;

/**
 * The wrap behavior the invisible sizing replica below needs declared: a
 * `<textarea>` wraps this way natively, but a `<div>` does not — without it,
 * the replica collapses onto one line and under-reports the row height the
 * real textarea needs.
 *
 * `anywhere` rather than the textarea's own `break-word`: the two break lines at
 * the same places, but only `anywhere` lets an unbroken string shrink the
 * replica's min-content width, and the replica shares a grid cell with the
 * textarea — with `break-word` a long pasted string widens the cell, and the
 * field with it, to the string's full length.
 */
export const TEXTAREA_WRAP_CLASSES = 'whitespace-pre-wrap wrap-anywhere';

/**
 * The border the sizing replica below must carry too: the two elements share
 * one grid cell and the replica drives the row's height, so a border on the
 * textarea alone makes its border-box height taller than the replica's by
 * twice the border width — the row sizes short and `scrollHeight` sits above
 * `clientHeight` at every growth step below the clamp, for any caller that
 * does not zero the border itself. Not published: only the textarea and its
 * own replica need to agree on it.
 */
const TEXTAREA_BORDER_CLASSES = 'border-input border';

interface TextareaProps extends React.ComponentProps<'textarea'> {
  /**
   * Sizes the row from this text instead of the textarea's own `value` /
   * `defaultValue`, without changing what the textarea displays or submits.
   *
   * The primitive knows nothing about what a caller wants to reserve room
   * for — a caller that needs the row taller than its typed value (a shown
   * inline suggestion, say) supplies the text it wants sized in addition to
   * its own; anything without an opinion leaves this unset and gets the
   * unchanged, value-only sizing every other consumer already has.
   */
  readonly sizingValue?: string;
}

function Textarea({
  className,
  style,
  value,
  defaultValue,
  ref,
  sizingValue,
  ...props
}: Readonly<TextareaProps>): React.JSX.Element {
  return (
    <div className="grid">
      <textarea
        ref={ref}
        data-slot="textarea"
        value={value}
        defaultValue={defaultValue}
        style={style}
        className={cn(
          'placeholder:text-muted-foreground focus-visible:border-ring aria-invalid:border-destructive dark:bg-input/30 flex min-h-16 w-full rounded-md bg-transparent shadow-xs transition-[color,box-shadow] [grid-area:1/1] focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          TEXTAREA_BORDER_CLASSES,
          TEXTAREA_MIRROR_CLASSES,
          className
        )}
        {...props}
      />
      {/*
        Sizes the grid row: a same-cell, invisible replica of the textarea's
        own text, or of `sizingValue` when a caller supplies one. field-sizing-content
        isn't honored on Firefox (the textarea stays pinned at its floor there),
        so the row grows and clamps off this replica's natural content height
        instead. It repeats the
        caller's className/style so a min/max-height override constrains it
        identically to the textarea — otherwise the row follows the
        replica's uncapped height and the wrapper grows past the textarea's
        own visible clamp. It also carries TEXTAREA_BORDER_CLASSES, the same
        border the textarea itself carries, so the two elements' border-box
        heights agree.
      */}
      <div
        aria-hidden="true"
        data-slot="textarea-sizing-replica"
        style={style}
        className={cn(
          'invisible w-full [grid-area:1/1]',
          TEXTAREA_BORDER_CLASSES,
          TEXTAREA_MIRROR_CLASSES,
          TEXTAREA_WRAP_CLASSES,
          className
        )}
      >
        {`${sizingValue ?? String(value ?? defaultValue ?? '')} `}
      </div>
    </div>
  );
}

export { Textarea };
