import { SECTIONS } from './sections.ts';
import type { SectionId, SectionSpec } from './sections.ts';
import type { FindingJson, FindingStatus, Kind, Severity } from '@hushbox/docket';

export interface Filters {
  readonly q: string;
  readonly severity: readonly Severity[];
  readonly status: readonly FindingStatus[];
  readonly kind: readonly Kind[];
  /** One code family at a time, named by `areaFamily`, not by a whole `area`. */
  readonly area: string | null;
  readonly warning: boolean;
  readonly grouped: boolean;
}

export const EMPTY_FILTERS: Filters = {
  q: '',
  severity: [],
  status: [],
  kind: [],
  area: null,
  warning: false,
  grouped: false,
};

export interface AreaOption {
  readonly value: string;
  readonly count: number;
}

/**
 * The code family an area names, which is what the rail offers and what the
 * `area` filter selects. `area` is prose a human keeps correcting, so one
 * family arrives spelled a dozen ways — "apps/web (billing)", "apps/web lib
 * auth", "apps/api/src/slices/models" beside "apps/api models slice" — and
 * keying the rail on the whole string gave most findings a bucket of their own,
 * which is a rail no queue can be worked through in batches. Grouping here
 * rather than in the corpus is what lets `area` stay free prose.
 *
 * The leading path is the family, cut to two segments: two is what separates
 * `apps/web` from `apps/api`, and one would put every app in a single bucket.
 * A tail the audit adds after a space, comma or bracket is commentary on the
 * same family, so it ends where the first of those begins.
 *
 * A second segment carrying a dot is a file, and a file is not a family of its
 * own: `scripts/dev-clean.ts` belongs with `scripts`. A first segment is kept
 * whichever it is, so a file no directory holds — `docker-compose.yml` — still
 * names itself rather than folding into nothing.
 *
 * Code ticks are dropped here rather than upstream because the CLI reads `area`
 * as the audit wrote it, where a path is usually in ticks, while the console
 * reads it already rendered. Both have to arrive at the same family name.
 */
export function areaFamily(area: string): string {
  const [leading = ''] = area
    .replaceAll('`', '')
    .trim()
    .split(/[\s,(]/u);
  const [head = '', tail] = leading.split('/');
  return tail === undefined || tail.includes('.') ? head : `${head}/${tail}`;
}

function searchTerms(query: string): readonly string[] {
  return query.toLowerCase().split(/\s+/u).filter(Boolean);
}

/** An empty dimension is not a filter: it means the reader chose nothing in it. */
function anyOf<TValue>(selected: readonly TValue[], value: TValue): boolean {
  return selected.length === 0 || selected.includes(value);
}

function matchesFacets(finding: FindingJson, filters: Filters): boolean {
  return (
    anyOf(filters.severity, finding.severity) &&
    anyOf(filters.status, finding.status) &&
    anyOf(filters.kind, finding.kind) &&
    (filters.area === null || areaFamily(finding.area) === filters.area) &&
    (!filters.warning || finding.warning) &&
    (!filters.grouped || finding.group !== null)
  );
}

/**
 * `searchText` carries a whole finding body, and the queue is re-filtered on
 * every keystroke; folding case once per finding rather than once per keystroke
 * is what keeps typing off the long-task threshold on an audit this size.
 */
const folded = new WeakMap<FindingJson, string>();

function haystack(finding: FindingJson): string {
  const cached = folded.get(finding);
  if (cached !== undefined) return cached;
  const lowered = finding.searchText.toLowerCase();
  folded.set(finding, lowered);
  return lowered;
}

function matchesSearch(finding: FindingJson, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const text = haystack(finding);
  return terms.every((term) => text.includes(term));
}

/** Every dimension composes: within one it is any-of, across them all-of. */
export function filterFindings(
  findings: readonly FindingJson[],
  filters: Filters
): readonly FindingJson[] {
  const terms = searchTerms(filters.q);
  return findings.filter(
    (finding) => matchesFacets(finding, filters) && matchesSearch(finding, terms)
  );
}

export function countBySection(findings: readonly FindingJson[]): Record<SectionId, number> {
  const counts = {} as Record<SectionId, number>;
  for (const section of SECTIONS) {
    // A whole-audit section has no queue, and the number worth putting on that
    // tab is the work still to be decided.
    counts[section.id] = section.wholeAudit
      ? findings.length - decidedCount(findings)
      : findings.filter((finding) => section.holds(finding)).length;
  }
  return counts;
}

export function decidedCount(findings: readonly FindingJson[]): number {
  return findings.filter((finding) => finding.state === 'ruled' || finding.state === 'denied')
    .length;
}

/** What a section puts on screen: its own queue, or everything the filters admit. */
export function findingsInSection(
  findings: readonly FindingJson[],
  section: SectionSpec
): readonly FindingJson[] {
  return section.wholeAudit ? findings : findings.filter((finding) => section.holds(finding));
}

function tally(seed: readonly string[], pool: readonly FindingJson[]): readonly AreaOption[] {
  const counts = new Map<string, number>(seed.map((area) => [area, 0]));
  for (const finding of pool) {
    const family = areaFamily(finding.area);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .toSorted((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

/** How many of a given set of findings each area carries, largest first. */
export function areaOptions(findings: readonly FindingJson[]): readonly AreaOption[] {
  return tally([], findings);
}

/**
 * The rail's count is a promise about the pane beside it, so it is taken over
 * what that pane reads: this section, and every other filter already on.
 * Counting the whole audit instead offered numbers no view of the console could
 * produce, and an area could promise findings and deliver an empty pane.
 *
 * The area dimension itself is dropped before counting, or every option but the
 * chosen one would read zero. An option that would read zero is not offered at
 * all: a choice whose only outcome is an empty pane.
 *
 * The chosen area is the exception, and is seeded so it survives its own count
 * reaching zero: dropping it would leave the rail reading "All areas" over a
 * queue that area emptied.
 */
export function areaFilterOptions(
  findings: readonly FindingJson[],
  filters: Filters,
  section: SectionSpec
): readonly AreaOption[] {
  return tally(
    filters.area === null ? [] : [filters.area],
    findingsInSection(filterFindings(findings, { ...filters, area: null }), section)
  );
}

export function isFiltering(filters: Filters): boolean {
  return (
    filters.q.trim() !== '' ||
    filters.severity.length > 0 ||
    filters.status.length > 0 ||
    filters.kind.length > 0 ||
    filters.area !== null ||
    filters.warning ||
    filters.grouped
  );
}
