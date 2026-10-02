import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { MOBILE_BREAKPOINT, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { MemberRow } from '@/components/chat/member/member-row';
import { memberMoney, ownerMoney, type MoneyFigure } from '@/lib/chat/member-money';
import type { ConversationBudgetsResponse } from '@/hooks/billing/use-conversation-budgets';
import type { MemberPrivilege } from '@hushbox/shared';

const originalMatchMedia = globalThis.matchMedia;

/** A window `width` wide with a fine pointer, so the band hooks pick the menu's presentation. */
function installViewport(width: number): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const maxWidth = /^\(max-width: (\d+)px\)$/.exec(query);
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: maxWidth?.[1] !== undefined && width <= Number(maxWidth[1]),
        media: query,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      };
      // The band and pointer hooks read only `matches` and the listener pair.
      return list as MediaQueryList;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

interface RowMember {
  id: string;
  userId: string | null;
  username: string | null;
  privilege: string;
}

const bob: RowMember = { id: 'm-bob', userId: 'u-bob', username: 'bob', privilege: 'write' };
const alice: RowMember = {
  id: 'm-alice',
  userId: 'u-alice',
  username: 'alice',
  privilege: 'owner',
};

/** A dollar figure's nano-USD wire string, from whole cents. */
function cents(amount: number): string {
  return (BigInt(amount) * 10_000_000n).toString();
}

const budgets: ConversationBudgetsResponse = {
  conversationCapNanoUsd: cents(2000),
  conversationSpentNanoUsd: cents(246),
  ownerBalanceNanoUsd: cents(1248),
  members: [
    {
      memberId: 'm-bob',
      userId: 'u-bob',
      username: 'bob',
      privilege: 'write',
      capNanoUsd: cents(500),
      spentNanoUsd: cents(180),
      effectiveRemainingNanoUsd: cents(320),
    },
  ],
};

interface RenderOptions {
  member?: RowMember;
  isCurrentUser?: boolean;
  isOnline?: boolean;
  viewerPrivilege?: MemberPrivilege;
  money?: MoneyFigure | null;
  onLeaveClick?: () => void;
  onRemoveMember?: (memberId: string) => void;
  onChangePrivilege?: (memberId: string, next: string) => void;
}

function renderRow({
  member = bob,
  isCurrentUser = false,
  isOnline = false,
  viewerPrivilege = 'write',
  money,
  onLeaveClick,
  onRemoveMember = vi.fn(),
  onChangePrivilege = vi.fn(),
}: RenderOptions = {}): void {
  render(
    <MemberRow
      member={member}
      isCurrentUser={isCurrentUser}
      isOnline={isOnline}
      viewerPrivilege={viewerPrivilege}
      {...(money !== undefined && { money })}
      onLeaveClick={onLeaveClick}
      onRemoveMember={onRemoveMember}
      onChangePrivilege={onChangePrivilege}
    />
  );
}

async function openOptions(memberId = 'm-bob'): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions(memberId)));
  await screen.findByRole('menu');
  return user;
}

describe('MemberRow', () => {
  describe('who', () => {
    it('shows the display name', () => {
      renderRow();

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberItem('m-bob'))).toHaveTextContent('Bob');
    });

    it('marks the viewer with the you badge', () => {
      renderRow({ isCurrentUser: true, onLeaveClick: vi.fn() });

      expect(screen.getByTestId(TEST_IDS.memberYouBadge)).toHaveTextContent('(you)');
    });

    it('keeps the name on one line that truncates', () => {
      renderRow({ isCurrentUser: true, onLeaveClick: vi.fn() });

      expect(screen.getByTestId(TEST_IDS.memberYouBadge).parentElement).toHaveClass('truncate');
    });

    it('names a member with no username Guest', () => {
      renderRow({ member: { ...bob, userId: null, username: null } });

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberItem('m-bob'))).toHaveTextContent('Guest');
    });
  });

  describe('privilege and presence', () => {
    it('reads the privilege word and online on the sub-line', () => {
      renderRow({ member: alice, isOnline: true });

      expect(screen.getByText('Owner · online')).toBeInTheDocument();
    });

    it('reads the privilege word alone while offline', () => {
      renderRow();

      expect(screen.getByText('Write')).toBeInTheDocument();
    });

    it('carries the privilege on the row', () => {
      renderRow();

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberItem('m-bob'))).toHaveAttribute(
        'data-privilege',
        'write'
      );
    });

    it('marks an online member with the online id', () => {
      renderRow({ isOnline: true });

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberOnline('m-bob'))).toBeInTheDocument();
    });

    it('carries no online id for an offline member', () => {
      renderRow();

      expect(screen.queryByTestId(TEST_ID_BUILDERS.memberOnline('m-bob'))).not.toBeInTheDocument();
    });

    it('draws the online ring on the avatar', () => {
      renderRow({ isOnline: true });

      const row = screen.getByTestId(TEST_ID_BUILDERS.memberItem('m-bob'));
      expect(row.querySelector('[data-slot="avatar"]')).toHaveAttribute('data-online');
    });
  });

  describe('money', () => {
    it("shows a funded member's remaining over its budget", () => {
      renderRow({ money: memberMoney('m-bob', 'write', budgets) });

      const figure = screen.getByTestId(TEST_ID_BUILDERS.memberMoney('m-bob'));
      expect(within(figure).getByText('$3.20')).toBeInTheDocument();
      expect(within(figure).getByText('of $5.00 left')).toBeInTheDocument();
    });

    it("shows the owner's balance over balance", () => {
      renderRow({
        member: alice,
        money: ownerMoney(budgets, { isOwner: true, memberId: 'm-alice' }),
      });

      const figure = screen.getByTestId(TEST_ID_BUILDERS.memberMoney('m-alice'));
      expect(figure).toHaveTextContent('$12.48balance');
    });

    it('draws no figure for a member without money', () => {
      renderRow({ money: null });

      expect(screen.queryByTestId(TEST_ID_BUILDERS.memberMoney('m-bob'))).not.toBeInTheDocument();
    });

    it('draws no figure when no money is passed', () => {
      renderRow();

      expect(screen.queryByTestId(TEST_ID_BUILDERS.memberMoney('m-bob'))).not.toBeInTheDocument();
    });

    it('sets the amount in the mono figure face', () => {
      renderRow({ money: memberMoney('m-bob', 'write', budgets) });

      expect(screen.getByText('$3.20')).toHaveClass('text-num', 'font-mono');
    });

    it('keeps the money column from shrinking', () => {
      renderRow({ money: memberMoney('m-bob', 'write', budgets) });

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberMoney('m-bob'))).toHaveClass('shrink-0');
    });
  });

  describe('the options button', () => {
    it('is named for the member', () => {
      renderRow({ viewerPrivilege: 'owner' });

      expect(screen.getByRole('button', { name: 'Options for Bob' })).toHaveAttribute(
        'data-testid',
        TEST_ID_BUILDERS.memberActions('m-bob')
      );
    });

    it("names the viewer's own button with (you)", () => {
      renderRow({ isCurrentUser: true, onLeaveClick: vi.fn() });

      expect(screen.getByRole('button', { name: 'Options for Bob (you)' })).toBeInTheDocument();
    });
  });

  describe("the viewer's own row", () => {
    it('offers Leave', async () => {
      renderRow({ isCurrentUser: true, onLeaveClick: vi.fn() });

      await openOptions();

      expect(screen.getByTestId(TEST_IDS.memberLeaveAction)).toHaveAccessibleName('Leave');
    });

    it('calls the leave handler on Leave', async () => {
      const onLeaveClick = vi.fn();
      renderRow({ isCurrentUser: true, onLeaveClick });
      const user = await openOptions();

      await user.click(screen.getByTestId(TEST_IDS.memberLeaveAction));

      expect(onLeaveClick).toHaveBeenCalledOnce();
    });

    it('has no options without a leave handler', () => {
      renderRow({
        isCurrentUser: true,
        member: { ...bob, privilege: 'owner' },
        viewerPrivilege: 'owner',
      });

      expect(screen.queryByTestId(TEST_ID_BUILDERS.memberActions('m-bob'))).not.toBeInTheDocument();
    });
  });

  describe("an owner's options on another member", () => {
    it('labels the privilege group Change privilege', async () => {
      renderRow({ viewerPrivilege: 'owner' });

      await openOptions();

      expect(screen.getByRole('group', { name: 'Change privilege' })).toBeInTheDocument();
    });

    it('keeps the change-privilege id on the label', async () => {
      renderRow({ viewerPrivilege: 'owner' });

      await openOptions();

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberChangePrivilege('m-bob'))).toHaveTextContent(
        'Change privilege'
      );
    });

    it('marks the current privilege checked', async () => {
      renderRow({ viewerPrivilege: 'owner' });

      await openOptions();

      expect(
        screen.getByTestId(TEST_ID_BUILDERS.privilegeOption('m-bob', 'write'))
      ).toHaveAttribute('aria-checked', 'true');
    });

    it('calls the privilege handler with the chosen privilege', async () => {
      const onChangePrivilege = vi.fn();
      renderRow({ viewerPrivilege: 'owner', onChangePrivilege });
      const user = await openOptions();

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.privilegeOption('m-bob', 'read')));

      expect(onChangePrivilege).toHaveBeenCalledWith('m-bob', 'read');
    });

    it('calls the remove handler with the member id', async () => {
      const onRemoveMember = vi.fn();
      renderRow({ viewerPrivilege: 'owner', onRemoveMember });
      const user = await openOptions();

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberRemoveAction('m-bob')));

      expect(onRemoveMember).toHaveBeenCalledWith('m-bob');
    });

    it.each([
      ['a sheet', MOBILE_BREAKPOINT - 1],
      ['an anchored menu', MOBILE_BREAKPOINT],
    ])('draws the privilege choices as menuitemradio in %s', async (_presentation, width) => {
      installViewport(width);
      renderRow({ viewerPrivilege: 'owner' });

      await openOptions();

      expect(
        screen.getAllByRole('menuitemradio').map((item) => item.dataset['testid'])
      ).toStrictEqual([
        TEST_ID_BUILDERS.privilegeOption('m-bob', 'admin'),
        TEST_ID_BUILDERS.privilegeOption('m-bob', 'write'),
        TEST_ID_BUILDERS.privilegeOption('m-bob', 'read'),
      ]);
    });

    it('chooses a privilege from the phone sheet', async () => {
      installViewport(MOBILE_BREAKPOINT - 1);
      const onChangePrivilege = vi.fn();
      renderRow({ viewerPrivilege: 'owner', onChangePrivilege });

      await openOptions();
      // vaul's release handler reads a transform the test DOM never computes, so the sheet
      // takes a bare click.
      fireEvent.click(screen.getByTestId(TEST_ID_BUILDERS.privilegeOption('m-bob', 'admin')));

      expect(onChangePrivilege).toHaveBeenCalledWith('m-bob', 'admin');
    });
  });

  describe("an admin's remaining options send the same requests", () => {
    it('calls the privilege handler with the chosen privilege', async () => {
      const onChangePrivilege = vi.fn();
      renderRow({ viewerPrivilege: 'admin', onChangePrivilege });
      const user = await openOptions();

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.privilegeOption('m-bob', 'read')));

      expect(onChangePrivilege).toHaveBeenCalledWith('m-bob', 'read');
    });

    it('calls the remove handler with the member id', async () => {
      const onRemoveMember = vi.fn();
      renderRow({ viewerPrivilege: 'admin', onRemoveMember });
      const user = await openOptions();

      await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberRemoveAction('m-bob')));

      expect(onRemoveMember).toHaveBeenCalledWith('m-bob');
    });

    it('calls the leave handler with no arguments', async () => {
      const onLeaveClick = vi.fn();
      renderRow({
        isCurrentUser: true,
        member: { ...bob, privilege: 'admin' },
        viewerPrivilege: 'admin',
        onLeaveClick,
      });
      const user = await openOptions();

      await user.click(screen.getByTestId(TEST_IDS.memberLeaveAction));

      expect(onLeaveClick).toHaveBeenCalledWith();
    });
  });

  describe('the options each viewer gets', () => {
    const ids = {
      leave: TEST_IDS.memberLeaveAction,
      label: TEST_ID_BUILDERS.memberChangePrivilege('m-bob'),
      admin: TEST_ID_BUILDERS.privilegeOption('m-bob', 'admin'),
      write: TEST_ID_BUILDERS.privilegeOption('m-bob', 'write'),
      read: TEST_ID_BUILDERS.privilegeOption('m-bob', 'read'),
      remove: TEST_ID_BUILDERS.memberRemoveAction('m-bob'),
    };
    const everyChoice = [ids.label, ids.admin, ids.write, ids.read, ids.remove];
    const belowAdmin = [ids.label, ids.write, ids.read, ids.remove];

    async function menuIds(): Promise<(string | undefined)[]> {
      await openOptions();
      const menu = screen.getByRole('menu');
      return [...menu.querySelectorAll<HTMLElement>('[data-testid]')].map(
        (element) => element.dataset['testid']
      );
    }

    // Written out rather than derived from the privilege rules, so a change to either shows here.
    it.each<[MemberPrivilege, MemberPrivilege, string[] | null]>([
      ['owner', 'owner', null],
      ['owner', 'admin', everyChoice],
      ['owner', 'write', everyChoice],
      ['owner', 'read', everyChoice],
      ['admin', 'owner', null],
      ['admin', 'admin', null],
      ['admin', 'write', belowAdmin],
      ['admin', 'read', belowAdmin],
      ['write', 'owner', null],
      ['write', 'admin', null],
      ['write', 'write', null],
      ['write', 'read', null],
      ['read', 'owner', null],
      ['read', 'admin', null],
      ['read', 'write', null],
      ['read', 'read', null],
    ])(
      'offers the viewer (%s) on a member (%s) exactly what it may do',
      async (viewer, target, expected) => {
        renderRow({ viewerPrivilege: viewer, member: { ...bob, privilege: target } });

        if (expected === null) {
          expect(
            screen.queryByTestId(TEST_ID_BUILDERS.memberActions('m-bob'))
          ).not.toBeInTheDocument();
        } else {
          expect(await menuIds()).toStrictEqual(expected);
        }
      }
    );

    it.each<MemberPrivilege>(['owner', 'admin', 'write', 'read'])(
      'offers the viewer (%s) Leave alone on their own row',
      async (viewer) => {
        renderRow({
          isCurrentUser: true,
          viewerPrivilege: viewer,
          member: { ...bob, privilege: viewer },
          onLeaveClick: vi.fn(),
        });

        expect(await menuIds()).toStrictEqual([ids.leave]);
      }
    );

    it.each<MemberPrivilege>(['owner', 'admin', 'write', 'read'])(
      'offers the viewer (%s) no options on their own row without a leave handler',
      (viewer) => {
        renderRow({
          isCurrentUser: true,
          viewerPrivilege: viewer,
          member: { ...bob, privilege: viewer },
        });

        expect(
          screen.queryByTestId(TEST_ID_BUILDERS.memberActions('m-bob'))
        ).not.toBeInTheDocument();
      }
    );
  });
});
