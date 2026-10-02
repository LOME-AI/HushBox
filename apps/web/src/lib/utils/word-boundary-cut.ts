const FIRST_WHITESPACE = /\s/u;

/**
 * Cuts `text` to at most `maxChars`, keeping the tail nearest the end and
 * cutting at a word boundary so the result never opens on a word fragment.
 */
export function cutAtWordBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const withinBudget = text.slice(text.length - maxChars);
  const boundary = withinBudget.search(FIRST_WHITESPACE);
  // An unbroken run at least as long as the budget offers no boundary to cut
  // at, so the only honest choice left is to cut it short.
  return boundary === -1 ? withinBudget : withinBudget.slice(boundary).trimStart();
}
