import { describe, it, expect } from 'vitest';
import { HOUR_MS, MINUTE_MS } from '@hushbox/shared/test-time';
import {
  RECLAIM_BOUNDARY_PHRASE,
  UNOWNED_RECLAIM_AFTER_MS,
  pastReclaimBoundary,
  type ResourceAge,
} from './resource-age.js';

describe('the boundary an unowned resource is left standing for', () => {
  it('is far enough past the longest operation here that no live work reaches it', () => {
    const longestMeasuredOperation = 12.5 * MINUTE_MS;

    expect(UNOWNED_RECLAIM_AFTER_MS / longestMeasuredOperation).toBeGreaterThan(200);
  });

  it('names itself in the words a line prints', () => {
    expect(RECLAIM_BOUNDARY_PHRASE).toBe('48 hours');
  });

  it('is past for a resource that has stood longer than it', () => {
    expect(
      pastReclaimBoundary({ kind: 'known', elapsedMs: UNOWNED_RECLAIM_AFTER_MS + HOUR_MS })
    ).toBe(true);
  });

  it('is not past for a resource that has stood exactly as long as it', () => {
    expect(pastReclaimBoundary({ kind: 'known', elapsedMs: UNOWNED_RECLAIM_AFTER_MS })).toBe(false);
  });

  it('is not past for a resource younger than it', () => {
    expect(pastReclaimBoundary({ kind: 'known', elapsedMs: HOUR_MS })).toBe(false);
  });

  it('is not past for a resource whose age could not be read', () => {
    expect(pastReclaimBoundary({ kind: 'unreadable', reason: 'no record of it' })).toBe(false);
  });

  it('is not past for a resource nothing asked the age of', () => {
    const nothingAsked: ResourceAge | undefined = undefined;

    expect(pastReclaimBoundary(nothingAsked)).toBe(false);
  });
});
