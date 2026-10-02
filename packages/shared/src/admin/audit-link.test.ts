import { describe, expect, it } from 'vitest';

import { DAY_MS, TEST_DAY_END, TEST_DAY_START, isoAt, testUuidV7 } from '../testing/test-time.ts';
import {
  ADMIN_AUDIT_PATH,
  adminAuditDayFilter,
  adminAuditLink,
  utcDayBounds,
} from './audit-link.ts';

const ADMIN_URL = 'https://admin.hushbox.ai';
const TARGET_ID = testUuidV7(1);
const FROM = isoAt(TEST_DAY_START);
const TO = isoAt(TEST_DAY_END);

function searchOf(link: string): Record<string, string> {
  return Object.fromEntries(new URL(link).searchParams);
}

describe('adminAuditLink', () => {
  it('points at the audit page on the admin origin', () => {
    const url = new URL(adminAuditLink(ADMIN_URL, { targetId: TARGET_ID }));
    expect(`${url.origin}${url.pathname}`).toBe(`${ADMIN_URL}${ADMIN_AUDIT_PATH}`);
  });

  it('filters by the target id alone', () => {
    expect(searchOf(adminAuditLink(ADMIN_URL, { targetId: TARGET_ID }))).toEqual({
      targetId: TARGET_ID,
    });
  });

  it('filters by a time window alone', () => {
    expect(searchOf(adminAuditLink(ADMIN_URL, { from: FROM, to: TO }))).toEqual({
      from: FROM,
      to: TO,
    });
  });

  it('filters by an action over a time window', () => {
    expect(
      searchOf(adminAuditLink(ADMIN_URL, { action: 'jobs.redriveAll', from: FROM, to: TO }))
    ).toEqual({
      action: 'jobs.redriveAll',
      from: FROM,
      to: TO,
    });
  });

  it('keeps the admin origin when it carries a trailing slash', () => {
    expect(adminAuditLink(`${ADMIN_URL}/`, { targetId: TARGET_ID })).toBe(
      `${ADMIN_URL}${ADMIN_AUDIT_PATH}?targetId=${TARGET_ID}`
    );
  });

  it('encodes a value that carries query syntax', () => {
    expect(searchOf(adminAuditLink(ADMIN_URL, { targetId: 'a&b=c' }))).toEqual({
      targetId: 'a&b=c',
    });
  });
});

const DAY = isoAt(TEST_DAY_START).slice(0, 10);
const NEXT_DAY = isoAt(TEST_DAY_START + DAY_MS).slice(0, 10);

describe('utcDayBounds', () => {
  it('starts at the day’s UTC midnight', () => {
    expect(utcDayBounds(DAY).start.toISOString()).toBe(isoAt(TEST_DAY_START));
  });

  it('ends at the next UTC midnight', () => {
    expect(utcDayBounds(DAY).end.toISOString()).toBe(isoAt(TEST_DAY_START + DAY_MS));
  });
});

describe('adminAuditDayFilter', () => {
  it('runs from the day to the next day, as bare dates', () => {
    expect(adminAuditDayFilter(DAY)).toEqual({ from: DAY, to: NEXT_DAY });
  });

  it('links a day as bare from/to dates', () => {
    expect(adminAuditLink(ADMIN_URL, adminAuditDayFilter(DAY))).toBe(
      `${ADMIN_URL}${ADMIN_AUDIT_PATH}?from=${DAY}&to=${NEXT_DAY}`
    );
  });
});
