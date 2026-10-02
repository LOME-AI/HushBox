import { useEffect, useRef, useState } from 'react';
import { landingPatch } from '@/components/finding/logic/jump';
import { TOGGLE_KEYS, unhonouredValues } from '@/hooks/use-search-state';
import { areaFamily, filterFindings } from './filters';
import type { Filters } from './filters';
import type { SearchState, UnhonouredValue } from '@/hooks/use-search-state';
import type { SectionSpec } from './sections';
import type { FindingJson } from '@hushbox/docket';

/**
 * What a link has to be corrected to before it is shown. `?focus=<id>` on its
 * own is the shape a reader pastes to a colleague, and it carries no section:
 * the finding it names is usually not in the default one, and dropping the
 * focus while leaving it in the url lands the reader on an unrelated finding
 * that looks like the right one.
 *
 * A section is left alone when it could legitimately be showing the finding —
 * it reads the whole audit, or it is the queue for that finding's state.
 *
 * A filter is the reader's own and is never dropped for a link: the round trip
 * of turning it back off is what gives the place back. It is said out loud
 * instead, because a filter that hides the finding a link named leaves the url
 * naming a finding the pane does not show, and in the case where the section
 * was repaired on that finding's behalf the pane is empty entirely.
 */
interface Arrival {
  readonly patch: Partial<SearchState> | null;
  /** What the reader is told when the link could not be honoured as written. */
  readonly notice: string | null;
}

const NOTHING: Arrival = { patch: null, notice: null };

export function arrivalPatch(
  findings: readonly FindingJson[],
  section: SectionSpec,
  focus: string | null,
  filters: Filters
): Arrival {
  if (focus === null) return NOTHING;
  const target = findings.find((finding) => finding.id === focus);
  // Nothing can ever show it, so the url must stop naming it. Repairing the url
  // in silence is the console showing a section the reader did not ask for and
  // saying nothing about the finding they did.
  if (target === undefined) {
    return { patch: { focus: null }, notice: `This audit has no finding ${focus}.` };
  }
  const patch = section.wholeAudit || section.holds(target) ? null : landingPatch(target);
  const hidden = filterFindings([target], filters).length === 0;
  return {
    patch,
    notice: hidden
      ? `The filters on this view are hiding ${focus}. Clear or widen them to see it.`
      : null,
  };
}

/**
 * An area value the audit carries nothing under. The rest of the url reader
 * works from closed sets, but areas come from the corpus, so this is the one
 * key whose readability can only be decided against the findings themselves.
 *
 * Read through `areaFamily`, because that is what the rail offers and what the
 * filter selects: a link carries the family a reader picked, and most families
 * are a name no single finding spells that way.
 */
function strayArea(findings: readonly FindingJson[], area: string | null): UnhonouredValue | null {
  if (area === null) return null;
  return findings.some((finding) => areaFamily(finding.area) === area)
    ? null
    : { key: 'area', value: area };
}

const TOGGLES = new Set<string>(TOGGLE_KEYS);

function droppedTail(count: number): string {
  return count === 1
    ? 'so that part of the link was dropped'
    : 'so those parts of the link were dropped';
}

/**
 * What the reader is told about the parts of a link the url reader could not
 * honour. Repairing them is right; doing it in silence leaves the reader
 * looking at a view they did not ask for with nothing to explain it.
 *
 * A toggle is said in its own words: "this console has no group X" reads as a
 * group that could have existed, and the corpus does carry named groups.
 */
export function droppedNotice(dropped: readonly UnhonouredValue[]): string | null {
  const unknown = dropped.filter(({ key }) => !TOGGLES.has(key));
  const said: string[] = [];

  if (unknown.length > 0) {
    const named = unknown.map(({ key, value }) => `${key} "${value}"`);
    const front = named.slice(0, -1).join(', ');
    const last = named.slice(-1).join('');
    const list = front === '' ? last : `${front} or ${last}`;
    said.push(`This console has no ${list}, ${droppedTail(unknown.length)}.`);
  }
  for (const { key, value } of dropped.filter(({ key }) => TOGGLES.has(key))) {
    said.push(`The ${key} filter is on or off, and "${value}" is neither, ${droppedTail(1)}.`);
  }

  return said.length === 0 ? null : said.join(' ');
}

/**
 * Resolved once per mount: re-resolving would move the reader off the queue
 * they are working in the moment a ruling changes the state of the finding they
 * are on. Later url writes need no repair — every in-app move that sets `focus`
 * either stays in the current queue or carries its own section.
 */
export function useArrival(
  findings: readonly FindingJson[],
  section: SectionSpec,
  state: SearchState,
  update: (patch: Partial<SearchState>) => void
): string | null {
  const { focus, filters } = state;
  const arrived = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Read during the first render rather than from an effect: the shell rewrites
  // the url from an effect of its own, so by the time any effect runs the
  // values this reports are already gone from the query it would read.
  const [dropped] = useState(() => unhonouredValues(globalThis.location.search));

  useEffect(() => {
    if (arrived.current) return;
    arrived.current = true;
    const stray = strayArea(findings, filters.area);
    // Resolved before the arrival is: an area the audit never had hides every
    // finding, and reporting the link's own target as hidden by it would name
    // the wrong cause.
    const honoured = stray === null ? filters : { ...filters, area: null };
    const arrival = arrivalPatch(findings, section, focus, honoured);
    const patch = stray === null ? arrival.patch : { ...arrival.patch, filters: honoured };
    if (patch !== null) update(patch);
    const said = [
      arrival.notice,
      droppedNotice(stray === null ? dropped : [...dropped, stray]),
    ].filter((line) => line !== null);
    if (said.length > 0) setNotice(said.join(' '));
  });

  return notice;
}
