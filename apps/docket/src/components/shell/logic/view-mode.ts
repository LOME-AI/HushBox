export const VIEW_MODES = ['list', 'focus'] as const;

/**
 * Which of the two views the reader is looking at. It rides the url beside the
 * focused finding rather than persisting per browser: the url is already the
 * one authority for what is on screen, and carrying the mode there is what
 * makes Back out of a finding land on the list it was opened from.
 */
export type ViewMode = (typeof VIEW_MODES)[number];

const MODES: ReadonlySet<unknown> = new Set(VIEW_MODES);

export function isViewMode(value: unknown): value is ViewMode {
  return MODES.has(value);
}
