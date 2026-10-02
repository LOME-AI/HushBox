import { buildSections } from '@hushbox/ui';
import type { PaletteSection } from '@hushbox/ui';
import type { FindingJson } from '@hushbox/docket';

/** An audit runs to hundreds of findings; a palette that lists them all is a list. */
export const PALETTE_LIMIT = 20;

/**
 * The palette's view of the audit: every finding addressable by title or id.
 * `buildSections` owns the matching and the top-result promotion, so this is
 * only the item shape and the cap.
 */
export function paletteSections(
  findings: readonly FindingJson[],
  query: string
): readonly PaletteSection[] {
  const items = findings.map((finding) => ({
    id: finding.id,
    label: finding.title,
    hint: finding.id,
  }));

  return buildSections({ query, groups: [{ heading: 'Findings', items }] })
    .map((section) => ({ heading: section.heading, items: section.items.slice(0, PALETTE_LIMIT) }))
    .filter((section) => section.items.length > 0);
}
