import { describe, it, expect } from 'vitest';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import {
  EMPTY_FILTERS,
  areaFilterOptions,
  areaOptions,
  countBySection,
  decidedCount,
  filterFindings,
  findingsInSection,
  isFiltering,
} from './filters';
import { SECTION_IDS, sectionSpec } from './sections';
import type { FindingJson } from '@hushbox/docket';

describe('filterFindings', () => {
  it('keeps everything when no filter is set', () => {
    const findings = [makeFinding({ id: 'A-1' }), makeFinding({ id: 'A-2' })];

    expect(filterFindings(findings, EMPTY_FILTERS)).toHaveLength(2);
  });

  it('keeps only the selected severities', () => {
    const findings = [
      makeFinding({ id: 'A-1', severity: 'critical' }),
      makeFinding({ id: 'A-2', severity: 'low' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, severity: ['critical'] });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1']);
  });

  it('keeps any of several selected severities', () => {
    const findings = [
      makeFinding({ id: 'A-1', severity: 'critical' }),
      makeFinding({ id: 'A-2', severity: 'low' }),
      makeFinding({ id: 'A-3', severity: 'medium' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, severity: ['critical', 'medium'] });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1', 'A-3']);
  });

  it('keeps only the selected statuses', () => {
    const findings = [
      makeFinding({ id: 'A-1', status: 'live' }),
      makeFinding({ id: 'A-2', status: 'latent' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, status: ['latent'] });

    expect(kept.map((finding) => finding.id)).toEqual(['A-2']);
  });

  it('keeps only the selected kinds', () => {
    const findings = [
      makeFinding({ id: 'A-1', kind: 'defect' }),
      makeFinding({ id: 'A-2', kind: 'decision' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, kind: ['decision'] });

    expect(kept.map((finding) => finding.id)).toEqual(['A-2']);
  });

  it('keeps every spelling of the chosen area', () => {
    const findings = [
      makeFinding({ id: 'A-1', area: 'packages/db' }),
      makeFinding({ id: 'A-2', area: 'packages/db (migrations)' }),
      makeFinding({ id: 'A-3', area: 'packages/db, apps/api billing slice' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, area: 'packages/db' });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1', 'A-2', 'A-3']);
  });

  it('keeps one package out of another under the same directory', () => {
    const findings = [
      makeFinding({ id: 'A-1', area: 'apps/web (composer)' }),
      makeFinding({ id: 'A-2', area: 'apps/api/src/slices/models' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, area: 'apps/web' });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1']);
  });

  it('treats unknown as an area a reader can filter to', () => {
    const findings = [
      makeFinding({ id: 'A-1', area: 'unknown' }),
      makeFinding({ id: 'A-2', area: 'apps/api' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, area: 'unknown' });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1']);
  });

  it('keeps only warned findings when has-warning is set', () => {
    const findings = [
      makeFinding({ id: 'A-1', warning: true }),
      makeFinding({ id: 'A-2', warning: false }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, warning: true });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1']);
  });

  it('keeps only grouped findings when in-group is set', () => {
    const findings = [
      makeFinding({ id: 'A-1', group: 'A-1 + A-2' }),
      makeFinding({ id: 'A-3', group: null }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, grouped: true });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1']);
  });

  it('composes every dimension', () => {
    const findings = [
      makeFinding({ id: 'A-1', severity: 'high', kind: 'defect', warning: true }),
      makeFinding({ id: 'A-2', severity: 'high', kind: 'decision', warning: true }),
      makeFinding({ id: 'A-3', severity: 'low', kind: 'defect', warning: true }),
      makeFinding({ id: 'A-4', severity: 'high', kind: 'defect', warning: false }),
    ];

    const kept = filterFindings(findings, {
      ...EMPTY_FILTERS,
      severity: ['high'],
      kind: ['defect'],
      warning: true,
    });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1']);
  });

  it('searches the id', () => {
    const findings = [makeFinding({ id: 'DB-3' }), makeFinding({ id: 'UI-7' })];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, q: 'db-3' });

    expect(kept.map((finding) => finding.id)).toEqual(['DB-3']);
  });

  it('searches the title regardless of case', () => {
    const findings = [
      makeFinding({ id: 'A-1', title: 'The wallet lock is missing' }),
      makeFinding({ id: 'A-2', title: 'Something else' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, q: 'WALLET' });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1']);
  });

  it('searches the body text', () => {
    const findings = [
      makeFinding({ id: 'A-1', searchText: 'A-1\nfirst\nthe settlement transaction' }),
      makeFinding({ id: 'A-2', searchText: 'A-2\nsecond' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, q: 'settlement' });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1']);
  });

  it('requires every search term to match', () => {
    const findings = [
      makeFinding({ id: 'A-1', searchText: 'A-1\nwallet lock' }),
      makeFinding({ id: 'A-2', searchText: 'A-2\nwallet' }),
    ];

    const kept = filterFindings(findings, { ...EMPTY_FILTERS, q: '  wallet   lock ' });

    expect(kept.map((finding) => finding.id)).toEqual(['A-1']);
  });

  it('ignores a search of only whitespace', () => {
    const findings = [makeFinding({ id: 'A-1' })];

    expect(filterFindings(findings, { ...EMPTY_FILTERS, q: '   ' })).toHaveLength(1);
  });
});

describe('countBySection', () => {
  it('counts each state under its own section', () => {
    const findings = [
      makeFinding({ id: 'A-1', state: 'open' }),
      makeFinding({ id: 'A-2', state: 'open' }),
      makeFinding({ id: 'A-3', state: 'open', questions: [makeQuestion()] }),
      makeFinding({ id: 'A-4', state: 'ruled' }),
      makeFinding({ id: 'A-5', state: 'denied' }),
      makeFinding({
        id: 'A-6',
        state: 'ruled',
        progress: { status: 'blocked', updated: null, verified: false, notes: [] },
      }),
    ];

    expect(countBySection(findings)).toEqual({
      dashboard: 3,
      open: 2,
      questions: 1,
      blocked: 1,
      ruled: 1,
      dedicated: 0,
      denied: 1,
      progress: 2,
    });
  });

  it('counts the work still to be decided under the section that is not a state', () => {
    const findings = [
      makeFinding({ id: 'A-1', state: 'open' }),
      makeFinding({ id: 'A-2', state: 'open', questions: [makeQuestion()] }),
      makeFinding({ id: 'A-3', state: 'ruled' }),
      makeFinding({ id: 'A-4', state: 'denied' }),
    ];

    expect(countBySection(findings).dashboard).toBe(2);
  });

  it('counts nothing over an empty set', () => {
    expect(countBySection([])).toEqual({
      dashboard: 0,
      open: 0,
      questions: 0,
      blocked: 0,
      ruled: 0,
      dedicated: 0,
      denied: 0,
      progress: 0,
    });
  });
});

describe('decidedCount', () => {
  it('counts ruled and denied findings as decided', () => {
    const findings = [
      makeFinding({ id: 'A-1', state: 'ruled' }),
      makeFinding({ id: 'A-2', state: 'denied' }),
      makeFinding({ id: 'A-3', state: 'open' }),
      makeFinding({ id: 'A-4', state: 'open', questions: [makeQuestion()] }),
    ];

    expect(decidedCount(findings)).toBe(2);
  });
});

describe('filtering an audit the size of a real one', () => {
  it('folds a finding’s text once however many times the queue is re-filtered', () => {
    const base = makeFinding({ id: 'A-1' });
    let reads = 0;
    const counted = {
      ...base,
      get searchText(): string {
        reads += 1;
        return base.searchText;
      },
    } as FindingJson;

    filterFindings([counted], { ...EMPTY_FILTERS, q: 's' });
    filterFindings([counted], { ...EMPTY_FILTERS, q: 'se' });
    filterFindings([counted], { ...EMPTY_FILTERS, q: 'set' });

    expect(reads).toBe(1);
  });

  it('reads nothing at all when the reader has typed no query', () => {
    const base = makeFinding({ id: 'A-2' });
    let reads = 0;
    const counted = {
      ...base,
      get searchText(): string {
        reads += 1;
        return base.searchText;
      },
    } as FindingJson;

    filterFindings([counted], EMPTY_FILTERS);

    expect(reads).toBe(0);
  });
});

describe('findingsInSection', () => {
  const findings = [
    makeFinding({ id: 'A-1', state: 'open' }),
    makeFinding({ id: 'A-2', state: 'ruled' }),
  ];

  it('narrows a queue section to the state it is a queue of', () => {
    expect(findingsInSection(findings, sectionSpec('open')).map((finding) => finding.id)).toEqual([
      'A-1',
    ]);
  });

  it('hands a whole-audit section everything', () => {
    expect(findingsInSection(findings, sectionSpec('dashboard'))).toHaveLength(2);
  });
});

describe('areaOptions', () => {
  it('tallies the areas a set of findings carries, largest first', () => {
    expect(
      areaOptions([
        makeFinding({ id: 'A-1', area: 'packages/db' }),
        makeFinding({ id: 'A-2', area: 'packages/db' }),
        makeFinding({ id: 'A-3', area: 'apps/api' }),
      ])
    ).toEqual([
      { value: 'packages/db', count: 2 },
      { value: 'apps/api', count: 1 },
    ]);
  });

  it('gathers the spellings of one code family into a single bucket', () => {
    expect(
      areaOptions([
        makeFinding({ id: 'A-1', area: 'apps/api/src/slices/models' }),
        makeFinding({ id: 'A-2', area: 'apps/api models slice' }),
        makeFinding({ id: 'A-3', area: 'apps/api (billing)' }),
        makeFinding({ id: 'A-4', area: 'apps/api, workflows engine' }),
      ])
    ).toEqual([{ value: 'apps/api', count: 4 }]);
  });

  it('keeps two packages of one directory apart', () => {
    expect(
      areaOptions([
        makeFinding({ id: 'A-1', area: 'apps/web lib auth' }),
        makeFinding({ id: 'A-2', area: 'apps/api conversations slice' }),
      ])
    ).toEqual([
      { value: 'apps/api', count: 1 },
      { value: 'apps/web', count: 1 },
    ]);
  });

  it('carries an area that names no package under its own name', () => {
    expect(
      areaOptions([
        makeFinding({ id: 'A-1', area: 'unknown' }),
        makeFinding({ id: 'A-2', area: 'e2e' }),
        makeFinding({ id: 'A-3', area: 'dependencies, all workspaces' }),
      ])
    ).toEqual([
      { value: 'dependencies', count: 1 },
      { value: 'e2e', count: 1 },
      { value: 'unknown', count: 1 },
    ]);
  });

  it('gathers a file citation under the directory that holds it', () => {
    expect(
      areaOptions([
        makeFinding({ id: 'A-1', area: '.github/workflows/ci.yml' }),
        makeFinding({ id: 'A-2', area: '.github/workflows/deploy.yml' }),
      ])
    ).toEqual([{ value: '.github/workflows', count: 2 }]);
  });

  it('gathers a file the top directory holds under that directory', () => {
    expect(
      areaOptions([
        makeFinding({ id: 'A-1', area: 'scripts' }),
        makeFinding({ id: 'A-2', area: 'scripts/dev-clean.ts' }),
        makeFinding({ id: 'A-3', area: '`scripts/generate-env.ts` and the env registry' }),
      ])
    ).toEqual([{ value: 'scripts', count: 3 }]);
  });

  it('carries a file no directory holds under its own name', () => {
    expect(areaOptions([makeFinding({ id: 'A-1', area: 'docker-compose.yml' })])).toEqual([
      { value: 'docker-compose.yml', count: 1 },
    ]);
  });
});

describe('areaFilterOptions', () => {
  const findings = [
    makeFinding({ id: 'A-1', area: 'packages/db', state: 'open', severity: 'critical' }),
    makeFinding({ id: 'A-2', area: 'packages/db', state: 'ruled', severity: 'low' }),
    makeFinding({ id: 'A-3', area: 'apps/api', state: 'open', severity: 'low' }),
    makeFinding({ id: 'A-4', area: 'unknown', state: 'denied', severity: 'low' }),
  ];

  it('counts each area over the section on screen, not the whole audit', () => {
    expect(areaFilterOptions(findings, EMPTY_FILTERS, sectionSpec('open'))).toEqual([
      { value: 'apps/api', count: 1 },
      { value: 'packages/db', count: 1 },
    ]);
  });

  it('counts a family over every spelling the corpus gives it', () => {
    expect(
      areaFilterOptions(
        [
          makeFinding({ id: 'B-1', area: 'apps/web (billing)', state: 'open' }),
          makeFinding({ id: 'B-2', area: 'apps/web lib auth', state: 'open' }),
        ],
        EMPTY_FILTERS,
        sectionSpec('open')
      )
    ).toEqual([{ value: 'apps/web', count: 2 }]);
  });

  it('reads the whole audit for a section that does', () => {
    expect(areaFilterOptions(findings, EMPTY_FILTERS, sectionSpec('dashboard'))).toContainEqual({
      value: 'packages/db',
      count: 2,
    });
  });

  it('honours every other filter, because the pane it predicts does', () => {
    expect(
      areaFilterOptions(findings, { ...EMPTY_FILTERS, severity: ['critical'] }, sectionSpec('open'))
    ).toEqual([{ value: 'packages/db', count: 1 }]);
  });

  it('ignores the area already chosen, so the options stay comparable with each other', () => {
    expect(
      areaFilterOptions(findings, { ...EMPTY_FILTERS, area: 'apps/api' }, sectionSpec('open'))
    ).toContainEqual({ value: 'packages/db', count: 1 });
  });

  it('leaves out an area this section has none of, because choosing it could only empty the pane', () => {
    expect(areaFilterOptions(findings, EMPTY_FILTERS, sectionSpec('open'))).not.toContainEqual({
      value: 'unknown',
      count: 0,
    });
  });

  it('offers an area nothing carries when that is the one being filtered on', () => {
    expect(
      areaFilterOptions(
        findings,
        { ...EMPTY_FILTERS, area: 'packages/nowhere' },
        sectionSpec('open')
      )
    ).toContainEqual({ value: 'packages/nowhere', count: 0 });
  });

  it('promises exactly the findings the pane will show, in every section', () => {
    for (const id of SECTION_IDS) {
      const section = sectionSpec(id);
      for (const option of areaFilterOptions(findings, EMPTY_FILTERS, section)) {
        const shown = findingsInSection(
          filterFindings(findings, { ...EMPTY_FILTERS, area: option.value }),
          section
        );

        expect({ area: option.value, section: id, shown: shown.length }).toEqual({
          area: option.value,
          section: id,
          shown: option.count,
        });
      }
    }
  });
});

describe('isFiltering', () => {
  it('is false for the empty filter set', () => {
    expect(isFiltering(EMPTY_FILTERS)).toBe(false);
  });

  it('is true once any dimension is set', () => {
    expect(isFiltering({ ...EMPTY_FILTERS, q: 'wallet' })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, severity: ['low'] })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, status: ['live'] })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, kind: ['defect'] })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, area: 'apps/api' })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, warning: true })).toBe(true);
    expect(isFiltering({ ...EMPTY_FILTERS, grouped: true })).toBe(true);
  });
});
