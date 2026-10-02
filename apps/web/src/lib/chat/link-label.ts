import { displayUsername } from '@hushbox/shared';

/** An unnamed link is named by its one-based position in the conversation's links list. */
export function linkLabel(link: Readonly<{ displayName: string | null }>, index: number): string {
  return link.displayName ?? `Guest Link #${String(index + 1)}`;
}

/**
 * Names each link seat in the roster by its link, keyed by the seat's member id: a budget
 * row carries no link id, so the roster's `linkId` is the only join from a seat to its link.
 * An account member, or a seat whose link is not in the list, is absent from the map.
 */
export function linkSeatNames(
  links: readonly Readonly<{ id: string; displayName: string | null }>[],
  roster: readonly Readonly<{ id: string; linkId?: string | null }>[]
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const seat of roster) {
    const index = links.findIndex((link) => link.id === seat.linkId);
    const link = links[index];
    if (link) names.set(seat.id, linkLabel(link, index));
  }
  return names;
}

/**
 * Names a budget row as the member pane and the Budgets dialog both name it: an account
 * member by username, a link seat by its link. A budget row carries no link id, so a link
 * seat whose link is not read yet is a guest link, and an account member with no username
 * anywhere is unknown. The roster's fields are required so that a roster read which stops
 * carrying them fails to compile, rather than naming every link seat a guest link.
 */
export function budgetRowName(
  row: Readonly<{ memberId: string; userId: string | null; username: string | null }>,
  roster: readonly Readonly<{ id: string; username: string | null; linkId: string | null }>[],
  links: readonly Readonly<{ id: string; displayName: string | null }>[]
): string {
  const username = roster.find((member) => member.id === row.memberId)?.username ?? row.username;
  if (username) return displayUsername(username);
  const seatName = linkSeatNames(links, roster).get(row.memberId);
  if (seatName !== undefined) return seatName;
  return row.userId === null ? 'Guest Link' : 'Unknown';
}
