/**
 * When the composer must not offer a prediction at all.
 *
 * Every predicate here takes plain numbers and strings a caller has already
 * read off the element, never the element itself. Rendering is a transparent
 * mirror overlay laid over the textarea, so these are the conditions under
 * which the overlay cannot line up with the glyphs beneath it — and a hint that
 * lands in the wrong place is worse than no hint.
 */

/** The measurements a suppression decision is made from. */
export interface ComposerReading {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  /** The composer's resolved writing direction, as a computed style reports it. */
  readonly writingDirection: string;
  /**
   * The height, in px, the overlay needs to show the typed text plus the
   * currently held completion — `null` while no completion is held for the
   * text now in the composer, in which case there is nothing to check.
   */
  readonly predictedContentHeight: number | null;
}

/**
 * Why a prediction is being withheld. Carried rather than reduced to a boolean
 * so a caller can tell a transient reason (the caret moved) from a durable one
 * (the composer has grown past its maximum height).
 */
export type SuppressionReason =
  | 'caret-not-at-end'
  | 'composer-scrolls'
  | 'right-to-left'
  | 'completion-too-tall';

/**
 * Whether the caret is a collapsed insertion point after the last character.
 * A prediction extends the end of the value, so anywhere else — including a
 * selection that merely ends there — has nothing to extend.
 */
export function isCaretAtEnd(reading: ComposerReading): boolean {
  return (
    reading.selectionStart === reading.value.length && reading.selectionEnd === reading.value.length
  );
}

/**
 * Whether the composer has grown past its maximum height and started scrolling
 * its own content. The overlay does not scroll with it, so from here on the
 * mirrored prefix and the real glyphs drift apart.
 */
export function scrollsInternally(reading: ComposerReading): boolean {
  return reading.scrollHeight > reading.clientHeight;
}

/** Whether the composer lays text out right to left, which the overlay cannot mirror. */
export function isRightToLeft(writingDirection: string): boolean {
  return writingDirection.trim().toLowerCase() === 'rtl';
}

/**
 * Whether the held completion, shown beside the typed text, would need more
 * height than the composer's own box currently offers. Unlike
 * {@link scrollsInternally}, which only ever sees the typed text, this is what
 * catches a short prefix paired with a long completion — the overlay is never
 * clipped, so a prediction this tall would render past the composer into
 * whatever sits below it.
 */
export function completionOverflows(reading: ComposerReading): boolean {
  return (
    reading.predictedContentHeight !== null && reading.predictedContentHeight > reading.clientHeight
  );
}

/** The first reason to withhold a prediction, or `null` when none applies. */
export function suppressionReason(reading: ComposerReading): SuppressionReason | null {
  if (!isCaretAtEnd(reading)) return 'caret-not-at-end';
  if (scrollsInternally(reading)) return 'composer-scrolls';
  if (isRightToLeft(reading.writingDirection)) return 'right-to-left';
  if (completionOverflows(reading)) return 'completion-too-tall';
  return null;
}
