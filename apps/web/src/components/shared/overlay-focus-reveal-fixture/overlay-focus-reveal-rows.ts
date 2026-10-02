/**
 * The rows the overlay focus reveal fixture renders, for the fixture page that draws them and
 * the Node-side test that presses keys on them. It runs nothing on import, so both can load it.
 */

/** Enough rows to scroll in both presentations, the dialog and the bottom sheet. */
export const ROW_COUNT = 40;

/** The visible label of the row at `index`, counted from zero. */
export function rowLabel(index: number): string {
  return `Option ${String(index + 1)}`;
}
