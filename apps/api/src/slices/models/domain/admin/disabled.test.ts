import { describe, expect, it } from 'vitest';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { firstAdminDisabledModel } from './disabled.js';
import type { StoredDescriptorRow } from '../catalog/store.js';

function row(adminDisabledAt: Date | null): StoredDescriptorRow {
  return {
    catalogId: crypto.randomUUID(),
    descriptor: {},
    adminDisabledAt,
    excludedReason: null,
    popularityRank: null,
    lastSeenAt: new Date(TEST_DAY_START),
  };
}

const DISABLED = new Date(TEST_DAY_START);

describe('firstAdminDisabledModel', () => {
  it('returns undefined when no selected model is disabled', () => {
    const rows = new Map([
      ['a/one', row(null)],
      ['a/two', row(null)],
    ]);
    expect(firstAdminDisabledModel(rows, ['a/one', 'a/two'])).toBeUndefined();
  });

  it('returns the first disabled model in selection order', () => {
    const rows = new Map([
      ['a/one', row(null)],
      ['a/two', row(DISABLED)],
      ['a/three', row(DISABLED)],
    ]);
    expect(firstAdminDisabledModel(rows, ['a/one', 'a/two', 'a/three'])).toBe('a/two');
  });

  it('ignores model ids absent from the catalog', () => {
    const rows = new Map([['a/one', row(null)]]);
    expect(firstAdminDisabledModel(rows, ['a/unknown', 'a/one'])).toBeUndefined();
  });

  it('returns undefined for an empty selection', () => {
    const rows = new Map([['a/one', row(DISABLED)]]);
    expect(firstAdminDisabledModel(rows, [])).toBeUndefined();
  });
});
