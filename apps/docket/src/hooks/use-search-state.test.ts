import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { EMPTY_FILTERS } from '@/components/shell/logic/filters';
import {
  parseAudit,
  parseSearchState,
  searchStateToQuery,
  unhonouredValues,
  useSearchState,
} from './use-search-state';
import type { SearchState } from './use-search-state';

const DEFAULT_VIEW: SearchState = {
  section: 'open',
  focus: null,
  mode: 'list',
  filters: EMPTY_FILTERS,
};

/** Every key a view can put in the url, so a switch has all of them to drop. */
const FULL_VIEW_SEARCH =
  '?audit=2026-07-30&section=denied&q=wallet&severity=high&status=live&kind=defect' +
  '&area=apps%2Fweb&warning=1&group=1&focus=DB-3&view=focus';

const SIBLING_KEYS = [
  'section',
  'q',
  'severity',
  'status',
  'kind',
  'area',
  'warning',
  'group',
  'focus',
  'view',
] as const;

function setUrl(search: string): void {
  globalThis.history.replaceState({}, '', `/${search}`);
}

describe('parseSearchState', () => {
  it('defaults to the open section, in list view, with nothing filtered', () => {
    expect(parseSearchState('')).toEqual({
      section: 'open',
      focus: null,
      mode: 'list',
      filters: EMPTY_FILTERS,
    });
  });

  it('reads the view the reader was in', () => {
    expect(parseSearchState('?view=focus').mode).toBe('focus');
  });

  it('drops a view the console cannot show', () => {
    expect(parseSearchState('?view=zoom').mode).toBe('list');
  });

  it('reads a known section', () => {
    expect(parseSearchState('?section=denied').section).toBe('denied');
  });

  it('drops an unknown section instead of failing', () => {
    expect(parseSearchState('?section=archive').section).toBe('open');
  });

  it('reads the focused finding', () => {
    expect(parseSearchState('?focus=DB-3').focus).toBe('DB-3');
  });

  it('drops an empty focus', () => {
    expect(parseSearchState('?focus=').focus).toBeNull();
  });

  it('reads a multi-value severity filter', () => {
    expect(parseSearchState('?severity=critical,high').filters.severity).toEqual([
      'critical',
      'high',
    ]);
  });

  it('drops the invalid members of a multi-value filter and keeps the rest', () => {
    expect(parseSearchState('?severity=critical,urgent').filters.severity).toEqual(['critical']);
  });

  it('drops a filter whose every value is invalid', () => {
    expect(parseSearchState('?status=nope').filters.status).toEqual([]);
  });

  it('never repeats a value that appears twice', () => {
    expect(parseSearchState('?kind=defect,defect').filters.kind).toEqual(['defect']);
  });

  it('reads the area verbatim, including the placeholder the migration writes', () => {
    expect(parseSearchState('?area=unknown').filters.area).toBe('unknown');
  });

  it('reads the boolean filters', () => {
    const filters = parseSearchState('?warning=1&group=1').filters;

    expect([filters.warning, filters.grouped]).toEqual([true, true]);
  });

  it('treats any other boolean value as unset', () => {
    const filters = parseSearchState('?warning=yes&group=0').filters;

    expect([filters.warning, filters.grouped]).toEqual([false, false]);
  });

  it('reads the search text', () => {
    expect(parseSearchState('?q=wallet+lock').filters.q).toBe('wallet lock');
  });

  it('survives one bad value beside good ones', () => {
    const state = parseSearchState('?section=nope&severity=high&q=lock');

    expect([state.section, state.filters.severity, state.filters.q]).toEqual([
      'open',
      ['high'],
      'lock',
    ]);
  });
});

describe('parseAudit', () => {
  it('reads the audit a link names', () => {
    expect(parseAudit('?audit=2026-09-01')).toBe('2026-09-01');
  });

  it('reads no audit from a link that names none', () => {
    expect(parseAudit('?section=ruled')).toBeNull();
  });

  it('drops an empty audit', () => {
    expect(parseAudit('?audit=')).toBeNull();
  });
});

describe('unhonouredValues', () => {
  it('reports nothing for a link the console can honour in full', () => {
    expect(unhonouredValues('?section=denied&view=focus&severity=high')).toEqual([]);
  });

  it('reports a section the console cannot show', () => {
    expect(unhonouredValues('?section=archive')).toEqual([{ key: 'section', value: 'archive' }]);
  });

  it('reports a view the console cannot show', () => {
    expect(unhonouredValues('?view=zoom')).toEqual([{ key: 'view', value: 'zoom' }]);
  });

  it('reports each dropped member of a multi-value filter', () => {
    expect(unhonouredValues('?severity=critical,urgent,vital')).toEqual([
      { key: 'severity', value: 'urgent' },
      { key: 'severity', value: 'vital' },
    ]);
  });

  it('reports the status and kind filters by the same reading', () => {
    expect(unhonouredValues('?status=nope&kind=nope')).toEqual([
      { key: 'status', value: 'nope' },
      { key: 'kind', value: 'nope' },
    ]);
  });

  it('reports nothing for the keys that take any value', () => {
    expect(unhonouredValues('?q=lock&area=invented&focus=ZZ-999')).toEqual([]);
  });

  it('reports a toggle a link asked for in a spelling the console cannot read', () => {
    expect(unhonouredValues('?warning=true')).toEqual([{ key: 'warning', value: 'true' }]);
  });

  it('reports the group toggle by the same reading', () => {
    expect(unhonouredValues('?group=yes')).toEqual([{ key: 'group', value: 'yes' }]);
  });

  it('reports nothing for either spelling of a toggle the console does read', () => {
    expect(unhonouredValues('?warning=1&group=0')).toEqual([]);
  });

  it('reports nothing for a toggle left empty, which is the key not being asked for', () => {
    expect(unhonouredValues('?warning=')).toEqual([]);
  });

  it('reports every key of a link that got several wrong at once', () => {
    expect(unhonouredValues('?section=bogus&view=weird&severity=nope')).toEqual([
      { key: 'section', value: 'bogus' },
      { key: 'view', value: 'weird' },
      { key: 'severity', value: 'nope' },
    ]);
  });
});

describe('searchStateToQuery', () => {
  it('writes nothing for the default view', () => {
    expect(
      searchStateToQuery({ section: 'open', focus: null, mode: 'list', filters: EMPTY_FILTERS })
    ).toBe('');
  });

  it('writes the audit the view is being read over', () => {
    expect(searchStateToQuery(DEFAULT_VIEW, '2026-09-01')).toBe('?audit=2026-09-01');
  });

  it('writes nothing for the audit the server serves without being asked', () => {
    expect(searchStateToQuery(DEFAULT_VIEW, null)).toBe('');
  });

  it('round-trips the audit beside the view', () => {
    const query = searchStateToQuery({ ...DEFAULT_VIEW, section: 'ruled' }, '2026-09-01');

    expect([parseAudit(query), parseSearchState(query).section]).toEqual(['2026-09-01', 'ruled']);
  });

  it('round-trips a fully specified view', () => {
    const state = {
      section: 'ruled' as const,
      focus: 'DB-3',
      mode: 'focus' as const,
      filters: {
        q: 'wallet lock',
        severity: ['critical' as const],
        status: ['live' as const, 'latent' as const],
        kind: ['decision' as const],
        area: 'packages/db',
        warning: true,
        grouped: true,
      },
    };

    expect(parseSearchState(searchStateToQuery(state))).toEqual(state);
  });
});

describe('useSearchState', () => {
  beforeEach(() => {
    setUrl('');
  });

  it('starts from the url', () => {
    setUrl('?section=ruled');

    const { result } = renderHook(() => useSearchState());

    expect(result.current.state.section).toBe('ruled');
  });

  it('writes a change back into the url', () => {
    const { result } = renderHook(() => useSearchState());

    act(() => {
      result.current.update({ section: 'denied' });
    });

    expect(globalThis.location.search).toBe('?section=denied');
    expect(result.current.state.section).toBe('denied');
  });

  it('writes the view the reader switched to into the url', () => {
    const { result } = renderHook(() => useSearchState());

    act(() => {
      result.current.update({ mode: 'focus' }, 'push');
    });

    expect(globalThis.location.search).toBe('?view=focus');
  });

  it('merges one filter without dropping its siblings', () => {
    const { result } = renderHook(() => useSearchState());

    act(() => {
      result.current.setFilters({ severity: ['high'] });
    });
    act(() => {
      result.current.setFilters({ warning: true });
    });

    expect(result.current.state.filters.severity).toEqual(['high']);
    expect(result.current.state.filters.warning).toBe(true);
  });

  it('normalizes an invalid value out of the url on load', () => {
    setUrl('?section=archive&severity=high');

    renderHook(() => useSearchState());

    expect(globalThis.location.search).toBe('?severity=high');
  });

  it('leaves no way back out of the application when a move is incidental', () => {
    const { result } = renderHook(() => useSearchState());
    const depth = globalThis.history.length;

    act(() => {
      result.current.update({ focus: 'DB-3' });
    });

    expect(globalThis.history.length).toBe(depth);
  });

  it('gives back a step for a move the reader asked for', () => {
    const { result } = renderHook(() => useSearchState());
    const depth = globalThis.history.length;

    act(() => {
      result.current.update({ section: 'denied' }, 'push');
    });

    expect(globalThis.history.length).toBe(depth + 1);
  });

  it('keeps a filter change out of the history stack', () => {
    const { result } = renderHook(() => useSearchState());
    const depth = globalThis.history.length;

    act(() => {
      result.current.setFilters({ severity: ['high'] });
    });

    expect(globalThis.history.length).toBe(depth);
  });

  it('does not spend a history entry on a move that changes nothing', () => {
    setUrl('?section=denied');
    const { result } = renderHook(() => useSearchState());
    const depth = globalThis.history.length;

    act(() => {
      result.current.update({ section: 'denied' }, 'push');
    });

    expect(globalThis.history.length).toBe(depth);
  });

  it('does not carry a push over to the next incidental move', () => {
    setUrl('?section=denied');
    const { result } = renderHook(() => useSearchState());

    act(() => {
      result.current.update({ section: 'denied' }, 'push');
    });
    const depth = globalThis.history.length;
    act(() => {
      result.current.update({ focus: 'DB-3' });
    });

    expect(globalThis.history.length).toBe(depth);
  });

  it('starts from the audit the url names', () => {
    setUrl('?audit=2026-09-01');

    const { result } = renderHook(() => useSearchState());

    expect(result.current.audit).toBe('2026-09-01');
  });

  it('reads a url that names no audit as the one the server serves', () => {
    const { result } = renderHook(() => useSearchState());

    expect(result.current.audit).toBeNull();
  });

  it('writes the audit the reader switched to into the url', () => {
    const { result } = renderHook(() => useSearchState());

    act(() => {
      result.current.switchAudit('2026-09-01');
    });

    expect(globalThis.location.search).toBe('?audit=2026-09-01');
    expect(result.current.audit).toBe('2026-09-01');
  });

  it('drops every other key from the url when the reader switches audit', () => {
    setUrl(FULL_VIEW_SEARCH);
    const { result } = renderHook(() => useSearchState());

    act(() => {
      result.current.switchAudit('2026-09-01');
    });

    const params = new URLSearchParams(globalThis.location.search);
    for (const key of SIBLING_KEYS) {
      expect(params.get(key), key).toBeNull();
    }
    expect(globalThis.location.search).toBe('?audit=2026-09-01');
  });

  it('puts the view back to the one a bare url gives when the reader switches audit', () => {
    setUrl(FULL_VIEW_SEARCH);
    const { result } = renderHook(() => useSearchState());

    act(() => {
      result.current.switchAudit('2026-09-01');
    });

    expect(result.current.state).toEqual(DEFAULT_VIEW);
  });

  it('leaves a bare url behind when the reader switches to the audit the server serves', () => {
    setUrl(FULL_VIEW_SEARCH);
    const { result } = renderHook(() => useSearchState());

    act(() => {
      result.current.switchAudit(null);
    });

    expect(globalThis.location.search).toBe('');
  });

  it('spends one history entry on a switch, whatever the view it left', () => {
    setUrl(FULL_VIEW_SEARCH);
    const { result } = renderHook(() => useSearchState());
    const depth = globalThis.history.length;

    act(() => {
      result.current.switchAudit('2026-09-01');
    });

    expect(globalThis.history.length).toBe(depth + 1);
  });

  it('gives one browser Back the audit and the view the switch left behind', async () => {
    setUrl(FULL_VIEW_SEARCH);
    const { result } = renderHook(() => useSearchState());

    act(() => {
      result.current.switchAudit('2026-09-01');
    });
    await act(async () => {
      globalThis.history.back();
      await vi.waitUntil(() => globalThis.location.search !== '?audit=2026-09-01');
    });

    expect(result.current.audit).toBe('2026-07-30');
    expect(result.current.state.section).toBe('denied');
    expect(result.current.state.filters.severity).toEqual(['high']);
  });

  it('follows a browser history move onto another audit', () => {
    const { result } = renderHook(() => useSearchState());

    act(() => {
      setUrl('?audit=2026-09-01');
      globalThis.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.audit).toBe('2026-09-01');
  });

  it('follows a browser history move', () => {
    const { result } = renderHook(() => useSearchState());

    act(() => {
      setUrl('?section=questions');
      globalThis.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current.state.section).toBe('questions');
  });

  it('stops listening once unmounted', () => {
    const { result, unmount } = renderHook(() => useSearchState());
    const before = result.current.state;

    unmount();
    setUrl('?section=questions');
    globalThis.dispatchEvent(new PopStateEvent('popstate'));

    expect(result.current.state).toBe(before);
  });
});
