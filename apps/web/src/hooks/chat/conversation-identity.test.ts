import { describe, expect, it } from 'vitest';
import { accountMembers, callerIdOf, groupSenderMembers } from './conversation-identity';
import type { SenderRow } from './conversation-identity';

function account(userId: string, username: string | null): SenderRow {
  return { userId, username, linkId: null };
}

const GUEST_ROW: SenderRow = { userId: null, username: null, linkId: 'link-1' };
const A_LINK = [{ id: 'link-1' }];

describe('accountMembers', () => {
  it('keeps the member rows seated by an account', () => {
    const members = [account('u-alice', 'Alice'), account('u-bob', 'Bob')];
    expect(accountMembers(members)).toEqual(members);
  });

  it("leaves out a link guest's member row", () => {
    expect(accountMembers([account('u-alice', 'Alice'), GUEST_ROW])).toEqual([
      account('u-alice', 'Alice'),
    ]);
  });

  it('keeps an account row that has no name to give', () => {
    expect(accountMembers([account('u-gone', null)])).toEqual([account('u-gone', null)]);
  });

  it('keeps member rows that carry no link field', () => {
    const rows = [{ id: 'm-1', userId: 'u-alice', username: 'Alice', privilege: 'owner' }];
    expect(accountMembers(rows)).toEqual(rows);
  });

  it('reads an empty link id as no link', () => {
    const row: SenderRow = { userId: 'u-alice', username: 'Alice', linkId: '' };
    expect(accountMembers([row])).toEqual([row]);
  });

  it('keeps the rows in the order given', () => {
    const members = [account('u-bob', 'Bob'), GUEST_ROW, account('u-alice', 'Alice')];
    expect(accountMembers(members)).toEqual([account('u-bob', 'Bob'), account('u-alice', 'Alice')]);
  });
});

describe('groupSenderMembers', () => {
  it('reads a conversation with one member and no links as no group', () => {
    expect(groupSenderMembers([account('u-alice', 'Alice')], [])).toBeUndefined();
  });

  it('reads two members as a group and names both', () => {
    const members = [account('u-alice', 'Alice'), account('u-bob', 'Bob')];
    expect(groupSenderMembers(members, [])).toEqual(members);
  });

  it('reads one member with a link as a group', () => {
    expect(groupSenderMembers([account('u-alice', 'Alice')], A_LINK)).toEqual([
      account('u-alice', 'Alice'),
    ]);
  });

  it("leaves a link guest's member row out of the count, so one member and that row are no group", () => {
    expect(groupSenderMembers([account('u-alice', 'Alice'), GUEST_ROW], [])).toBeUndefined();
  });

  it("leaves a link guest's member row out of the members who name senders", () => {
    expect(groupSenderMembers([account('u-alice', 'Alice'), GUEST_ROW], A_LINK)).toEqual([
      account('u-alice', 'Alice'),
    ]);
  });

  // The group is decided by member rows before the narrowing to members who can
  // name a sender, so a member row with no username still makes a group.
  it('reads two member rows as a group even when one has no name to give', () => {
    expect(groupSenderMembers([account('u-alice', 'Alice'), account('u-gone', null)], [])).toEqual([
      account('u-alice', 'Alice'),
    ]);
  });

  it('accepts member rows that carry no link field', () => {
    const rows = [
      { id: 'm-1', userId: 'u-alice', username: 'Alice', privilege: 'owner' },
      { id: 'm-2', userId: 'u-bob', username: 'Bob', privilege: 'write' },
    ];
    expect(groupSenderMembers(rows, [])).toEqual(rows);
  });
});

describe('callerIdOf', () => {
  it('names a signed-in caller by the session user', () => {
    expect(callerIdOf('u-alice', { linkId: 'link-1' })).toBe('u-alice');
  });

  it('names a link guest by the link it joined through', () => {
    expect(callerIdOf(undefined, { linkId: 'link-1' })).toBe('link-1');
  });

  it('names nobody when neither is known', () => {
    expect(callerIdOf(undefined, { linkId: null })).toBeUndefined();
  });

  it('names nobody before the conversation has been read', () => {
    expect(callerIdOf()).toBeUndefined();
  });
});
