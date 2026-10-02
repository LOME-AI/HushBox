import { describe, it, expect } from 'vitest';
import { PROGRESS_STATUSES } from '@hushbox/docket/types';
import { makeFinding } from '@/test-utils/finding-fixture';
import { COLUMN_ORDER, STATUS_LABELS, boardColumns } from './board-order';
import type { FindingJson, ProgressStatus } from '@hushbox/docket';

function tracked(id: string, status: ProgressStatus): FindingJson {
  return makeFinding({
    id,
    state: 'ruled',
    progress: { status, updated: null, verified: false, notes: [] },
  });
}

describe('COLUMN_ORDER', () => {
  it('reads blocked work first', () => {
    expect(COLUMN_ORDER[0]).toBe('blocked');
  });

  it('has a column for every progress status', () => {
    const byName = (left: string, right: string): number => left.localeCompare(right);

    expect([...COLUMN_ORDER].toSorted(byName)).toEqual([...PROGRESS_STATUSES].toSorted(byName));
  });

  it('names every column', () => {
    expect(COLUMN_ORDER.map((status) => STATUS_LABELS[status])).toEqual([
      'Blocked',
      'In progress',
      'Not started',
      'Done',
    ]);
  });
});

describe('boardColumns', () => {
  it('puts each finding under its own status', () => {
    const columns = boardColumns([tracked('A-1', 'done'), tracked('A-2', 'blocked')]);

    expect(columns.map((column) => column.findings.map((finding) => finding.id))).toEqual([
      ['A-2'],
      [],
      [],
      ['A-1'],
    ]);
  });

  it('keeps the reading order of the findings it is given', () => {
    const columns = boardColumns([tracked('A-2', 'not-started'), tracked('A-1', 'not-started')]);

    expect(columns[2]?.findings.map((finding) => finding.id)).toEqual(['A-2', 'A-1']);
  });

  it('returns every column even when the board is empty', () => {
    expect(boardColumns([])).toHaveLength(COLUMN_ORDER.length);
  });
});
