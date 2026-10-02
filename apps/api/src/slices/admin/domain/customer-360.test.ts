import { describe, expect, it } from 'vitest';
import { HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { auditToWire, jobToWire } from './customer-360.js';
import type { AdminAuditThreadedRow } from '../ports/index.js';

describe('jobToWire', () => {
  const base = {
    id: 'job-1',
    type: 'test.noop.v1',
    shard: 'bulk',
    status: 'dead',
    discarded: false,
    failures: 5,
    claims: 5,
    payload: { userId: 'u1' },
    errors: [{ at: isoAt(TEST_DAY_START), claim: 5, error: 'boom' }],
    nextAttemptAt: new Date(TEST_DAY_START + HOUR_MS),
    createdAt: new Date(TEST_DAY_START),
    finishedAt: null,
  };

  it('serializes dates to ISO strings and keeps a null finishedAt', () => {
    const wire = jobToWire(base);
    expect(wire.nextAttemptAt).toBe(isoAt(TEST_DAY_START + HOUR_MS));
    expect(wire.createdAt).toBe(isoAt(TEST_DAY_START));
    expect(wire.finishedAt).toBeNull();
  });

  it('serializes a finished timestamp when present', () => {
    const wire = jobToWire({ ...base, finishedAt: new Date(TEST_DAY_START + 2 * HOUR_MS) });
    expect(wire.finishedAt).toBe(isoAt(TEST_DAY_START + 2 * HOUR_MS));
  });
});

describe('auditToWire', () => {
  const threadedRow = (overrides: Partial<AdminAuditThreadedRow> = {}): AdminAuditThreadedRow => ({
    id: 'a1',
    actor: 'admin@hushbox.ai',
    role: 'operator',
    action: 'wallet.credit',
    targetType: 'wallet',
    targetId: 'w1',
    details: { input: {} },
    undoes: null,
    undoneBy: 'a2',
    createdAt: new Date(TEST_DAY_START + 3 * HOUR_MS),
    ...overrides,
  });

  it('serializes createdAt and preserves the threading fields', () => {
    const wire = auditToWire(threadedRow());
    expect(wire).toMatchObject({ createdAt: isoAt(TEST_DAY_START + 3 * HOUR_MS), undoneBy: 'a2' });
  });

  it('carries each row’s own acting role', () => {
    // Mapped one row at a time by every caller, so the guard against a
    // hardcoded role is two rows through the same producer, not one.
    const roles = [threadedRow(), threadedRow({ id: 'a3', role: 'growth-viewer' })].map(
      (row) => auditToWire(row).role
    );
    expect(roles).toEqual(['operator', 'growth-viewer']);
  });
});
