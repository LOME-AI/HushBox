import { describe, it, expect } from 'vitest';
import { makeFinding } from '@/test-utils/finding-fixture';
import { deniedGroups } from './denied-groups';
import type { Denial, FindingJson } from '@hushbox/docket';

function denied(
  id: string,
  by: Denial['by'],
  at: string,
  reason: string | null = null
): FindingJson {
  return makeFinding({ id, state: 'denied', denial: { by, reason, at } });
}

describe('deniedGroups', () => {
  it('keeps the reader’s own denials apart from the audit’s refutations', () => {
    const groups = deniedGroups([
      denied('A-1', 'audit', '2026-07-30'),
      denied('A-2', 'human', '2026-07-31'),
    ]);

    expect(groups.map((group) => group.by)).toEqual(['human', 'audit']);
    expect(groups.map((group) => group.findings.map((finding) => finding.id))).toEqual([
      ['A-2'],
      ['A-1'],
    ]);
  });

  it('leaves out a group nothing landed in', () => {
    const groups = deniedGroups([denied('A-1', 'audit', '2026-07-30')]);

    expect(groups.map((group) => group.by)).toEqual(['audit']);
  });

  it('reads each group from its most recent denial backwards', () => {
    const groups = deniedGroups([
      denied('A-1', 'human', '2026-07-30'),
      denied('A-2', 'human', '2026-07-31'),
    ]);

    expect(groups[0]?.findings.map((finding) => finding.id)).toEqual(['A-2', 'A-1']);
  });

  it('titles each group by who refused the finding', () => {
    const groups = deniedGroups([
      denied('A-1', 'audit', '2026-07-30'),
      denied('A-2', 'human', '2026-07-31'),
    ]);

    expect(groups.map((group) => group.label)).toEqual(['Denied by you', 'Refuted by the audit']);
  });

  it('is empty when nothing is denied', () => {
    expect(deniedGroups([])).toEqual([]);
  });

  it('leaves out a finding carrying no denial rather than inventing an author', () => {
    expect(deniedGroups([makeFinding({ id: 'A-1', state: 'denied' })])).toEqual([]);
  });
});
