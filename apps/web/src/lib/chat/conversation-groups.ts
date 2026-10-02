export type DateGroup = 'Today' | 'Previous 7 days' | 'Previous 30 days' | 'Older';

const DATE_GROUP_ORDER: readonly DateGroup[] = [
  'Today',
  'Previous 7 days',
  'Previous 30 days',
  'Older',
];

/** Built from calendar fields, so a daylight-saving day of 23 or 25 hours still counts once. */
function localDayStart(now: Date, daysBefore: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBefore).getTime();
}

/** The viewer's local calendar decides the group; an update stamped after `now` reads as Today. */
export function conversationDateGroup(updatedAt: string, now: Date): DateGroup {
  const updated = Date.parse(updatedAt);
  if (updated >= localDayStart(now, 0)) return 'Today';
  if (updated >= localDayStart(now, 6)) return 'Previous 7 days';
  if (updated >= localDayStart(now, 29)) return 'Previous 30 days';
  return 'Older';
}

export function groupConversationsByDate<T extends { updatedAt: string }>(
  list: readonly T[],
  now: Date
): readonly { group: DateGroup; items: readonly T[] }[] {
  return DATE_GROUP_ORDER.map((group) => ({
    group,
    items: list.filter((item) => conversationDateGroup(item.updatedAt, now) === group),
  })).filter(({ items }) => items.length > 0);
}

/** Recency alone orders the result: pin order is ignored, and an unaccepted invite is left out. */
export function mostRecentConversations<T extends { updatedAt: string; accepted?: boolean }>(
  list: readonly T[],
  n: number
): readonly T[] {
  return list
    .filter((item) => item.accepted !== false)
    .toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, n);
}
