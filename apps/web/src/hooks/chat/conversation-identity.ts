/** A member row as the members read or the group-chat props carry it. */
export interface SenderRow {
  readonly userId: string | null;
  readonly username: string | null;
  /** Set on the member row a link guest is seated through; absent where such rows are already left out. */
  readonly linkId?: string | null;
}

type NamedSender<M extends SenderRow> = M & { readonly userId: string; readonly username: string };

/**
 * The member rows seated by an account, in the order given. A link guest's own
 * member row is left out: the guest is named through its link, not a member row.
 */
export function accountMembers<M extends SenderRow>(members: readonly M[]): M[] {
  return members.filter((m) => !m.linkId);
}

/**
 * The members who name senders in a group conversation, or `undefined` when
 * the conversation is not a group. A group has more than one account member
 * row or any link; a link guest's own member row counts toward neither, since
 * the guest is named through its link. The narrowing to rows with a user and a
 * username comes after that count: a sender resolves by user id, and a row with
 * neither can never match one.
 */
export function groupSenderMembers<M extends SenderRow>(
  members: readonly M[],
  links: readonly unknown[]
): NamedSender<M>[] | undefined {
  const accountRows = accountMembers(members);
  if (accountRows.length <= 1 && links.length === 0) return undefined;
  return accountRows.filter((m): m is NamedSender<M> => m.userId !== null && m.username !== null);
}

/**
 * Who the viewer is in a conversation. A signed-in caller is its session user;
 * a link guest has no account, so it is the link it joined through, which only
 * the conversation read names.
 */
export function callerIdOf(
  sessionUserId?: string,
  membership?: { readonly linkId: string | null }
): string | undefined {
  return sessionUserId ?? membership?.linkId ?? undefined;
}
