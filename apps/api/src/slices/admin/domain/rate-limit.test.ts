import { describe, expect, it } from 'vitest';
import {
  adminAuditSearchRateLimit,
  adminCustomer360RateLimit,
  adminFeedbackRateLimit,
  adminOpsRateLimit,
  adminSqlPanelRateLimit,
} from './rate-limit.js';

const ENTRIES = [
  adminCustomer360RateLimit,
  adminAuditSearchRateLimit,
  adminFeedbackRateLimit,
  adminSqlPanelRateLimit,
];

describe('admin read-volume rate-limit entries', () => {
  it('build distinct admin-prefixed keys per actor hash', () => {
    const keys = ENTRIES.map((entry) => entry.buildKey('abc123'));
    expect(new Set(keys).size).toBe(ENTRIES.length);
    for (const key of keys) {
      expect(key).toMatch(/^ratelimit:admin:read:[a-z0-9-]+:abc123$/);
    }
  });

  it('are throttles with a positive cap over an hour-long window', () => {
    for (const entry of ENTRIES) {
      expect(entry.kind).toBe('throttle');
      expect(entry.maxAttempts).toBeGreaterThan(0);
      expect(entry.windowSeconds).toBe(3600);
    }
  });
});

describe('the admin operations rate-limit entry', () => {
  it('builds its own ops-namespaced key per actor hash', () => {
    expect(adminOpsRateLimit.buildKey('abc123')).toBe('ratelimit:admin:ops:abc123');
  });

  it('collides with no read entry on the same actor hash', () => {
    const ops = adminOpsRateLimit.buildKey('abc123');
    for (const entry of ENTRIES) expect(entry.buildKey('abc123')).not.toBe(ops);
  });

  it('is an hourly throttle at the whole-customer-state read cap', () => {
    expect(adminOpsRateLimit.kind).toBe('throttle');
    expect(adminOpsRateLimit.maxAttempts).toBe(adminCustomer360RateLimit.maxAttempts);
    expect(adminOpsRateLimit.windowSeconds).toBe(3600);
  });
});
