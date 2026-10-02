import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, MINUTE_MS, TEST_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import {
  conversationDateGroup,
  groupConversationsByDate,
  mostRecentConversations,
  type DateGroup,
} from './conversation-groups';

const GROUP_ORDER: readonly DateGroup[] = ['Today', 'Previous 7 days', 'Previous 30 days', 'Older'];

const REFERENCE_DAY = new Date(TEST_DAY_START);

/**
 * An instant on the local calendar, `dayOffset` days from the reference day. Read at call
 * time, so it follows a timezone a test stubs.
 */
function localInstant(dayOffset: number, hours = 0, minutes = 0): number {
  return new Date(
    REFERENCE_DAY.getUTCFullYear(),
    REFERENCE_DAY.getUTCMonth(),
    REFERENCE_DAY.getUTCDate() + dayOffset,
    hours,
    minutes
  ).getTime();
}

function frozenNow(instantMs: number): Date {
  freezeClock(instantMs);
  return new Date();
}

function utcDay(instantMs: number): string {
  return isoAt(instantMs).slice(0, 10);
}

interface Row {
  id: string;
  updatedAt: string;
  accepted?: boolean;
}

function row(id: string, instantMs: number, accepted?: boolean): Row {
  return accepted === undefined
    ? { id, updatedAt: isoAt(instantMs) }
    : { id, updatedAt: isoAt(instantMs), accepted };
}

function expectEachPlacedOnceInItsGroup(list: readonly Row[], now: Date): void {
  const placed = groupConversationsByDate(list, now).flatMap(({ group, items }) =>
    items.map((item) => ({ group, item }))
  );

  expect(placed).toHaveLength(list.length);
  expect(new Set(placed.map(({ item }) => item))).toEqual(new Set(list));
  for (const { group, item } of placed) {
    expect(group).toBe(conversationDateGroup(item.updatedAt, now));
  }
}

function expectGroupOrderAndListOrderKept(list: readonly Row[], now: Date): void {
  const groups = groupConversationsByDate(list, now);
  const groupRanks = groups.map(({ group }) => GROUP_ORDER.indexOf(group));

  expect(groupRanks).toEqual(groupRanks.toSorted((a, b) => a - b));
  expect(new Set(groupRanks).size).toBe(groupRanks.length);
  for (const { items } of groups) {
    expect(items.length).toBeGreaterThan(0);
    const listIndexes = items.map((item) => list.indexOf(item));
    expect(listIndexes).toEqual(listIndexes.toSorted((a, b) => a - b));
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('conversationDateGroup', () => {
  it('puts a conversation updated at local midnight today in Today', () => {
    const now = frozenNow(localInstant(0, 12));

    expect(conversationDateGroup(isoAt(localInstant(0)), now)).toBe('Today');
  });

  it('puts a conversation updated just before local midnight in Previous 7 days', () => {
    const now = frozenNow(localInstant(0, 12));

    expect(conversationDateGroup(isoAt(localInstant(0) - 1), now)).toBe('Previous 7 days');
  });

  it('puts yesterday in Previous 7 days when the clock reads exactly local midnight', () => {
    const now = frozenNow(localInstant(0));

    expect(conversationDateGroup(isoAt(localInstant(-1, 23, 59)), now)).toBe('Previous 7 days');
  });

  it('puts the start of the 7th day in Previous 7 days', () => {
    const now = frozenNow(localInstant(0, 12));

    expect(conversationDateGroup(isoAt(localInstant(-6)), now)).toBe('Previous 7 days');
  });

  it('puts the end of the 8th day in Previous 30 days', () => {
    const now = frozenNow(localInstant(0, 12));

    expect(conversationDateGroup(isoAt(localInstant(-7, 23, 59)), now)).toBe('Previous 30 days');
  });

  it('puts the start of the 30th day in Previous 30 days', () => {
    const now = frozenNow(localInstant(0, 12));

    expect(conversationDateGroup(isoAt(localInstant(-29)), now)).toBe('Previous 30 days');
  });

  it('puts the end of the 31st day in Older', () => {
    const now = frozenNow(localInstant(0, 12));

    expect(conversationDateGroup(isoAt(localInstant(-30, 23, 59)), now)).toBe('Older');
  });

  it('puts an update stamped after the local clock in Today', () => {
    const now = frozenNow(localInstant(0, 12));

    expect(conversationDateGroup(isoAt(localInstant(1, 12)), now)).toBe('Today');
  });

  describe('in a timezone ahead of UTC', () => {
    it('puts the local previous day in Previous 7 days though it shares the UTC day', () => {
      vi.stubEnv('TZ', 'Pacific/Auckland');
      const nowMs = localInstant(0, 0, 30);
      const updatedMs = localInstant(-1, 23, 30);
      const now = frozenNow(nowMs);

      expect(new Date(nowMs).getTimezoneOffset()).not.toBe(0);
      expect(utcDay(updatedMs)).toBe(utcDay(nowMs));
      expect(conversationDateGroup(isoAt(updatedMs), now)).toBe('Previous 7 days');
    });
  });

  describe('in a timezone behind UTC', () => {
    it('puts the local same day in Today though the UTC day differs', () => {
      vi.stubEnv('TZ', 'America/Los_Angeles');
      const nowMs = localInstant(0, 23, 30);
      const updatedMs = localInstant(0, 0, 30);
      const now = frozenNow(nowMs);

      expect(new Date(nowMs).getTimezoneOffset()).not.toBe(0);
      expect(utcDay(updatedMs)).not.toBe(utcDay(nowMs));
      expect(conversationDateGroup(isoAt(updatedMs), now)).toBe('Today');
    });
  });

  describe('across a daylight-saving change', () => {
    // In New York the reference day plus 58 days is the sixth day after the spring change,
    // so the 7th day back is the 23-hour change day itself.
    const SIX_DAYS_AFTER_SPRING_CHANGE = 58;

    it('keeps the first instant of the 7th day in Previous 7 days', () => {
      vi.stubEnv('TZ', 'America/New_York');
      const nowMs = localInstant(SIX_DAYS_AFTER_SPRING_CHANGE, 0, 30);
      const updatedMs = localInstant(SIX_DAYS_AFTER_SPRING_CHANGE - 6);
      const now = frozenNow(nowMs);

      expect(new Date(nowMs).getTimezoneOffset()).not.toBe(new Date(updatedMs).getTimezoneOffset());
      expect(conversationDateGroup(isoAt(updatedMs), now)).toBe('Previous 7 days');
    });

    it('keeps the last hour of the 8th day in Previous 30 days', () => {
      vi.stubEnv('TZ', 'America/New_York');
      const nowMs = localInstant(SIX_DAYS_AFTER_SPRING_CHANGE, 0, 30);
      const updatedMs = localInstant(SIX_DAYS_AFTER_SPRING_CHANGE - 7, 23, 30);
      const now = frozenNow(nowMs);

      expect(new Date(nowMs).getTimezoneOffset()).not.toBe(new Date(updatedMs).getTimezoneOffset());
      expect(conversationDateGroup(isoAt(updatedMs), now)).toBe('Previous 30 days');
    });
  });
});

describe('groupConversationsByDate', () => {
  it('orders the groups from Today to Older whatever the list order', () => {
    const now = frozenNow(localInstant(0, 12));
    const older = row('older', localInstant(-40));
    const month = row('month', localInstant(-10));
    const week = row('week', localInstant(-2));
    const today = row('today', localInstant(0, 9));

    expect(groupConversationsByDate([older, month, week, today], now)).toEqual([
      { group: 'Today', items: [today] },
      { group: 'Previous 7 days', items: [week] },
      { group: 'Previous 30 days', items: [month] },
      { group: 'Older', items: [older] },
    ]);
  });

  it('keeps the list order inside a group', () => {
    const now = frozenNow(localInstant(0, 12));
    const pinnedEarlier = row('pinned-earlier', localInstant(0, 8));
    const later = row('later', localInstant(0, 11));

    expect(groupConversationsByDate([pinnedEarlier, later], now)).toEqual([
      { group: 'Today', items: [pinnedEarlier, later] },
    ]);
  });

  it('omits a group no conversation falls in', () => {
    const now = frozenNow(localInstant(0, 12));
    const today = row('today', localInstant(0, 9));
    const older = row('older', localInstant(-40));

    expect(groupConversationsByDate([today, older], now)).toEqual([
      { group: 'Today', items: [today] },
      { group: 'Older', items: [older] },
    ]);
  });

  it('returns no groups for an empty list', () => {
    const now = frozenNow(localInstant(0, 12));

    expect(groupConversationsByDate([], now)).toEqual([]);
  });

  describe('properties', () => {
    const NOW_MS = localInstant(0, 12);

    /** A list of rows whose updates fall anywhere from 90 days back to a day past the clock. */
    const conversationListArbitrary: fc.Arbitrary<Row[]> = fc
      .array(fc.integer({ min: -90 * DAY_MS, max: DAY_MS }), { maxLength: 40 })
      .map((offsets) =>
        offsets.map((offset, index) => ({
          id: String(index),
          updatedAt: isoAt(NOW_MS + Math.trunc(offset / MINUTE_MS) * MINUTE_MS),
        }))
      );

    it('puts every conversation in exactly one group, the one its date names', () => {
      const now = frozenNow(NOW_MS);

      fc.assert(
        fc.property(conversationListArbitrary, (list) => {
          expectEachPlacedOnceInItsGroup(list, now);
        })
      );
    });

    it('keeps the group order and the list order inside each group', () => {
      const now = frozenNow(NOW_MS);

      fc.assert(
        fc.property(conversationListArbitrary, (list) => {
          expectGroupOrderAndListOrderKept(list, now);
        })
      );
    });
  });
});

describe('mostRecentConversations', () => {
  it('orders by update time, newest first, ignoring pin order', () => {
    const pinnedOld = row('pinned-old', localInstant(-20));
    const newest = row('newest', localInstant(0, 9));
    const middle = row('middle', localInstant(-3));

    expect(mostRecentConversations([pinnedOld, newest, middle], 3)).toEqual([
      newest,
      middle,
      pinnedOld,
    ]);
  });

  it('leaves out an invite not yet accepted', () => {
    const invite = row('invite', localInstant(0, 10), false);
    const accepted = row('accepted', localInstant(-1), true);
    const own = row('own', localInstant(-2));

    expect(mostRecentConversations([invite, accepted, own], 3)).toEqual([accepted, own]);
  });

  it('returns at most n conversations', () => {
    const newest = row('newest', localInstant(0, 9));
    const middle = row('middle', localInstant(-3));
    const oldest = row('oldest', localInstant(-20));

    expect(mostRecentConversations([oldest, middle, newest], 2)).toEqual([newest, middle]);
  });
});
