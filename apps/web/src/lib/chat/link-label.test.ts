import { describe, it, expect, expectTypeOf } from 'vitest';
import { budgetRowName, linkLabel, linkSeatNames } from '@/lib/chat/link-label';

describe('linkLabel', () => {
  it('names a named link by its name', () => {
    expect(linkLabel({ displayName: 'Dave' }, 0)).toBe('Dave');
  });

  it('names an unnamed link by its position in the links list', () => {
    expect(linkLabel({ displayName: null }, 1)).toBe('Guest Link #2');
  });
});

describe('linkSeatNames', () => {
  const links = [
    { id: 'link-a', displayName: 'Luísa' },
    { id: 'link-b', displayName: null },
  ];

  it('names a seat by its named link', () => {
    const roster = [{ id: 'seat-a', linkId: 'link-a' }];

    expect(linkSeatNames(links, roster).get('seat-a')).toBe('Luísa');
  });

  it('names a seat by its unnamed link position in the links list', () => {
    const roster = [{ id: 'seat-b', linkId: 'link-b' }];

    expect(linkSeatNames(links, roster).get('seat-b')).toBe('Guest Link #2');
  });

  it('leaves out an account member, which holds no link', () => {
    const roster = [{ id: 'member-1', linkId: null }];

    expect(linkSeatNames(links, roster).has('member-1')).toBe(false);
  });

  it('leaves out a seat whose link is not in the links list', () => {
    const roster = [{ id: 'seat-gone', linkId: 'link-revoked' }];

    expect(linkSeatNames(links, roster).has('seat-gone')).toBe(false);
  });

  it('leaves out a roster entry that carries no link field', () => {
    const roster = [{ id: 'member-2' }];

    expect(linkSeatNames(links, roster).size).toBe(0);
  });
});

describe('budgetRowName', () => {
  const links = [
    { id: 'link-a', displayName: 'Luísa' },
    { id: 'link-b', displayName: null },
  ];
  const roster = [
    { id: 'm-bob', username: 'bob', linkId: null },
    { id: 'm-dana', username: 'dana_lee', linkId: null },
    { id: 'seat-a', username: null, linkId: 'link-a' },
    { id: 'seat-b', username: null, linkId: 'link-b' },
  ];

  it('names an account member by the username the budget row carries', () => {
    const row = { memberId: 'm-cara', userId: 'u-cara', username: 'cara' };

    expect(budgetRowName(row, roster, links)).toBe('Cara');
  });

  it('names an account member by the roster username first', () => {
    const row = { memberId: 'm-dana', userId: 'u-dana', username: null };

    expect(budgetRowName(row, roster, links)).toBe('Dana Lee');
  });

  it('names a link seat by its named link', () => {
    const row = { memberId: 'seat-a', userId: null, username: null };

    expect(budgetRowName(row, roster, links)).toBe('Luísa');
  });

  it('names a link seat by its unnamed link position', () => {
    const row = { memberId: 'seat-b', userId: null, username: null };

    expect(budgetRowName(row, roster, links)).toBe('Guest Link #2');
  });

  it('names a link seat whose link is not read yet as a guest link', () => {
    const row = { memberId: 'seat-new', userId: null, username: null };

    expect(budgetRowName(row, [], [])).toBe('Guest Link');
  });

  it('names an account member with no username anywhere as unknown', () => {
    const row = { memberId: 'm-gone', userId: 'u-gone', username: null };

    expect(budgetRowName(row, roster, links)).toBe('Unknown');
  });

  it('refuses a roster entry that carries no link field', () => {
    type RosterEntry = Parameters<typeof budgetRowName>[1][number];

    expectTypeOf<{ id: string; username: string | null }>().not.toExtend<RosterEntry>();
  });

  it('refuses a roster entry that carries no username field', () => {
    type RosterEntry = Parameters<typeof budgetRowName>[1][number];

    expectTypeOf<{ id: string; linkId: string | null }>().not.toExtend<RosterEntry>();
  });
});
