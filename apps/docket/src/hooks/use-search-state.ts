import { useCallback, useEffect, useRef, useState } from 'react';
// The narrow path, never the package barrel: the barrel reaches the store and
// the citation index, whose node imports cannot load in a browser.
import { FINDING_STATUSES, KINDS, SEVERITIES } from '@hushbox/docket/types';
import { EMPTY_FILTERS } from '@/components/shell/logic/filters';
import { SECTION_IDS, isSectionId } from '@/components/shell/logic/sections';
import { VIEW_MODES, isViewMode } from '@/components/shell/logic/view-mode';
import type { Filters } from '@/components/shell/logic/filters';
import type { SectionId } from '@/components/shell/logic/sections';
import type { ViewMode } from '@/components/shell/logic/view-mode';

export interface SearchState {
  readonly section: SectionId;
  /** The finding the reader is on, so a link lands on it. */
  readonly focus: string | null;
  /**
   * Which view is on screen. It belongs to the same authority as `focus`
   * rather than to the browser's storage: opening a finding is a move, and a
   * move the reader can undo has to be one the history stack holds.
   */
  readonly mode: ViewMode;
  readonly filters: Filters;
}

/**
 * `push` is for a move the reader asked for, so Back undoes it. Everything
 * else replaces: a queue step, a filter, and the console's own correction of a
 * link are not places to return to, and one history entry per keystroke would
 * bury the page the reader arrived from.
 */
type HistoryMove = 'push' | 'replace';

interface UseSearchState {
  readonly state: SearchState;
  /** The audit on screen; {@link parseAudit} says what `null` names. */
  readonly audit: string | null;
  readonly update: (patch: Partial<SearchState>, move?: HistoryMove) => void;
  readonly setFilters: (patch: Partial<Filters>) => void;
  /**
   * Choosing an audit is a clean slate: a section, a filter or a focused id
   * was chosen against one audit's findings and says nothing about another's,
   * and a focus that names a finding the new audit does not hold is a worse
   * arrival than the top of its queue. The audit and the view move in one
   * state change, so the switch costs one history entry and one Back press
   * returns to both the audit and the view it was being read on.
   */
  readonly switchAudit: (name: string | null) => void;
}

/** What the address bar holds: an audit, and the view being read over it. */
interface AddressState {
  readonly audit: string | null;
  readonly view: SearchState;
}

/**
 * Each key is read on its own and an unreadable one is dropped, so a
 * hand-edited or stale link opens on the view it can still express instead of
 * failing. Same discipline as the admin app's per-route `validateSearch`.
 */
function subset<TValue extends string>(
  raw: string | null,
  allowed: readonly TValue[]
): readonly TValue[] {
  if (raw === null) return [];
  const seen = new Set<TValue>();
  for (const part of raw.split(',')) {
    const value = allowed.find((candidate) => candidate === part);
    if (value !== undefined) seen.add(value);
  }
  return [...seen];
}

/**
 * The url keys whose values come from a closed set. Reading a link and
 * reporting what it lost both walk this table, so a value can never be dropped
 * by one and unknown to the other.
 */
const CLOSED_KEYS = {
  section: SECTION_IDS,
  view: VIEW_MODES,
  severity: SEVERITIES,
  status: FINDING_STATUSES,
  kind: KINDS,
} as const;

/**
 * The keys that carry a toggle. `1` turns it on and `0` turns it off, which is
 * also what leaving the key out does; the writer below emits the key only when
 * it is on. So a value that is neither can only be a hand-written link asking
 * for a filter the console then did not turn on, and saying nothing about it
 * leaves the reader with a queue they believe is narrowed and is not.
 */
const TOGGLE_ON = '1';
export const TOGGLE_KEYS = ['warning', 'group'] as const;
const TOGGLE_VALUES = new Set([TOGGLE_ON, '0']);

/**
 * Read whole rather than split on commas: a toggle takes one value, and a
 * reader who wrote a list of them wrote something the console cannot read.
 */
function unhonouredToggles(params: URLSearchParams): readonly UnhonouredValue[] {
  const dropped: UnhonouredValue[] = [];
  for (const key of TOGGLE_KEYS) {
    const raw = params.get(key);
    if (raw === null || raw === '' || TOGGLE_VALUES.has(raw)) continue;
    dropped.push({ key, value: raw });
  }
  return dropped;
}

/** What a link asked for that the console could not give it. */
export interface UnhonouredValue {
  readonly key: string;
  readonly value: string;
}

/**
 * Self-repairing a link is right; doing it in silence is not. The console
 * shows a view the reader did not ask for, so it has to say which part of what
 * they did ask for it could not honour.
 */
export function unhonouredValues(search: string): readonly UnhonouredValue[] {
  const params = new URLSearchParams(search);
  const dropped: UnhonouredValue[] = [];
  for (const [key, allowed] of Object.entries<readonly string[]>(CLOSED_KEYS)) {
    const raw = params.get(key);
    if (raw === null || raw === '') continue;
    for (const value of raw.split(',')) {
      if (!allowed.includes(value)) dropped.push({ key, value });
    }
  }
  return [...dropped, ...unhonouredToggles(params)];
}

/**
 * The audit the view is read over. `null` is the audit the server serves when
 * the url names none, which is what an omitted key means everywhere else here
 * — so the reader who is on the served audit has a url that names only what
 * they chose. It is read apart from {@link SearchState} because it is not part
 * of the view: choosing an audit replaces the view rather than patching it.
 */
export function parseAudit(search: string): string | null {
  const audit = new URLSearchParams(search).get('audit');
  return audit === null || audit === '' ? null : audit;
}

export function parseSearchState(search: string): SearchState {
  const params = new URLSearchParams(search);
  const section = params.get('section');
  const focus = params.get('focus');
  const view = params.get('view');
  const area = params.get('area');

  return {
    section: isSectionId(section) ? section : 'open',
    focus: focus === null || focus === '' ? null : focus,
    mode: isViewMode(view) ? view : 'list',
    filters: {
      q: params.get('q') ?? EMPTY_FILTERS.q,
      severity: subset(params.get('severity'), CLOSED_KEYS.severity),
      status: subset(params.get('status'), CLOSED_KEYS.status),
      kind: subset(params.get('kind'), CLOSED_KEYS.kind),
      area: area === null || area === '' ? null : area,
      warning: params.get('warning') === TOGGLE_ON,
      grouped: params.get('group') === TOGGLE_ON,
    },
  };
}

function writtenKeys(
  state: SearchState,
  audit: string | null
): readonly (readonly [string, string])[] {
  const { filters } = state;
  return [
    ['audit', audit ?? ''],
    ['section', state.section === 'open' ? '' : state.section],
    ['q', filters.q],
    ['severity', filters.severity.join(',')],
    ['status', filters.status.join(',')],
    ['kind', filters.kind.join(',')],
    ['area', filters.area ?? ''],
    ['warning', filters.warning ? TOGGLE_ON : ''],
    ['group', filters.grouped ? TOGGLE_ON : ''],
    ['focus', state.focus ?? ''],
    ['view', state.mode === 'list' ? '' : state.mode],
  ];
}

/** A key is written only when it says something; the default view has a bare url. */
export function searchStateToQuery(state: SearchState, audit: string | null = null): string {
  const params = new URLSearchParams();
  for (const [key, value] of writtenKeys(state, audit)) {
    if (value !== '') params.set(key, value);
  }

  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

function readAddress(search: string): AddressState {
  return { audit: parseAudit(search), view: parseSearchState(search) };
}

/**
 * The view lives in the address bar: filters, section and focused finding are
 * all link-reproducible.
 */
export function useSearchState(): UseSearchState {
  const [address, setAddress] = useState<AddressState>(() =>
    readAddress(globalThis.location.search)
  );
  // Set by whoever asked for the move and consumed by the write below, so the
  // intent reaches the history call that the state change is about to trigger.
  const move = useRef<HistoryMove>('replace');

  useEffect(() => {
    const onPopState = (): void => {
      setAddress(readAddress(globalThis.location.search));
    };
    globalThis.addEventListener('popstate', onPopState);
    return () => {
      globalThis.removeEventListener('popstate', onPopState);
    };
  }, []);

  useEffect(() => {
    const pending = move.current;
    move.current = 'replace';
    const query = searchStateToQuery(address.view, address.audit);
    // A move that lands on the url already shown is not a place to come back
    // to, however it was asked for.
    if (query === globalThis.location.search) return;
    const url = `${globalThis.location.pathname}${query}`;
    if (pending === 'push') globalThis.history.pushState(globalThis.history.state, '', url);
    else globalThis.history.replaceState(globalThis.history.state, '', url);
  }, [address]);

  const update = useCallback((patch: Partial<SearchState>, next: HistoryMove = 'replace'): void => {
    move.current = next;
    setAddress((previous) => ({ ...previous, view: { ...previous.view, ...patch } }));
  }, []);

  const setFilters = useCallback((patch: Partial<Filters>): void => {
    setAddress((previous) => ({
      ...previous,
      view: { ...previous.view, filters: { ...previous.view.filters, ...patch } },
    }));
  }, []);

  const switchAudit = useCallback((name: string | null): void => {
    move.current = 'push';
    // The slate is what a url with nothing on it reads as, so a key added to
    // the view later is cleared by the switch without being listed here.
    setAddress({ audit: name, view: parseSearchState('') });
  }, []);

  return { state: address.view, audit: address.audit, update, setFilters, switchAudit };
}
