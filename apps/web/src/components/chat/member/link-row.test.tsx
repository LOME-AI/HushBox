import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_ID_BUILDERS, utcDayKeyAt } from '@hushbox/shared';
import {
  DAY_MS,
  HOUR_MS,
  TEST_DAY_START,
  TEST_LOCAL_DAY_START,
  isoAt,
} from '@hushbox/shared/test-time';
import { LinkRow } from '@/components/chat/member/link-row';
import { memberMoney } from '@/lib/chat/member-money';
import type { ConversationBudgetsResponse } from '@/hooks/billing/use-conversation-budgets';
import type { MemberPrivilege } from '@hushbox/shared';

// Late in the reference day on the reader's own clock, which is still that calendar day.
const CREATED_AT = isoAt(TEST_LOCAL_DAY_START + 23 * HOUR_MS);
const REFERENCE_DAY = utcDayKeyAt(TEST_DAY_START);

const baseLink = {
  id: 'link1',
  displayName: 'Dave',
  privilege: 'read',
  createdAt: CREATED_AT,
};

/** A dollar figure's nano-USD wire string, from whole cents. */
function cents(amount: number): string {
  return (BigInt(amount) * 10_000_000n).toString();
}

const budgets: ConversationBudgetsResponse = {
  conversationCapNanoUsd: cents(2000),
  conversationSpentNanoUsd: '0',
  ownerBalanceNanoUsd: null,
  members: [
    {
      memberId: 'm-dave',
      userId: null,
      username: null,
      privilege: 'write',
      capNanoUsd: cents(200),
      spentNanoUsd: cents(88),
      effectiveRemainingNanoUsd: cents(112),
    },
  ],
};

const HOST_ZONE = process.env['TZ'];

/** Runs the rest of the test on a clock in `zone`; the hook below puts the host's zone back. */
function pinZone(zone: string): void {
  process.env['TZ'] = zone;
}

afterEach(() => {
  if (HOST_ZONE === undefined) delete process.env['TZ'];
  else process.env['TZ'] = HOST_ZONE;
});

async function openOptions(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkActions('link1')));
  await screen.findByRole('menu');
  return user;
}

describe('LinkRow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the display name when present', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} viewerPrivilege="admin" />);

    expect(screen.getByTestId('link-item-link1')).toHaveTextContent('Dave');
  });

  it('falls back to Guest Link #N when display name is null', () => {
    render(
      <LinkRow
        link={{ ...baseLink, displayName: null }}
        index={3}
        isCurrentLink={false}
        viewerPrivilege="admin"
      />
    );

    expect(screen.getByTestId('link-item-link1')).toHaveTextContent('Guest Link #4');
  });

  it('saves trimmed name on Enter', async () => {
    const onSaveLinkName = vi.fn();
    const user = userEvent.setup();
    render(
      <LinkRow
        link={baseLink}
        index={0}
        isCurrentLink={false}
        viewerPrivilege="admin"
        onSaveLinkName={onSaveLinkName}
      />
    );

    await user.click(screen.getByTestId('link-actions-link1'));
    await waitFor(() => {
      expect(screen.getByTestId('link-change-name-link1')).toBeInTheDocument();
    });
    await user.click(screen.getByTestId('link-change-name-link1'));

    const input = await screen.findByTestId('link-name-input-link1');
    await user.clear(input);
    await user.type(input, '  New Name  {Enter}');

    expect(onSaveLinkName).toHaveBeenCalledWith('link1', 'New Name');
  });

  it('does not save an empty name', async () => {
    const onSaveLinkName = vi.fn();
    const user = userEvent.setup();
    render(
      <LinkRow
        link={baseLink}
        index={0}
        isCurrentLink={false}
        viewerPrivilege="admin"
        onSaveLinkName={onSaveLinkName}
      />
    );

    await user.click(screen.getByTestId('link-actions-link1'));
    await user.click(await screen.findByTestId('link-change-name-link1'));

    const input = await screen.findByTestId('link-name-input-link1');
    await user.clear(input);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSaveLinkName).not.toHaveBeenCalled();
    expect(screen.queryByTestId('link-name-input-link1')).not.toBeInTheDocument();
  });

  it('cancels editing on Escape without saving', async () => {
    const onSaveLinkName = vi.fn();
    const user = userEvent.setup();
    render(
      <LinkRow
        link={baseLink}
        index={0}
        isCurrentLink={false}
        viewerPrivilege="admin"
        onSaveLinkName={onSaveLinkName}
      />
    );

    await user.click(screen.getByTestId('link-actions-link1'));
    await user.click(await screen.findByTestId('link-change-name-link1'));

    const input = await screen.findByTestId('link-name-input-link1');
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(screen.queryByTestId('link-name-input-link1')).not.toBeInTheDocument();
    expect(onSaveLinkName).not.toHaveBeenCalled();
  });

  it('hides the actions menu for non-admins', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} viewerPrivilege="write" />);

    expect(screen.queryByTestId('link-actions-link1')).not.toBeInTheDocument();
  });

  it('shows the (you) badge for the current link', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink viewerPrivilege="admin" />);

    expect(screen.getByTestId('link-you-badge')).toBeInTheDocument();
  });

  it('names an unnamed link by its place in the list', () => {
    render(
      <LinkRow
        link={{ ...baseLink, displayName: null }}
        index={1}
        isCurrentLink={false}
        viewerPrivilege="admin"
      />
    );

    expect(screen.getByText('Guest Link #2')).toBeInTheDocument();
  });

  it('mutes the name of an unnamed link', () => {
    render(
      <LinkRow
        link={{ ...baseLink, displayName: null }}
        index={1}
        isCurrentLink={false}
        viewerPrivilege="admin"
      />
    );

    expect(screen.getByText('Guest Link #2')).toHaveClass('text-muted-foreground');
  });

  it('sets a named link in the full ink', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} viewerPrivilege="admin" />);

    expect(screen.getByText('Dave')).not.toHaveClass('text-muted-foreground');
  });

  it('reads the privilege and the day the link was created', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} viewerPrivilege="admin" />);

    expect(screen.getByTestId(TEST_ID_BUILDERS.linkItem('link1'))).toHaveTextContent(
      `Read · created ${REFERENCE_DAY}`
    );
  });

  it('reads Write for a write link', () => {
    render(
      <LinkRow
        link={{ ...baseLink, privilege: 'write' }}
        index={0}
        isCurrentLink={false}
        viewerPrivilege="admin"
      />
    );

    expect(screen.getByTestId(TEST_ID_BUILDERS.linkItem('link1'))).toHaveTextContent(
      `Write · created ${REFERENCE_DAY}`
    );
  });

  it.each([
    // Eleven hours behind UTC: early on the reference day in UTC is still the day before there.
    ['west of UTC', 'Pacific/Pago_Pago', TEST_DAY_START + 2 * HOUR_MS, TEST_DAY_START - DAY_MS],
    // Fourteen hours ahead: late on the reference day in UTC is already the next day there.
    ['east of UTC', 'Pacific/Kiritimati', TEST_DAY_START + 22 * HOUR_MS, TEST_DAY_START + DAY_MS],
  ])(
    "reads the created day on the viewer's own calendar %s",
    (_side, zone, createdAtMs, expectedDayMs) => {
      pinZone(zone);
      render(
        <LinkRow
          link={{ ...baseLink, createdAt: isoAt(createdAtMs) }}
          index={0}
          isCurrentLink={false}
          viewerPrivilege="admin"
        />
      );

      expect(screen.getByTestId(TEST_ID_BUILDERS.linkItem('link1'))).toHaveTextContent(
        `Read · created ${utcDayKeyAt(expectedDayMs)}`
      );
    }
  );

  it('keeps the created day whole when the sub-line wraps', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} viewerPrivilege="admin" />);

    expect(screen.getByText(REFERENCE_DAY)).toHaveClass('whitespace-nowrap');
  });

  it('carries the privilege on the row', () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} viewerPrivilege="admin" />);

    expect(screen.getByTestId(TEST_ID_BUILDERS.linkItem('link1'))).toHaveAttribute(
      'data-privilege',
      'read'
    );
  });

  it("shows a funded guest's remaining over its budget", () => {
    render(
      <LinkRow
        link={{ ...baseLink, privilege: 'write' }}
        index={0}
        isCurrentLink={false}
        viewerPrivilege="admin"
        money={memberMoney('m-dave', 'write', budgets)}
      />
    );

    const figure = screen.getByTestId(TEST_ID_BUILDERS.memberMoney('link1'));
    expect(within(figure).getByText('$1.12')).toBeInTheDocument();
    expect(within(figure).getByText('of $2.00 left')).toBeInTheDocument();
  });

  it('draws no figure without money', () => {
    render(
      <LinkRow
        link={baseLink}
        index={0}
        isCurrentLink={false}
        viewerPrivilege="admin"
        money={null}
      />
    );

    expect(screen.queryByTestId(TEST_ID_BUILDERS.memberMoney('link1'))).not.toBeInTheDocument();
  });

  it('names the options button for the link', () => {
    render(
      <LinkRow
        link={{ ...baseLink, displayName: null }}
        index={1}
        isCurrentLink={false}
        viewerPrivilege="admin"
      />
    );

    expect(screen.getByRole('button', { name: 'Options for Guest Link #2' })).toHaveAttribute(
      'data-testid',
      TEST_ID_BUILDERS.linkActions('link1')
    );
  });

  it('keeps the change-privilege id on the label', async () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} viewerPrivilege="admin" />);

    await openOptions();

    expect(screen.getByTestId(TEST_ID_BUILDERS.linkChangePrivilege('link1'))).toHaveTextContent(
      'Change privilege'
    );
  });

  it('labels the privilege group Change privilege', async () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} viewerPrivilege="admin" />);

    await openOptions();

    expect(screen.getByRole('group', { name: 'Change privilege' })).toBeInTheDocument();
  });

  it('keeps the privilege option ids on the menuitemradio items', async () => {
    render(<LinkRow link={baseLink} index={0} isCurrentLink={false} viewerPrivilege="admin" />);

    await openOptions();

    expect(
      screen.getAllByRole('menuitemradio').map((item) => item.dataset['testid'])
    ).toStrictEqual([
      TEST_ID_BUILDERS.linkPrivilegeOption('link1', 'read'),
      TEST_ID_BUILDERS.linkPrivilegeOption('link1', 'write'),
    ]);
  });

  it('calls the privilege handler with the chosen privilege', async () => {
    const onChangeLinkPrivilege = vi.fn();
    render(
      <LinkRow
        link={baseLink}
        index={0}
        isCurrentLink={false}
        viewerPrivilege="admin"
        onChangeLinkPrivilege={onChangeLinkPrivilege}
      />
    );
    const user = await openOptions();

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkPrivilegeOption('link1', 'write')));

    expect(onChangeLinkPrivilege).toHaveBeenCalledWith('link1', 'write');
  });

  it('asks to revoke the link by its label', async () => {
    const onRequestRevoke = vi.fn();
    render(
      <LinkRow
        link={{ ...baseLink, displayName: null }}
        index={1}
        isCurrentLink={false}
        viewerPrivilege="admin"
        onRequestRevoke={onRequestRevoke}
      />
    );
    const user = await openOptions();

    await user.click(screen.getByTestId(TEST_ID_BUILDERS.linkRevokeAction('link1')));

    expect(onRequestRevoke).toHaveBeenCalledWith('link1', 'Guest Link #2');
  });

  describe('the options each viewer gets', () => {
    const everyChoice = [
      TEST_ID_BUILDERS.linkChangePrivilege('link1'),
      TEST_ID_BUILDERS.linkPrivilegeOption('link1', 'read'),
      TEST_ID_BUILDERS.linkPrivilegeOption('link1', 'write'),
      TEST_ID_BUILDERS.linkChangeName('link1'),
      TEST_ID_BUILDERS.linkRevokeAction('link1'),
    ];

    // Written out rather than derived from the privilege rules, so a change to either shows here.
    it.each<[MemberPrivilege, MemberPrivilege, string[] | null]>([
      ['owner', 'read', everyChoice],
      ['owner', 'write', everyChoice],
      ['admin', 'read', everyChoice],
      ['admin', 'write', everyChoice],
      ['write', 'read', null],
      ['write', 'write', null],
      ['read', 'read', null],
      ['read', 'write', null],
    ])(
      'offers the viewer (%s) on a link (%s) exactly what it may do',
      async (viewer, target, expected) => {
        render(
          <LinkRow
            link={{ ...baseLink, privilege: target }}
            index={0}
            isCurrentLink={false}
            viewerPrivilege={viewer}
          />
        );

        if (expected === null) {
          expect(
            screen.queryByTestId(TEST_ID_BUILDERS.linkActions('link1'))
          ).not.toBeInTheDocument();
        } else {
          await openOptions();
          const menu = screen.getByRole('menu');
          expect(
            [...menu.querySelectorAll<HTMLElement>('[data-testid]')].map(
              (element) => element.dataset['testid']
            )
          ).toStrictEqual(expected);
        }
      }
    );

    // A link at the viewer's own level: link management allows every action, while the member
    // rules would refuse all but the rename, so this pins which rule the row reads.
    it('offers a link manager every action whatever privilege the link holds', async () => {
      render(
        <LinkRow
          link={{ ...baseLink, privilege: 'admin' }}
          index={0}
          isCurrentLink={false}
          viewerPrivilege="admin"
        />
      );

      await openOptions();

      const menu = screen.getByRole('menu');
      expect(
        [...menu.querySelectorAll<HTMLElement>('[data-testid]')].map(
          (element) => element.dataset['testid']
        )
      ).toStrictEqual(everyChoice);
    });
  });
});
