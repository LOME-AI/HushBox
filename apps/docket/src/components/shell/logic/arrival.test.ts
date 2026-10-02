import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { parseSearchState, searchStateToQuery } from '@/hooks/use-search-state';
import { arrivalPatch, droppedNotice, useArrival } from './arrival';
import { areaFilterOptions, EMPTY_FILTERS } from './filters';
import { sectionSpec } from './sections';
import type { Filters } from './filters';
import type { SearchState } from '@/hooks/use-search-state';
import type { FindingJson } from '@hushbox/docket';

const audit: readonly FindingJson[] = [
  makeFinding({ id: 'A-1', state: 'open', area: 'apps/web', severity: 'low' }),
  makeFinding({ id: 'A-3', state: 'open', questions: [makeQuestion()] }),
  makeFinding({ id: 'A-4', state: 'ruled', area: 'apps/web', severity: 'low' }),
  makeFinding({ id: 'A-5', state: 'denied' }),
];

const NOTHING = { patch: null, notice: null };

/** The url as the shell read it, which is what the hook resolves an arrival from. */
function link(focus: string | null, filters: Filters = EMPTY_FILTERS): SearchState {
  return { section: 'open', focus, mode: 'list', filters };
}

describe('arrivalPatch', () => {
  it('has nothing to correct on a link that names no finding', () => {
    expect(arrivalPatch(audit, sectionSpec('open'), null, EMPTY_FILTERS)).toEqual(NOTHING);
  });

  it('leaves a finding the section already holds alone', () => {
    expect(arrivalPatch(audit, sectionSpec('open'), 'A-1', EMPTY_FILTERS)).toEqual(NOTHING);
  });

  it('leaves a section alone when a derived membership puts the finding there', () => {
    expect(arrivalPatch(audit, sectionSpec('questions'), 'A-3', EMPTY_FILTERS)).toEqual(NOTHING);
  });

  it('sends a questioned finding to the questions section', () => {
    expect(arrivalPatch(audit, sectionSpec('open'), 'A-3', EMPTY_FILTERS).patch).toEqual({
      section: 'questions',
      focus: 'A-3',
    });
  });

  it('sends a ruled finding to the ruled section', () => {
    expect(arrivalPatch(audit, sectionSpec('open'), 'A-4', EMPTY_FILTERS).patch).toEqual({
      section: 'ruled',
      focus: 'A-4',
    });
  });

  it('sends a denied finding to the denied section', () => {
    expect(arrivalPatch(audit, sectionSpec('open'), 'A-5', EMPTY_FILTERS).patch).toEqual({
      section: 'denied',
      focus: 'A-5',
    });
  });

  it('says nothing about a link it could honour', () => {
    expect(arrivalPatch(audit, sectionSpec('open'), 'A-3', EMPTY_FILTERS).notice).toBeNull();
  });

  it('drops a focus the audit holds no finding for, so the url stops claiming it', () => {
    expect(arrivalPatch(audit, sectionSpec('open'), 'NOPE-9', EMPTY_FILTERS).patch).toEqual({
      focus: null,
    });
  });

  it('names the finding it could not find, rather than repairing the url in silence', () => {
    expect(arrivalPatch(audit, sectionSpec('open'), 'NOPE-9', EMPTY_FILTERS).notice).toBe(
      'This audit has no finding NOPE-9.'
    );
  });

  it('leaves a section that reads the whole audit alone, because it holds every state', () => {
    expect(arrivalPatch(audit, sectionSpec('dashboard'), 'A-4', EMPTY_FILTERS)).toEqual(NOTHING);
  });

  it('reads progress as the ruled queue it is, rather than moving the reader off it', () => {
    expect(arrivalPatch(audit, sectionSpec('progress'), 'A-4', EMPTY_FILTERS)).toEqual(NOTHING);
  });

  it('says a filter is hiding the finding the link named, rather than showing an empty pane', () => {
    expect(
      arrivalPatch(audit, sectionSpec('open'), 'A-1', {
        ...EMPTY_FILTERS,
        severity: ['critical'],
      }).notice
    ).toBe('The filters on this view are hiding A-1. Clear or widen them to see it.');
  });

  it('says so about the section it moved to on the finding behalf, which the filter then empties', () => {
    expect(
      arrivalPatch(audit, sectionSpec('open'), 'A-4', { ...EMPTY_FILTERS, area: 'packages/db' })
    ).toEqual({
      patch: { section: 'ruled', focus: 'A-4' },
      notice: 'The filters on this view are hiding A-4. Clear or widen them to see it.',
    });
  });

  it('says nothing about filters that admit the finding the link named', () => {
    expect(
      arrivalPatch(audit, sectionSpec('open'), 'A-1', { ...EMPTY_FILTERS, area: 'apps/web' }).notice
    ).toBeNull();
  });

  it('leaves a missing finding reported as missing rather than as hidden', () => {
    expect(
      arrivalPatch(audit, sectionSpec('open'), 'NOPE-9', {
        ...EMPTY_FILTERS,
        severity: ['critical'],
      }).notice
    ).toBe('This audit has no finding NOPE-9.');
  });
});

describe('droppedNotice', () => {
  it('says nothing when the link was honoured in full', () => {
    expect(droppedNotice([])).toBeNull();
  });

  it('names the one value it could not honour', () => {
    expect(droppedNotice([{ key: 'section', value: 'bogus' }])).toBe(
      'This console has no section "bogus", so that part of the link was dropped.'
    );
  });

  it('names every value it could not honour', () => {
    expect(
      droppedNotice([
        { key: 'section', value: 'bogus' },
        { key: 'view', value: 'weird' },
        { key: 'severity', value: 'nope' },
      ])
    ).toBe(
      'This console has no section "bogus", view "weird" or severity "nope", so those parts of the link were dropped.'
    );
  });

  it('reads a toggle as the yes or no it is, rather than as a group that could exist', () => {
    expect(droppedNotice([{ key: 'group', value: 'true' }])).toBe(
      'The group filter is on or off, and "true" is neither, so that part of the link was dropped.'
    );
  });

  it('reads the warning toggle the same way', () => {
    expect(droppedNotice([{ key: 'warning', value: 'yes' }])).toBe(
      'The warning filter is on or off, and "yes" is neither, so that part of the link was dropped.'
    );
  });

  it('keeps a toggle apart from the values it could have named', () => {
    expect(
      droppedNotice([
        { key: 'section', value: 'bogus' },
        { key: 'group', value: 'true' },
      ])
    ).toBe(
      'This console has no section "bogus", so that part of the link was dropped. The group filter is on or off, and "true" is neither, so that part of the link was dropped.'
    );
  });
});

describe('useArrival', () => {
  beforeEach(() => {
    globalThis.history.replaceState({}, '', '/');
  });

  it('tells the reader about the url keys it repaired, rather than repairing them in silence', () => {
    globalThis.history.replaceState({}, '', '/?section=bogus&view=weird&severity=nope');
    const view = renderHook(() => useArrival(audit, sectionSpec('open'), link(null), vi.fn()));

    expect(view.result.current).toBe(
      'This console has no section "bogus", view "weird" or severity "nope", so those parts of the link were dropped.'
    );
  });

  it('tells the reader about a missing finding and a dropped key together', () => {
    globalThis.history.replaceState({}, '', '/?section=bogus&focus=NOPE-9');
    const view = renderHook(() => useArrival(audit, sectionSpec('open'), link('NOPE-9'), vi.fn()));

    expect(view.result.current).toBe(
      'This audit has no finding NOPE-9. This console has no section "bogus", so that part of the link was dropped.'
    );
  });

  it('corrects the view once, on arrival', () => {
    const update = vi.fn();
    const view = renderHook(() => useArrival(audit, sectionSpec('open'), link('A-3'), update));

    view.rerender();

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ section: 'questions', focus: 'A-3' });
  });

  it('never fires again, so a write that changes a state does not move the reader', () => {
    const update = vi.fn();
    const afterTheRuling: readonly FindingJson[] = [makeFinding({ id: 'A-1', state: 'ruled' })];
    const view = renderHook(
      ({ findings }: { findings: readonly FindingJson[] }) =>
        useArrival(findings, sectionSpec('open'), link('A-1'), update),
      { initialProps: { findings: audit } }
    );

    view.rerender({ findings: afterTheRuling });

    expect(update).not.toHaveBeenCalled();
  });

  it('hands back what the reader has to be told about the link they followed', () => {
    const view = renderHook(() => useArrival(audit, sectionSpec('open'), link('NOPE-9'), vi.fn()));

    expect(view.result.current).toBe('This audit has no finding NOPE-9.');
  });

  it('hands back nothing when the link landed where it said it would', () => {
    const view = renderHook(() => useArrival(audit, sectionSpec('open'), link('A-1'), vi.fn()));

    expect(view.result.current).toBeNull();
  });

  it('drops an area this audit never had, the way every other unreadable value is dropped', () => {
    globalThis.history.replaceState({}, '', '/?area=not-a-real-area');
    const update = vi.fn();
    const filters = { ...EMPTY_FILTERS, area: 'not-a-real-area' };
    renderHook(() => useArrival(audit, sectionSpec('open'), link(null, filters), update));

    expect(update).toHaveBeenCalledWith({ filters: { ...EMPTY_FILTERS, area: null } });
  });

  it('names the area it dropped, rather than offering it as a filter that matches nothing', () => {
    globalThis.history.replaceState({}, '', '/?area=not-a-real-area');
    const filters = { ...EMPTY_FILTERS, area: 'not-a-real-area' };
    const view = renderHook(() =>
      useArrival(audit, sectionSpec('open'), link(null, filters), vi.fn())
    );

    expect(view.result.current).toBe(
      'This console has no area "not-a-real-area", so that part of the link was dropped.'
    );
  });

  it('keeps an area the audit carries, however few findings this section has of it', () => {
    const update = vi.fn();
    const filters = { ...EMPTY_FILTERS, area: 'apps/web' };
    const view = renderHook(() =>
      useArrival(audit, sectionSpec('denied'), link(null, filters), update)
    );

    expect(update).not.toHaveBeenCalled();
    expect(view.result.current).toBeNull();
  });

  it('reads a link past the area it dropped, so the finding is not reported as hidden by it', () => {
    globalThis.history.replaceState({}, '', '/?area=not-a-real-area&focus=A-1');
    const filters = { ...EMPTY_FILTERS, area: 'not-a-real-area' };
    const view = renderHook(() =>
      useArrival(audit, sectionSpec('open'), link('A-1', filters), vi.fn())
    );

    expect(view.result.current).toBe(
      'This console has no area "not-a-real-area", so that part of the link was dropped.'
    );
  });

  it('tells the reader about a hidden finding and a dropped key together', () => {
    globalThis.history.replaceState({}, '', '/?section=bogus&severity=critical&focus=A-1');
    const filters = { ...EMPTY_FILTERS, severity: ['critical' as const] };
    const view = renderHook(() =>
      useArrival(audit, sectionSpec('open'), link('A-1', filters), vi.fn())
    );

    expect(view.result.current).toBe(
      'The filters on this view are hiding A-1. Clear or widen them to see it. This console has no section "bogus", so that part of the link was dropped.'
    );
  });
});

/**
 * Real `area` spellings from the audit this console was built for, no two of the
 * same code family, chosen for the tails the rail groups away — comma lists,
 * bracketed asides, prose after the path, file citations. Entries are never
 * pruned when a finding is ruled, so this is a superset of the open queue rather
 * than a mirror of it.
 */
const CORPUS_AREAS = [
  '.github/',
  '.github/CODEOWNERS',
  '.github/workflows/ci.yml deploy job + scripts/compute-next-version.ts',
  'apps/api identity slice (symptom in apps/web lib)',
  'apps/crawler-view',
  'apps/marketing, packages/config',
  'apps/sandbox',
  'apps/web lib chat, packages/shared error codes',
  'CI, dependencies',
  'dependencies, all workspaces',
  'docker-compose.yml, .github/workflows/ci.yml, docs/DEVELOPMENT.md',
  'docs/',
  'docs/DEVELOPMENT.md',
  'e2e docs + apps/api models slice',
  'identity slice + packages/realtime',
  'mobile-tests / apps/web capacitor',
  'ops',
  'package manager configuration',
  'packages/config, packages/shared, apps/marketing',
  'packages/crypto + share viewer (apps/web)',
  'packages/db, apps/api newsletter and identity slices',
  'packages/realtime',
  'packages/shared, apps/admin, apps/api admin slice',
  'packages/ui (accessibility styles) + apps/marketing',
  'pnpm-workspace.yaml',
  'repo tooling / CI',
  'repo-wide (apps/api, apps/web, packages/realtime, packages/config, scripts, e2e)',
  'root workspace configuration + .github/workflows/ci.yml',
  'scripts/compute-next-version.ts, ops/lib/resolve-pr-scripts.ts',
  'scripts/lib/gitleaks.ts + .github/workflows/ci.yml',
  'unknown',
  'workspace manifests',
] as const;

describe('an area the rail offers, followed back as a link', () => {
  const corpus: readonly FindingJson[] = CORPUS_AREAS.map((area, index) =>
    makeFinding({ id: `RT-${String(index)}`, area, state: 'open' })
  );

  /** The reader's own round trip: pick in the rail, write the url, reload it. */
  function reload(area: string): string | null {
    const query = searchStateToQuery({
      section: 'open',
      focus: null,
      mode: 'list',
      filters: { ...EMPTY_FILTERS, area },
    });
    globalThis.history.replaceState({}, '', `/${query}`);

    return renderHook(() =>
      useArrival(corpus, sectionSpec('open'), parseSearchState(query), vi.fn())
    ).result.current;
  }

  it('is honoured for every area the rail can offer', () => {
    const offered = areaFilterOptions(corpus, EMPTY_FILTERS, sectionSpec('open'));

    expect(offered.map((option) => option.value).filter((area) => reload(area) !== null)).toEqual(
      []
    );
  });

  it('offers one option per code family, not one per spelling', () => {
    expect(areaFilterOptions(corpus, EMPTY_FILTERS, sectionSpec('open'))).toHaveLength(
      CORPUS_AREAS.length
    );
  });
});
