import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { centsToNanoUsd, MEMBER_PRIVILEGES, TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { renderWithProviders } from '@/test-utils/render';
import {
  MemberSidebarBody,
  type MemberSidebarBodyProps,
} from '@/components/chat/member/member-sidebar-body';
import type { ConversationBudgetsResponse } from '@/hooks/billing/use-conversation-budgets';
import type { MemberPrivilege } from '@hushbox/shared';

interface AddMembersRule {
  override: ((privilege: MemberPrivilege) => boolean) | null;
}

const { addMembersRule } = vi.hoisted((): { addMembersRule: AddMembersRule } => ({
  addMembersRule: { override: null },
}));

// The real rule unless a case overrides it, so a case can tell the add rule from the link rule.
vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    canAddMembers: (privilege: MemberPrivilege): boolean =>
      addMembersRule.override === null
        ? actual.canAddMembers(privilege)
        : addMembersRule.override(privilege),
  };
});

function makeMembers(): MemberSidebarBodyProps['members'] {
  return [
    { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
    { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
    { id: 'guest1', userId: null, username: null, privilege: 'read' },
  ];
}

function makeLinks(): MemberSidebarBodyProps['links'] {
  return [
    {
      id: 'link1',
      displayName: 'Reading link',
      privilege: 'read',
      createdAt: isoAt(TEST_DAY_START),
      memberId: null,
    },
    {
      id: 'link2',
      displayName: 'Bobby link',
      privilege: 'write',
      createdAt: isoAt(TEST_DAY_START + DAY_MS),
      memberId: 'linkseat2',
    },
  ];
}

function baseProps(overrides: Partial<MemberSidebarBodyProps> = {}): MemberSidebarBodyProps {
  return {
    members: makeMembers(),
    links: makeLinks(),
    onlineMemberIds: new Set(['u1']),
    currentUserId: 'u1',
    currentUserLinkId: null,
    currentUserPrivilege: 'owner',
    conversationId: 'conv-1',
    ...overrides,
  };
}

describe('MemberSidebarBody', () => {
  it('confirms member removal, invoking onRemoveMember once', async () => {
    const user = userEvent.setup();
    const onRemoveMember = vi.fn();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRemoveMember })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('m2')));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_ID_BUILDERS.memberRemoveAction('m2'))).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberRemoveAction('m2')));
    await user.click(await screen.findByTestId('remove-member-confirm'));

    expect(onRemoveMember).toHaveBeenCalledWith('m2');
  });

  it('closes the remove modal on cancel without calling onRemoveMember', async () => {
    const user = userEvent.setup();
    const onRemoveMember = vi.fn();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRemoveMember })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('m2')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.memberRemoveAction('m2')));
    await user.click(await screen.findByTestId('remove-member-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('remove-member-modal')).not.toBeInTheDocument();
    });
    expect(onRemoveMember).not.toHaveBeenCalled();
  });

  it('confirms removal safely when no onRemoveMember handler is wired', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRemoveMember: undefined })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('m2')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.memberRemoveAction('m2')));
    await user.click(await screen.findByTestId('remove-member-confirm'));

    await waitFor(() => {
      expect(screen.queryByTestId('remove-member-modal')).not.toBeInTheDocument();
    });
  });

  it('labels a guest member as "this member" in the remove dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRemoveMember: vi.fn() })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('guest1')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.memberRemoveAction('guest1')));

    expect(await screen.findByTestId('remove-member-title')).toHaveTextContent(
      'Remove this member?'
    );
  });

  it('awaits an async privilege change', async () => {
    const user = userEvent.setup();
    const onChangePrivilege = vi.fn(() => Promise.resolve());
    renderWithProviders(<MemberSidebarBody {...baseProps({ onChangePrivilege })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('m2')));
    fireEvent.click(await screen.findByTestId(TEST_ID_BUILDERS.privilegeOption('m2', 'read')));

    await waitFor(() => {
      expect(onChangePrivilege).toHaveBeenCalledWith('m2', 'read');
    });
  });

  it('confirms link revocation and calls onRevokeLinkClick', async () => {
    const user = userEvent.setup();
    const onRevokeLinkClick = vi.fn();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRevokeLinkClick })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkActions('link1')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.linkRevokeAction('link1')));
    await user.click(await screen.findByTestId('revoke-link-confirm'));

    expect(onRevokeLinkClick).toHaveBeenCalledWith('link1');
  });

  it('confirms link revocation safely when no onRevokeLinkClick handler is wired', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps({ onRevokeLinkClick: undefined })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkActions('link1')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.linkRevokeAction('link1')));
    await user.click(await screen.findByTestId('revoke-link-confirm'));

    await waitFor(() => {
      expect(screen.queryByTestId('revoke-link-modal')).not.toBeInTheDocument();
    });
  });

  it('awaits an async link privilege change', async () => {
    const user = userEvent.setup();
    const onChangeLinkPrivilege = vi.fn(() => Promise.resolve());
    renderWithProviders(<MemberSidebarBody {...baseProps({ onChangeLinkPrivilege })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkActions('link1')));
    fireEvent.click(
      await screen.findByTestId(TEST_ID_BUILDERS.linkPrivilegeOption('link1', 'write'))
    );

    await waitFor(() => {
      expect(onChangeLinkPrivilege).toHaveBeenCalledWith('link1', 'write');
    });
  });

  it('awaits an async link name save', async () => {
    const user = userEvent.setup();
    const onSaveLinkName = vi.fn(() => Promise.resolve());
    renderWithProviders(<MemberSidebarBody {...baseProps({ onSaveLinkName })} />);

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkActions('link1')));
    await user.click(await screen.findByTestId(TEST_ID_BUILDERS.linkChangeName('link1')));

    const input = await screen.findByTestId(TEST_ID_BUILDERS.linkNameInput('link1'));
    await user.clear(input);
    await user.type(input, 'Renamed{Enter}');

    await waitFor(() => {
      expect(onSaveLinkName).toHaveBeenCalledWith('link1', 'Renamed');
    });
  });

  it("offers no options on the owner's row to an admin viewer", () => {
    renderWithProviders(
      <MemberSidebarBody {...baseProps({ currentUserId: 'u2', currentUserPrivilege: 'admin' })} />
    );

    expect(screen.queryByTestId(TEST_ID_BUILDERS.memberActions('m1'))).not.toBeInTheDocument();
  });

  it("offers an admin viewer only the privileges below its own on a member's row", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MemberSidebarBody {...baseProps({ currentUserId: 'u9', currentUserPrivilege: 'admin' })} />
    );

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.memberActions('m2')));
    await screen.findByRole('menu');

    expect(
      screen.getAllByRole('menuitemradio').map((item) => item.dataset['testid'])
    ).toStrictEqual([
      TEST_ID_BUILDERS.privilegeOption('m2', 'write'),
      TEST_ID_BUILDERS.privilegeOption('m2', 'read'),
    ]);
  });

  it('filters members by the search query', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps()} />);

    await user.type(screen.getByTestId(TEST_IDS.memberSearchInput), 'bob');

    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('renders no privilege sections', () => {
    renderWithProviders(<MemberSidebarBody {...baseProps()} />);

    for (const privilege of MEMBER_PRIVILEGES) {
      expect(
        screen.queryByTestId(TEST_ID_BUILDERS.memberSection(privilege))
      ).not.toBeInTheDocument();
    }
  });

  it('lists the members first, then the Invite links label with the link count', () => {
    renderWithProviders(<MemberSidebarBody {...baseProps()} />);

    const label = screen.getByRole('heading', { name: 'Invite links · 2' });
    expect(
      screen.getByTestId(TEST_ID_BUILDERS.memberItem('guest1')).compareDocumentPosition(label)
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      label.compareDocumentPosition(screen.getByTestId(TEST_ID_BUILDERS.linkItem('link1')))
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('lists the members highest privilege first, owner at the top', () => {
    renderWithProviders(
      <MemberSidebarBody
        {...baseProps({
          members: [
            { id: 'r', userId: 'ur', username: 'rita', privilege: 'read' },
            { id: 'w', userId: 'uw', username: 'will', privilege: 'write' },
            { id: 'o', userId: 'uo', username: 'olga', privilege: 'owner' },
            { id: 'a', userId: 'ua', username: 'abe', privilege: 'admin' },
          ],
        })}
      />
    );

    const order = screen.getAllByTestId(/^member-item-/).map((row) => row.dataset['testid']);
    expect(order).toStrictEqual(['o', 'a', 'w', 'r'].map((id) => TEST_ID_BUILDERS.memberItem(id)));
  });

  it('lists the links in the order the links read serves them', () => {
    renderWithProviders(<MemberSidebarBody {...baseProps()} />);

    const order = screen.getAllByTestId(/^link-item-/).map((row) => row.dataset['testid']);
    expect(order).toStrictEqual(['link1', 'link2'].map((id) => TEST_ID_BUILDERS.linkItem(id)));
  });

  it('draws no Invite links label when no link is listed', () => {
    renderWithProviders(<MemberSidebarBody {...baseProps({ links: [] })} />);

    expect(screen.queryByRole('heading', { name: /Invite links/ })).not.toBeInTheDocument();
  });

  describe('Add Member by privilege', () => {
    afterEach(() => {
      addMembersRule.override = null;
    });

    const ADDS: Readonly<Record<MemberPrivilege, boolean>> = {
      owner: true,
      admin: true,
      write: false,
      read: false,
    };

    for (const privilege of MEMBER_PRIVILEGES) {
      it(`${ADDS[privilege] ? 'offers' : 'withholds'} Add Member for a ${privilege} viewer`, () => {
        renderWithProviders(
          <MemberSidebarBody
            {...baseProps({ currentUserId: 'u9', currentUserPrivilege: privilege })}
          />
        );

        if (ADDS[privilege]) {
          expect(screen.getByTestId(TEST_IDS.newMemberButton)).toBeInTheDocument();
        } else {
          expect(screen.queryByTestId(TEST_IDS.newMemberButton)).not.toBeInTheDocument();
        }
      });
    }

    it('follows the add-members rule rather than the link rule', () => {
      addMembersRule.override = (): boolean => false;

      renderWithProviders(<MemberSidebarBody {...baseProps()} />);

      expect(screen.queryByTestId(TEST_IDS.newMemberButton)).not.toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.inviteLinkButton)).toBeInTheDocument();
    });
  });

  it('offers an owner Add Member and Invite via Link', () => {
    renderWithProviders(<MemberSidebarBody {...baseProps()} />);

    expect(screen.getByTestId(TEST_IDS.newMemberButton)).toHaveAccessibleName('Add Member');
    expect(screen.getByTestId(TEST_IDS.inviteLinkButton)).toHaveAccessibleName('Invite via Link');
  });

  it('offers a read member no Add Member', () => {
    renderWithProviders(
      <MemberSidebarBody {...baseProps({ currentUserId: 'u9', currentUserPrivilege: 'read' })} />
    );

    expect(screen.queryByTestId(TEST_IDS.newMemberButton)).not.toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.inviteLinkButton)).not.toBeInTheDocument();
  });

  it('offers a read member Search members', () => {
    renderWithProviders(
      <MemberSidebarBody {...baseProps({ currentUserId: 'u9', currentUserPrivilege: 'read' })} />
    );

    expect(screen.getByTestId(TEST_IDS.memberSearchInput)).toHaveAccessibleName('Search members');
  });

  it('keeps Bob and the matching link when searching "bo"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps()} />);

    await user.type(screen.getByTestId(TEST_IDS.memberSearchInput), 'bo');

    expect(screen.getByTestId(TEST_ID_BUILDERS.memberItem('m2'))).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_ID_BUILDERS.memberItem('m1'))).not.toBeInTheDocument();
    expect(screen.getByTestId(TEST_ID_BUILDERS.linkItem('link2'))).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_ID_BUILDERS.linkItem('link1'))).not.toBeInTheDocument();
  });

  it('counts the links the search leaves in the Invite links label', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MemberSidebarBody {...baseProps()} />);

    await user.type(screen.getByTestId(TEST_IDS.memberSearchInput), 'bo');

    expect(screen.getByRole('heading', { name: 'Invite links · 1' })).toBeInTheDocument();
  });

  it('marks an online member with the memberOnline id', () => {
    renderWithProviders(<MemberSidebarBody {...baseProps()} />);

    expect(screen.getByTestId(TEST_ID_BUILDERS.memberOnline('m1'))).toBeInTheDocument();
  });

  describe('money', () => {
    function budgets(
      overrides: Partial<ConversationBudgetsResponse> = {}
    ): ConversationBudgetsResponse {
      return {
        conversationCapNanoUsd: centsToNanoUsd(4000),
        conversationSpentNanoUsd: centsToNanoUsd(961),
        ownerBalanceNanoUsd: centsToNanoUsd(1248),
        members: [
          {
            memberId: 'm2',
            userId: 'u2',
            username: 'bob',
            privilege: 'write',
            capNanoUsd: centsToNanoUsd(500),
            spentNanoUsd: centsToNanoUsd(180),
            effectiveRemainingNanoUsd: centsToNanoUsd(320),
          },
          {
            memberId: 'guest1',
            userId: null,
            username: null,
            privilege: 'read',
            capNanoUsd: centsToNanoUsd(500),
            spentNanoUsd: '0',
            effectiveRemainingNanoUsd: centsToNanoUsd(500),
          },
          {
            memberId: 'linkseat2',
            userId: null,
            username: null,
            privilege: 'write',
            capNanoUsd: centsToNanoUsd(200),
            spentNanoUsd: centsToNanoUsd(88),
            effectiveRemainingNanoUsd: centsToNanoUsd(112),
          },
        ],
        ...overrides,
      };
    }

    it('shows the owner their balance on their own row', () => {
      renderWithProviders(<MemberSidebarBody {...baseProps({ budgets: budgets() })} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberMoney('m1'))).toHaveTextContent(
        '$12.48balance'
      );
    });

    it("shows a non-owner no figure on the owner's row", () => {
      renderWithProviders(
        <MemberSidebarBody
          {...baseProps({
            currentUserId: 'u2',
            currentUserPrivilege: 'admin',
            budgets: budgets({ ownerBalanceNanoUsd: centsToNanoUsd(1248) }),
          })}
        />
      );

      expect(screen.queryByTestId(TEST_ID_BUILDERS.memberMoney('m1'))).not.toBeInTheDocument();
    });

    it("shows a funded member's remaining of their budget", () => {
      renderWithProviders(<MemberSidebarBody {...baseProps({ budgets: budgets() })} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberMoney('m2'))).toHaveTextContent(
        '$3.20of $5.00 left'
      );
    });

    it('shows a read member no figure, whatever their budget', () => {
      renderWithProviders(<MemberSidebarBody {...baseProps({ budgets: budgets() })} />);

      expect(screen.queryByTestId(TEST_ID_BUILDERS.memberMoney('guest1'))).not.toBeInTheDocument();
    });

    it("shows a funded link its seated guest's figure", () => {
      renderWithProviders(<MemberSidebarBody {...baseProps({ budgets: budgets() })} />);

      expect(screen.getByTestId(TEST_ID_BUILDERS.memberMoney('link2'))).toHaveTextContent(
        '$1.12of $2.00 left'
      );
    });

    it('shows no figure on a link whose seated member is not read yet', () => {
      renderWithProviders(<MemberSidebarBody {...baseProps({ budgets: budgets() })} />);

      expect(screen.queryByTestId(TEST_ID_BUILDERS.memberMoney('link1'))).not.toBeInTheDocument();
    });

    it('shows no figures while the budgets read has not answered', () => {
      renderWithProviders(<MemberSidebarBody {...baseProps()} />);

      expect(screen.queryByTestId(/^member-money-/)).not.toBeInTheDocument();
    });
  });
});
