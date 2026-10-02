import { describe, it, expect } from 'vitest';
import { MAX_SELECTED_MODELS } from '../../constants.ts';
import { pinnedSourceIds, smartSlotSelected, turnSourceListSchema } from './turn-sources.ts';

const modelSource = (id: string): { kind: 'model'; id: string } => ({ kind: 'model', id });

describe('turnSourceListSchema', () => {
  it('accepts a single pinned model source', () => {
    expect(turnSourceListSchema.parse([modelSource('vendor/a')])).toEqual([
      { kind: 'model', id: 'vendor/a' },
    ]);
  });

  it('accepts the smart slot on its own', () => {
    expect(turnSourceListSchema.parse([{ kind: 'smart' }])).toEqual([{ kind: 'smart' }]);
  });

  it('preserves the order the client sent', () => {
    expect(turnSourceListSchema.parse([{ kind: 'smart' }, modelSource('vendor/a')])).toEqual([
      { kind: 'smart' },
      { kind: 'model', id: 'vendor/a' },
    ]);
  });

  it('rejects an empty list', () => {
    expect(turnSourceListSchema.safeParse([]).success).toBe(false);
  });

  it('rejects more sources than the fan-out width bound', () => {
    const tooMany = Array.from({ length: MAX_SELECTED_MODELS + 1 }, (_entry, index) =>
      modelSource(`vendor/${String(index)}`)
    );
    expect(turnSourceListSchema.safeParse(tooMany).success).toBe(false);
  });

  it('counts the smart slot toward the cap, so a full pinned selection leaves no room for it', () => {
    const pinned = Array.from({ length: MAX_SELECTED_MODELS }, (_entry, index) =>
      modelSource(`vendor/${String(index)}`)
    );
    expect(turnSourceListSchema.safeParse([...pinned, { kind: 'smart' }]).success).toBe(false);
  });

  it('accepts the slot beside one fewer pinned model — the widest mixed selection', () => {
    const pinned = Array.from({ length: MAX_SELECTED_MODELS - 1 }, (_entry, index) =>
      modelSource(`vendor/${String(index)}`)
    );
    expect(turnSourceListSchema.safeParse([...pinned, { kind: 'smart' }]).success).toBe(true);
  });

  it('rejects a model source with an empty id', () => {
    expect(turnSourceListSchema.safeParse([modelSource('')]).success).toBe(false);
  });

  it('rejects a smart source carrying an id', () => {
    expect(turnSourceListSchema.safeParse([{ kind: 'smart', id: 'vendor/a' }]).success).toBe(false);
  });

  it('rejects an unknown source kind', () => {
    expect(turnSourceListSchema.safeParse([{ kind: 'pool' }]).success).toBe(false);
  });

  it('rejects a second smart slot', () => {
    expect(turnSourceListSchema.safeParse([{ kind: 'smart' }, { kind: 'smart' }]).success).toBe(
      false
    );
  });

  it('rejects the same pinned model twice', () => {
    expect(
      turnSourceListSchema.safeParse([modelSource('vendor/a'), modelSource('vendor/a')]).success
    ).toBe(false);
  });

  it('rejects a repeated pinned model separated by another model', () => {
    expect(
      turnSourceListSchema.safeParse([
        modelSource('vendor/a'),
        modelSource('vendor/b'),
        modelSource('vendor/a'),
      ]).success
    ).toBe(false);
  });

  it('rejects a repeated pinned model beside the smart slot', () => {
    expect(
      turnSourceListSchema.safeParse([
        modelSource('vendor/a'),
        { kind: 'smart' },
        modelSource('vendor/a'),
      ]).success
    ).toBe(false);
  });

  it('accepts distinct pinned models', () => {
    expect(
      turnSourceListSchema.safeParse([modelSource('vendor/a'), modelSource('vendor/b')]).success
    ).toBe(true);
  });

  it('rejects a second smart slot separated by a pinned model', () => {
    expect(
      turnSourceListSchema.safeParse([
        { kind: 'smart' },
        modelSource('vendor/a'),
        { kind: 'smart' },
      ]).success
    ).toBe(false);
  });
});

describe('pinnedSourceIds', () => {
  it('reads the pinned ids in wire order and drops the smart slot', () => {
    expect(
      pinnedSourceIds([modelSource('vendor/a'), { kind: 'smart' }, modelSource('vendor/b')])
    ).toEqual(['vendor/a', 'vendor/b']);
  });

  it('is empty for a smart-only turn', () => {
    expect(pinnedSourceIds([{ kind: 'smart' }])).toEqual([]);
  });
});

describe('smartSlotSelected', () => {
  it('is true wherever the slot appears, not only at the head', () => {
    expect(smartSlotSelected([modelSource('vendor/a'), { kind: 'smart' }])).toBe(true);
    expect(smartSlotSelected([{ kind: 'smart' }, modelSource('vendor/a')])).toBe(true);
  });

  it('is false for a wholly pinned turn', () => {
    expect(smartSlotSelected([modelSource('vendor/a'), modelSource('vendor/b')])).toBe(false);
  });
});
