import { describe, it, expect } from 'vitest';
import { makeFinding } from '@/test-utils/finding-fixture';
import { actionedAt, orderByMostRecentAction } from './decided-order';
import type { Denial, Ruling } from '@hushbox/docket';

function ruling(at: string): Ruling {
  return { option: 'A', text: null, note: null, at };
}

function denial(at: string, by: Denial['by'] = 'human'): Denial {
  return { by, reason: null, at };
}

describe('actionedAt', () => {
  it('reads the moment a finding was ruled', () => {
    const finding = makeFinding({
      id: 'A-1',
      state: 'ruled',
      ruling: ruling('2026-07-30'),
    });

    expect(actionedAt(finding)).toBe('2026-07-30');
  });

  it('reads the moment a finding was denied', () => {
    const finding = makeFinding({
      id: 'A-1',
      state: 'denied',
      denial: denial('2026-07-30'),
    });

    expect(actionedAt(finding)).toBe('2026-07-30');
  });

  it('is empty for a finding carrying neither', () => {
    expect(actionedAt(makeFinding({ id: 'A-1' }))).toBe('');
  });
});

describe('orderByMostRecentAction', () => {
  it('puts the most recently actioned finding first', () => {
    const older = makeFinding({ id: 'A-1', ruling: ruling('2026-07-30') });
    const newer = makeFinding({ id: 'A-2', ruling: ruling('2026-07-31') });

    expect(orderByMostRecentAction([older, newer]).map((entry) => entry.id)).toEqual([
      'A-2',
      'A-1',
    ]);
  });

  it('compares a ruling against a denial on the same clock', () => {
    const ruled = makeFinding({ id: 'A-1', ruling: ruling('2026-07-30') });
    const denied = makeFinding({ id: 'A-2', denial: denial('2026-07-29') });

    expect(orderByMostRecentAction([denied, ruled]).map((entry) => entry.id)).toEqual([
      'A-1',
      'A-2',
    ]);
  });

  it('holds two findings actioned at the same moment in the order they arrived', () => {
    const first = makeFinding({ id: 'A-1', ruling: ruling('2026-07-30') });
    const second = makeFinding({ id: 'A-2', ruling: ruling('2026-07-30') });

    expect(orderByMostRecentAction([first, second]).map((entry) => entry.id)).toEqual([
      'A-1',
      'A-2',
    ]);
  });

  it('sends a finding with no recorded moment to the end', () => {
    const dated = makeFinding({ id: 'A-1', denial: denial('2026-07-30') });
    const undated = makeFinding({ id: 'A-2' });

    expect(orderByMostRecentAction([undated, dated]).map((entry) => entry.id)).toEqual([
      'A-1',
      'A-2',
    ]);
  });

  it('leaves the list it was handed alone', () => {
    const older = makeFinding({ id: 'A-1', ruling: ruling('2026-07-30') });
    const newer = makeFinding({ id: 'A-2', ruling: ruling('2026-07-31') });
    const input = [older, newer];

    orderByMostRecentAction(input);

    expect(input.map((entry) => entry.id)).toEqual(['A-1', 'A-2']);
  });
});
