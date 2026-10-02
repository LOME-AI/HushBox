import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import { renderWithProviders } from '@/test-utils/render';
import { MemberSidebarFooter } from '@/components/chat/member/member-sidebar-footer';
import { budgetKeys } from '@/hooks/billing/use-conversation-budgets';
import type { ConversationBudgetsResponse } from '@/hooks/billing/use-conversation-budgets';
import type { QueryClient } from '@tanstack/react-query';
import type { MemberPrivilege } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { client } from '@/lib/api-client';

type BudgetRow = ConversationBudgetsResponse['members'][number];

type Conversations = (typeof client.conversations)[':conversationId'];
type MembersBody = InferResponseType<Conversations['members']['$get'], 200>;
type LinksBody = InferResponseType<Conversations['links']['$get'], 200>;
type RosterEntry = MembersBody['members'][number];
type LinkEntry = LinksBody['links'][number];

interface Served {
  budgets: ConversationBudgetsResponse | 'fail';
  roster: MembersBody['members'];
  links: LinksBody['links'];
}

function seat(id: string, linkId: string): RosterEntry {
  return {
    id,
    userId: null,
    linkId,
    username: null,
    privilege: 'write',
    visibleFromEpoch: 1,
    joinedAt: isoAt(TEST_DAY_START),
    accepted: true,
  };
}

function link(id: string, displayName: string | null): LinkEntry {
  return {
    id,
    displayName,
    privilege: 'write',
    revokedAt: null,
    expiresAt: null,
    createdAt: isoAt(TEST_DAY_START),
  };
}

const CENT = 10_000_000n;

function usd(cents: bigint): string {
  return (cents * CENT).toString();
}

function funded(memberId: string, username: string | null, effectiveCents: bigint): BudgetRow {
  return {
    memberId,
    userId: username === null ? null : `user-${memberId}`,
    username,
    privilege: 'write',
    capNanoUsd: usd(500n),
    spentNanoUsd: usd(0n),
    effectiveRemainingNanoUsd: usd(effectiveCents),
  };
}

function ownerBudgets(
  members: BudgetRow[],
  overrides: Partial<ConversationBudgetsResponse> = {}
): ConversationBudgetsResponse {
  return {
    conversationCapNanoUsd: usd(2000n),
    conversationSpentNanoUsd: usd(246n),
    ownerBalanceNanoUsd: usd(1248n),
    members,
    ...overrides,
  };
}

const EIGHT_NAMES = [
  'Bob',
  'Charlie',
  'Maximiliana Oyelaran-Whitcombe',
  'Joaquín Hernández-Villaseñor',
  'Dana',
  'Priya',
  'Siobhán',
  'Tomasz',
];

const EIGHT_FULL =
  'Bob, Charlie, Maximiliana Oyelaran-Whitcombe, Joaquín Hernández-Villaseñor, Dana, Priya, Siobhán and Tomasz';

let served: Served;
let mockFetch: Mock<typeof fetch>;

function respond(url: string): Response {
  if (url.includes('/budgets')) {
    return served.budgets === 'fail'
      ? Response.json({ code: 'INTERNAL' }, { status: 500 })
      : Response.json(served.budgets);
  }
  if (url.includes('/members')) return Response.json({ members: served.roster });
  if (url.includes('/links')) return Response.json({ links: served.links });
  return Response.json({ code: 'NOT_FOUND' }, { status: 404 });
}

function renderFoot(
  privilege: MemberPrivilege,
  options: { collapsed?: boolean; onClick?: () => void; currentUserId?: string } = {}
): QueryClient {
  return renderWithProviders(
    <MemberSidebarFooter
      conversationId="conv-1"
      currentUserId={options.currentUserId ?? 'user-viewer'}
      currentUserPrivilege={privilege}
      collapsed={options.collapsed ?? false}
      onBudgetSettingsClick={options.onClick}
    />
  ).queryClient;
}

/** Waits until the budgets read has answered, so an absent figure is not merely early. */
async function budgetsSettled(queryClient: QueryClient): Promise<void> {
  await waitFor(() => {
    expect(queryClient.getQueryState(budgetKeys.conversation('conv-1'))?.status).not.toBe(
      'pending'
    );
  });
}

function footer(): HTMLElement {
  return screen.getByTestId(TEST_IDS.memberBudgetFooter);
}

async function findLineNamed(name: string): Promise<HTMLElement> {
  return screen.findByRole('button', { name });
}

async function findFundedLine(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: /^You pay for/ });
}

beforeEach(() => {
  served = { budgets: ownerBudgets([]), roster: [], links: [] };
  mockFetch = vi.fn<typeof fetch>((input) => Promise.resolve(respond(urlFromFetchInput(input))));
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('MemberSidebarFooter as the owner', () => {
  it('reads the conversation spend of the overall budget', async () => {
    renderFoot('owner');

    await waitFor(() => {
      expect(footer()).toHaveTextContent('$2.46 of $20.00 spent');
    });
  });

  it('names the funded members in the order the budgets read serves them', async () => {
    served.budgets = ownerBudgets([funded('m-bob', 'bob', 320n), funded('m-cha', 'charlie', 5n)]);

    renderFoot('owner');

    expect(await findLineNamed('You pay for Bob and Charlie')).toBeInTheDocument();
  });

  it('opens the whole list under a line that shows every name', async () => {
    const user = userEvent.setup();
    served.budgets = ownerBudgets([funded('m-bob', 'bob', 320n), funded('m-cha', 'charlie', 5n)]);
    renderFoot('owner');
    const line = await findLineNamed('You pay for Bob and Charlie');
    expect(line).toHaveAttribute('aria-expanded', 'false');

    await user.click(line);

    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId(TEST_IDS.memberFundedNames)).toHaveTextContent('Bob and Charlie');
  });

  it('shows the whole list in a tooltip on hover when every name is shown', async () => {
    const user = userEvent.setup();
    served.budgets = ownerBudgets([funded('m-bob', 'bob', 320n), funded('m-cha', 'charlie', 5n)]);
    renderFoot('owner');

    await user.hover(await findLineNamed('You pay for Bob and Charlie'));

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Bob and Charlie');
  });

  it('keeps a line that shows every name on one line', async () => {
    served.budgets = ownerBudgets([funded('m-bob', 'bob', 320n), funded('m-cha', 'charlie', 5n)]);
    renderFoot('owner');

    const line = await findLineNamed('You pay for Bob and Charlie');

    expect(within(line).getByText('You pay for Bob and Charlie')).toHaveClass('truncate');
  });

  it('draws no count when every name is shown', async () => {
    served.budgets = ownerBudgets([funded('m-bob', 'bob', 320n), funded('m-cha', 'charlie', 5n)]);
    renderFoot('owner');

    expect(await findLineNamed('You pay for Bob and Charlie')).not.toHaveTextContent('+');
  });

  it('leaves out a member whose effective remaining is zero', async () => {
    served.budgets = ownerBudgets([funded('m-bob', 'bob', 320n), funded('m-cha', 'charlie', 0n)]);

    renderFoot('owner');

    expect(await findLineNamed('You pay for Bob')).toBeInTheDocument();
  });

  it('names a funded link seat by its link', async () => {
    served.budgets = ownerBudgets([
      funded('m-bob', 'bob', 320n),
      funded('seat-named', null, 100n),
      funded('seat-unnamed', null, 100n),
    ]);
    served.roster = [seat('seat-named', 'link-a'), seat('seat-unnamed', 'link-b')];
    served.links = [link('link-a', 'Luísa'), link('link-b', null)];

    renderFoot('owner');

    expect(await findLineNamed('You pay for Bob, Luísa and Guest Link #2')).toBeInTheDocument();
  });

  it('names a link seat whose link is not read yet as a guest link', async () => {
    served.budgets = ownerBudgets([funded('seat-new', null, 100n)]);

    renderFoot('owner');

    expect(await findLineNamed('You pay for Guest Link')).toBeInTheDocument();
  });

  it('shows the first three names and a count of the rest', async () => {
    served.budgets = ownerBudgets(
      EIGHT_NAMES.map((name, index) => funded(`m-${String(index)}`, name, 100n))
    );

    renderFoot('owner');

    const line = await findFundedLine();
    expect(line).toHaveTextContent('You pay for Bob, Charlie, Maximiliana Oyelaran-Whitcombe');
    expect(line).toHaveTextContent('+5');
  });

  it('names the count for assistive technology', async () => {
    served.budgets = ownerBudgets(
      EIGHT_NAMES.map((name, index) => funded(`m-${String(index)}`, name, 100n))
    );

    renderFoot('owner');

    expect(await findFundedLine()).toHaveAccessibleName(
      'You pay for Bob, Charlie, Maximiliana Oyelaran-Whitcombe and 5 more'
    );
  });

  it('opens the full list under the line on press', async () => {
    const user = userEvent.setup();
    served.budgets = ownerBudgets(
      EIGHT_NAMES.map((name, index) => funded(`m-${String(index)}`, name, 100n))
    );
    renderFoot('owner');
    const line = await findFundedLine();
    expect(line).toHaveAttribute('aria-expanded', 'false');

    await user.click(line);

    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId(TEST_IDS.memberFundedNames)).toHaveTextContent(EIGHT_FULL);
  });

  it('points the line at the list it opens', async () => {
    const user = userEvent.setup();
    served.budgets = ownerBudgets(
      EIGHT_NAMES.map((name, index) => funded(`m-${String(index)}`, name, 100n))
    );
    renderFoot('owner');
    const line = await findFundedLine();

    await user.click(line);

    expect(screen.getByTestId(TEST_IDS.memberFundedNames)).toHaveAttribute(
      'id',
      line.getAttribute('aria-controls')
    );
  });

  it('closes the full list on a second press', async () => {
    const user = userEvent.setup();
    served.budgets = ownerBudgets(
      EIGHT_NAMES.map((name, index) => funded(`m-${String(index)}`, name, 100n))
    );
    renderFoot('owner');
    const line = await findFundedLine();

    await user.click(line);
    await user.click(line);

    expect(line).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.memberFundedNames)).not.toBeInTheDocument();
    });
  });

  it('shows the full list in a tooltip on hover', async () => {
    const user = userEvent.setup();
    served.budgets = ownerBudgets(
      EIGHT_NAMES.map((name, index) => funded(`m-${String(index)}`, name, 100n))
    );
    renderFoot('owner');

    await user.hover(await findFundedLine());

    expect(await screen.findByRole('tooltip')).toHaveTextContent(EIGHT_FULL);
  });

  it('raises no tooltip on a touch device, where a press opens the list', async () => {
    const user = userEvent.setup();
    served.budgets = ownerBudgets(
      EIGHT_NAMES.map((name, index) => funded(`m-${String(index)}`, name, 100n))
    );
    renderWithProviders(
      <TouchDeviceOverrideContext value={true}>
        <MemberSidebarFooter
          conversationId="conv-1"
          currentUserId="user-viewer"
          currentUserPrivilege="owner"
          collapsed={false}
        />
      </TouchDeviceOverrideContext>
    );

    await user.click(await findFundedLine());

    expect(screen.getByTestId(TEST_IDS.memberFundedNames)).toHaveTextContent(EIGHT_FULL);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('draws no funded line when the overall budget is $0.00', async () => {
    served.budgets = ownerBudgets([funded('m-bob', 'bob', 0n), funded('m-cha', 'charlie', 0n)], {
      conversationCapNanoUsd: '0',
      conversationSpentNanoUsd: '0',
    });

    renderFoot('owner');

    await waitFor(() => {
      expect(footer()).toHaveTextContent('$0.00 of $0.00 spent');
    });
    expect(screen.queryByText(/You pay for/)).not.toBeInTheDocument();
  });

  it('draws no funded line when no member is funded', async () => {
    renderFoot('owner');

    await waitFor(() => {
      expect(footer()).toHaveTextContent('$2.46 of $20.00 spent');
    });
    expect(screen.queryByTestId(TEST_IDS.memberFundedNames)).not.toBeInTheDocument();
  });

  it('formats a large nano-USD amount exactly', async () => {
    served.budgets = ownerBudgets([], {
      conversationSpentNanoUsd: '9007199254740993000000000',
      conversationCapNanoUsd: '12345678901234567890123',
    });

    renderFoot('owner');

    await waitFor(() => {
      expect(footer()).toHaveTextContent('$9007199254740993.00 of $12345678901234.56 spent');
    });
  });

  it('offers Change budgets on the budget trigger', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    renderFoot('owner', { onClick });

    const trigger = screen.getByTestId(TEST_IDS.memberBudgetTrigger);
    expect(trigger).toHaveAccessibleName('Change budgets');

    await user.click(trigger);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('labels the foot as the Budgets group', () => {
    renderFoot('owner');

    expect(screen.getByRole('group', { name: 'Budgets' })).toBe(footer());
  });

  it('shows no figures while the budgets read fails', async () => {
    served.budgets = 'fail';

    const queryClient = renderFoot('owner');

    await budgetsSettled(queryClient);
    expect(queryClient.getQueryState(budgetKeys.conversation('conv-1'))?.status).toBe('error');
    expect(footer()).toHaveTextContent('Budgets');
    expect(footer()).not.toHaveTextContent('$');
  });
});

describe('MemberSidebarFooter as a member', () => {
  function ownRow(overrides: Partial<BudgetRow> = {}): BudgetRow {
    return {
      memberId: 'm-viewer',
      userId: 'user-viewer',
      username: 'viewer',
      privilege: 'write',
      capNanoUsd: usd(500n),
      spentNanoUsd: usd(150n),
      effectiveRemainingNanoUsd: usd(350n),
      ...overrides,
    };
  }

  function memberBudgets(members: BudgetRow[]): ConversationBudgetsResponse {
    return ownerBudgets(members, { ownerBalanceNanoUsd: null });
  }

  it('reads their own spend of their own budget', async () => {
    served.budgets = memberBudgets([ownRow()]);

    renderFoot('write');

    await waitFor(() => {
      expect(footer()).toHaveTextContent('$1.50 of $5.00 spent');
    });
  });

  it('reads a $0.00 budget as it is served', async () => {
    served.budgets = memberBudgets([ownRow({ capNanoUsd: '0', spentNanoUsd: '0' })]);

    renderFoot('write');

    await waitFor(() => {
      expect(footer()).toHaveTextContent('$0.00 of $0.00 spent');
    });
  });

  it('shows no figures without a row of their own', async () => {
    served.budgets = memberBudgets([]);

    const queryClient = renderFoot('write');

    await budgetsSettled(queryClient);
    expect(footer()).not.toHaveTextContent('$');
  });

  it('shows no funded line', async () => {
    served.budgets = memberBudgets([ownRow()]);

    renderFoot('write');

    await waitFor(() => {
      expect(footer()).toHaveTextContent('$1.50 of $5.00 spent');
    });
    expect(screen.queryByText(/You pay for/)).not.toBeInTheDocument();
  });

  it('offers See budgets on the budget trigger', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    renderFoot('write', { onClick });

    const trigger = screen.getByTestId(TEST_IDS.memberBudgetTrigger);
    expect(trigger).toHaveAccessibleName('See budgets');

    await user.click(trigger);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('offers an admin See budgets', () => {
    renderFoot('admin');

    expect(screen.getByTestId(TEST_IDS.memberBudgetTrigger)).toHaveAccessibleName('See budgets');
  });
});

describe('MemberSidebarFooter on the collapsed rail', () => {
  it('draws only the owner trigger, named Change budgets', () => {
    renderFoot('owner', { collapsed: true });

    expect(screen.getByTestId(TEST_IDS.memberBudgetTrigger)).toHaveAccessibleName('Change budgets');
    expect(screen.queryByRole('group', { name: 'Budgets' })).not.toBeInTheDocument();
  });

  it('draws only the member trigger, named See budgets', () => {
    renderFoot('read', { collapsed: true });

    expect(screen.getByTestId(TEST_IDS.memberBudgetTrigger)).toHaveAccessibleName('See budgets');
  });

  it('calls the handler from the rail trigger', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    renderFoot('owner', { collapsed: true, onClick });

    await user.click(screen.getByTestId(TEST_IDS.memberBudgetTrigger));

    expect(onClick).toHaveBeenCalledOnce();
  });
});
