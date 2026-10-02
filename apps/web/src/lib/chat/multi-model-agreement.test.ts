import { describe, it, expect } from 'vitest';
import { agreedAxis, agreedOptions, snapToNearest } from './multi-model-agreement';

interface TestModel {
  id: string;
  durations?: readonly number[];
  resolutions?: readonly string[];
}

describe('agreedAxis', () => {
  it('reports unconstrained when no models are selected', () => {
    const result = agreedAxis([], [], (m: TestModel) => m.durations);
    expect(result).toEqual({ kind: 'unconstrained' });
  });

  it('reports unconstrained while the catalog is still absent', () => {
    const result = agreedAxis([{ id: 'a' }], undefined, (m: TestModel) => m.durations);
    expect(result).toEqual({ kind: 'unconstrained' });
  });

  it('agrees on the lone model option set when one model is selected', () => {
    const catalog: TestModel[] = [{ id: 'a', durations: [4, 6, 8] }];
    const result = agreedAxis([{ id: 'a' }], catalog, (m) => m.durations);
    expect(result).toEqual({ kind: 'agreed', options: [4, 6, 8] });
  });

  it('agrees on the intersection across multiple selected models', () => {
    const catalog: TestModel[] = [
      { id: 'a', durations: [4, 6, 8] },
      { id: 'b', durations: [5, 6, 7, 8] },
    ];
    const result = agreedAxis([{ id: 'a' }, { id: 'b' }], catalog, (m) => m.durations);
    expect(result).toEqual({ kind: 'agreed', options: [6, 8] });
  });

  it('reports a conflict when the declared domains share nothing', () => {
    const catalog: TestModel[] = [
      { id: 'a', durations: [4, 6, 8] },
      { id: 'b', durations: [5, 10] },
    ];
    const result = agreedAxis([{ id: 'a' }, { id: 'b' }], catalog, (m) => m.durations);
    expect(result).toEqual({ kind: 'conflict' });
  });

  it('preserves the first model order in the intersection', () => {
    const catalog: TestModel[] = [
      { id: 'a', resolutions: ['720p', '1080p', '4k'] },
      { id: 'b', resolutions: ['4k', '1080p', '720p'] },
    ];
    const result = agreedAxis([{ id: 'a' }, { id: 'b' }], catalog, (m) => m.resolutions);
    expect(result).toEqual({ kind: 'agreed', options: ['720p', '1080p', '4k'] });
  });

  it('skips a model that declares nothing, intersecting the rest', () => {
    const catalog: TestModel[] = [
      { id: 'a', durations: [4, 6, 8] },
      { id: 'b' },
      { id: 'c', durations: [6, 8, 10] },
    ];
    const result = agreedAxis([{ id: 'a' }, { id: 'b' }, { id: 'c' }], catalog, (m) => m.durations);
    expect(result).toEqual({ kind: 'agreed', options: [6, 8] });
  });

  it('reports unconstrained when every selected model declares no domain', () => {
    const catalog: TestModel[] = [{ id: 'a' }, { id: 'b' }];
    const result = agreedAxis([{ id: 'a' }, { id: 'b' }], catalog, (m) => m.durations);
    expect(result).toEqual({ kind: 'unconstrained' });
  });

  it('reports unconstrained when a selected model is absent from the catalog', () => {
    const result = agreedAxis(
      [{ id: 'missing' }],
      [{ id: 'a', durations: [4] }],
      (m: TestModel) => m.durations
    );
    expect(result).toEqual({ kind: 'unconstrained' });
  });

  it('treats an empty declared domain as no domain rather than as a conflict', () => {
    const catalog: TestModel[] = [
      { id: 'a', durations: [] },
      { id: 'b', durations: [4, 6] },
    ];
    const result = agreedAxis([{ id: 'a' }, { id: 'b' }], catalog, (m) => m.durations);
    expect(result).toEqual({ kind: 'agreed', options: [4, 6] });
  });
});

describe('agreedOptions', () => {
  it('yields the agreed options', () => {
    expect(agreedOptions({ kind: 'agreed', options: [4, 6] })).toEqual([4, 6]);
  });

  it('yields nothing for an unconstrained axis', () => {
    expect(agreedOptions({ kind: 'unconstrained' })).toEqual([]);
  });

  it('yields nothing for a conflicting axis', () => {
    expect(agreedOptions({ kind: 'conflict' })).toEqual([]);
  });
});

describe('snapToNearest', () => {
  it('returns the value when it matches an allowed entry exactly', () => {
    expect(snapToNearest([4, 6, 8], 6)).toBe(6);
  });

  it('snaps to the nearest entry when between two values', () => {
    // 5.6 → distance to 4 is 1.6, distance to 6 is 0.4 → nearer to 6.
    expect(snapToNearest([4, 6, 8], 5.6)).toBe(6);
    // 7.1 → distance to 6 is 1.1, distance to 8 is 0.9 → nearer to 8.
    expect(snapToNearest([4, 6, 8], 7.1)).toBe(8);
  });

  it('snaps closer to the lower value when distances differ', () => {
    expect(snapToNearest([4, 6, 8], 4.3)).toBe(4);
  });

  it('snaps to the lower value on exact ties (floor)', () => {
    // Halfway between 4 and 6 → floor.
    expect(snapToNearest([4, 6, 8], 5)).toBe(4);
    // Halfway between 6 and 8 → floor.
    expect(snapToNearest([4, 6, 8], 7)).toBe(6);
  });

  it('clamps below the minimum to the minimum', () => {
    expect(snapToNearest([4, 6, 8], 2)).toBe(4);
  });

  it('clamps above the maximum to the maximum', () => {
    expect(snapToNearest([4, 6, 8], 100)).toBe(8);
  });

  it('returns undefined when the allowed list is empty', () => {
    expect(snapToNearest([], 5)).toBeUndefined();
  });

  it('returns the only entry when the list has one element', () => {
    expect(snapToNearest([8], 3)).toBe(8);
    expect(snapToNearest([8], 12)).toBe(8);
  });
});
