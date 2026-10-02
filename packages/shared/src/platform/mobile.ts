/** Tailwind md: breakpoint — width below this is mobile */
export const MOBILE_BREAKPOINT = 768;

/** Pure function: returns true if the given width is a mobile viewport */
export function isMobileWidth(width: number): boolean {
  return width < MOBILE_BREAKPOINT;
}
