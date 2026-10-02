import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { BranchSwitcher, type BranchSwitcherProps } from '@/components/chat/layout/branch-switcher';
import { RenameConversationDialog } from '@/components/sidebar/rename-conversation-dialog';
import { DeleteConversationDialog } from '@/components/sidebar/delete-conversation-dialog';
import { branchSummaries, type BranchFork, type BranchSummary } from '@/lib/chat/branch-summary';
import type { Message } from '@/lib/api/api';

const TWO_BRANCHES: readonly BranchSummary[] = [
  {
    forkId: 'main',
    name: 'Main',
    firstMessage: 'Show me the Python.',
    forkPointOrdinal: 2,
    forkPointId: 'p2',
  },
  {
    forkId: 'f1',
    name: 'SQL version',
    firstMessage: 'One SQL query?',
    forkPointOrdinal: 2,
    forkPointId: 'p2',
  },
];

function renderSwitcher(overrides: Partial<BranchSwitcherProps> = {}): BranchSwitcherProps {
  const props: BranchSwitcherProps = {
    branches: TWO_BRANCHES,
    currentForkId: 'f1',
    onSelect: vi.fn<(forkId: string) => void>(),
    onRename: vi.fn<(forkId: string, currentName: string) => void>(),
    onDelete: vi.fn<(forkId: string) => void>(),
    ...overrides,
  };
  render(<BranchSwitcher {...props} />);
  return props;
}

function nth<T>(list: readonly T[], index: number): T {
  const item = list[index];
  if (item === undefined) throw new Error(`no item at ${String(index)}`);
  return item;
}

function message(id: string, role: Message['role'], parentMessageId: string | null): Message {
  return {
    id,
    conversationId: 'conv-1',
    role,
    content: `${id} text`,
    createdAt: isoAt(TEST_DAY_START),
    parentMessageId,
  };
}

function fork(id: string, name: string, tipMessageId: string): BranchFork {
  return { id, name, tipMessageId };
}

/** The page's dialogs, wired as the conversation page wires them to the switcher. */
function SwitcherWithDialogs(): React.JSX.Element {
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [value, setValue] = React.useState('');
  return (
    <>
      <BranchSwitcher
        branches={TWO_BRANCHES}
        currentForkId="f1"
        onSelect={vi.fn<(forkId: string) => void>()}
        onRename={(forkId, name) => {
          setRenaming(forkId);
          setValue(name);
        }}
        onDelete={setDeleting}
      />
      <RenameConversationDialog
        open={renaming !== null}
        onOpenChange={(open) => {
          if (!open) setRenaming(null);
        }}
        value={value}
        onValueChange={setValue}
        onConfirm={() => Promise.resolve()}
      />
      <DeleteConversationDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="SQL version"
        onConfirm={() => Promise.resolve()}
      />
    </>
  );
}

async function openSwitcher(): Promise<HTMLElement> {
  await userEvent.setup().click(screen.getByTestId(TEST_IDS.branchSwitcher));
  return screen.findByTestId(TEST_IDS.branchSwitcherMenu);
}

describe('BranchSwitcher', () => {
  it('draws nothing while the conversation has one branch', () => {
    renderSwitcher({ branches: TWO_BRANCHES.slice(0, 1) });
    expect(screen.queryByTestId(TEST_IDS.branchSwitcher)).not.toBeInTheDocument();
  });

  it('names the current branch on its trigger', () => {
    renderSwitcher();
    expect(screen.getByTestId(TEST_IDS.branchSwitcher)).toHaveAccessibleName(
      'Branch: SQL version, 2 branches'
    );
  });

  it('shows the current branch name as the trigger text', () => {
    renderSwitcher();
    expect(screen.getByTestId(TEST_IDS.branchSwitcher)).toHaveTextContent('SQL version');
  });

  it('names its trigger Branches while no branch is current yet', () => {
    renderSwitcher({ currentForkId: null });
    const trigger = screen.getByTestId(TEST_IDS.branchSwitcher);
    expect(trigger).toHaveAccessibleName('Branches: 2');
    expect(trigger).toHaveTextContent('Branches');
  });

  it('counts each branch once in its trigger name, however many fork points list it', () => {
    renderSwitcher({
      branches: [
        ...TWO_BRANCHES,
        { ...nth(TWO_BRANCHES, 1), forkPointId: 'p3', forkPointOrdinal: 3 },
      ],
    });
    expect(screen.getByTestId(TEST_IDS.branchSwitcher)).toHaveAccessibleName(
      'Branch: SQL version, 2 branches'
    );
  });

  it('shows its icon alone while the header is narrower than its label key', () => {
    renderSwitcher();
    const trigger = screen.getByTestId(TEST_IDS.branchSwitcher);
    const iconOnly = '@max-header-branch-label/app-header:hidden';
    expect(within(trigger).getByText('SQL version')).toHaveClass(iconOnly);
    expect(trigger.querySelector('[data-branch-chevron]')).toHaveClass(iconOnly);
    expect(trigger.querySelector('[data-branch-icon]')).not.toHaveClass(iconOnly);
  });

  it('opens a panel named Branches', async () => {
    renderSwitcher();
    const panel = await openSwitcher();
    expect(panel).toHaveAccessibleName('Branches');
  });

  it('draws a row per branch', async () => {
    renderSwitcher();
    const panel = await openSwitcher();
    expect(within(panel).getByTestId(TEST_ID_BUILDERS.branchRow('main'))).toBeInTheDocument();
    expect(within(panel).getByTestId(TEST_ID_BUILDERS.branchRow('f1'))).toBeInTheDocument();
  });

  it('names each row by its branch and describes it by its first message', async () => {
    renderSwitcher();
    const panel = await openSwitcher();
    const pick = within(panel).getByRole('button', { name: 'Main' });
    expect(pick).toHaveAccessibleDescription('Show me the Python.');
  });

  it('labels one fork point with its branch count and question', async () => {
    renderSwitcher();
    const panel = await openSwitcher();
    expect(within(panel).getByText('2 branches from your second question')).toBeInTheDocument();
  });

  it('labels each of two fork points in thread order, each before its branches', async () => {
    renderSwitcher({
      branches: [
        { forkId: 'f1', name: 'Fork 1', firstMessage: 'a', forkPointOrdinal: 1, forkPointId: 'p1' },
        { forkId: 'main', name: 'Main', firstMessage: 'b', forkPointOrdinal: 3, forkPointId: 'p3' },
        { forkId: 'f2', name: 'Fork 2', firstMessage: 'c', forkPointOrdinal: 3, forkPointId: 'p3' },
      ],
      currentForkId: 'main',
    });
    const panel = await openSwitcher();
    const groups = within(panel).getAllByRole('group');
    expect(groups).toHaveLength(2);
    expect(nth(groups, 0)).toHaveAccessibleName('1 branch from your first question');
    expect(
      within(nth(groups, 0)).getByTestId(TEST_ID_BUILDERS.branchRow('f1'))
    ).toBeInTheDocument();
    expect(nth(groups, 1)).toHaveAccessibleName('2 branches from your third question');
    expect(
      within(nth(groups, 1)).getByTestId(TEST_ID_BUILDERS.branchRow('f2'))
    ).toBeInTheDocument();
  });

  it.each([
    [11, '11th'],
    [12, '12th'],
    [21, '21st'],
    [22, '22nd'],
    [23, '23rd'],
    [10, 'tenth'],
  ])('writes question %i as "%s"', async (ordinal, word) => {
    renderSwitcher({
      branches: TWO_BRANCHES.map((b) => ({ ...b, forkPointOrdinal: ordinal })),
    });
    const panel = await openSwitcher();
    expect(within(panel).getByText(`2 branches from your ${word} question`)).toBeInTheDocument();
  });

  it('lists branches with no known fork point without a label', async () => {
    renderSwitcher({
      branches: TWO_BRANCHES.map((b) => ({ ...b, forkPointOrdinal: 0, forkPointId: null })),
    });
    const panel = await openSwitcher();
    expect(within(panel).queryByText(/branches from your/)).not.toBeInTheDocument();
    expect(within(panel).getByTestId(TEST_ID_BUILDERS.branchRow('main'))).toBeInTheDocument();
  });

  it('draws no description for a branch with nothing after its fork point', async () => {
    renderSwitcher({
      branches: [nth(TWO_BRANCHES, 0), { ...nth(TWO_BRANCHES, 1), firstMessage: '' }],
    });
    const panel = await openSwitcher();
    expect(
      within(panel).getByRole('button', { name: 'SQL version' })
    ).not.toHaveAccessibleDescription();
  });

  describe('the current row', () => {
    it('marks the current branch as current', async () => {
      renderSwitcher();
      const panel = await openSwitcher();
      expect(within(panel).getByRole('button', { name: 'SQL version' })).toHaveAttribute(
        'aria-current',
        'true'
      );
    });

    it('leaves every other branch unmarked', async () => {
      renderSwitcher();
      const panel = await openSwitcher();
      expect(within(panel).getByRole('button', { name: 'Main' })).not.toHaveAttribute(
        'aria-current'
      );
    });

    it('draws the check on the current row only', async () => {
      renderSwitcher();
      const panel = await openSwitcher();
      const current = within(panel).getByTestId(TEST_ID_BUILDERS.branchRow('f1'));
      const other = within(panel).getByTestId(TEST_ID_BUILDERS.branchRow('main'));
      expect(current.querySelector('[data-branch-check]')).not.toBeNull();
      expect(other.querySelector('[data-branch-check]')).toBeNull();
    });

    it('lets the current row description take a third line under the narrow container', async () => {
      renderSwitcher();
      const panel = await openSwitcher();
      expect(within(panel).getByText('One SQL query?')).toHaveClass(
        '@max-branch-current-3line/branches:line-clamp-3'
      );
    });

    it('keeps every other row description to two lines', async () => {
      renderSwitcher();
      const panel = await openSwitcher();
      const description = within(panel).getByText('Show me the Python.');
      expect(description).toHaveClass('line-clamp-2');
      expect(description).not.toHaveClass('@max-branch-current-3line/branches:line-clamp-3');
    });
  });

  describe('labels from the message tree', () => {
    it('labels three branches parting after the first answer as from the second question', async () => {
      const messages = [
        message('u1', 'user', null),
        message('a1', 'assistant', 'u1'),
        message('main-u2', 'user', 'a1'),
        message('f1-u2', 'user', 'a1'),
        message('f2-u2', 'user', 'a1'),
      ];
      renderSwitcher({
        branches: branchSummaries(messages, [
          fork('main', 'Main', 'main-u2'),
          fork('f1', 'Standard library only', 'f1-u2'),
          fork('f2', 'SQL version', 'f2-u2'),
        ]),
        currentForkId: 'f2',
      });
      const panel = await openSwitcher();
      expect(within(panel).getByText('3 branches from your second question')).toBeInTheDocument();
    });

    it('lists a branch under every fork point it parts at', async () => {
      const messages = [
        message('u1', 'user', null),
        message('a1', 'assistant', 'u1'),
        message('u2', 'user', 'a1'),
        message('a2', 'assistant', 'u2'),
        message('u3', 'user', 'a2'),
        message('f1-u2', 'user', 'a1'),
        message('f2-u3', 'user', 'a2'),
      ];
      renderSwitcher({
        branches: branchSummaries(messages, [
          fork('main', 'Main', 'u3'),
          fork('f1', 'Fork 1', 'f1-u2'),
          fork('f2', 'Fork 2', 'f2-u3'),
        ]),
        currentForkId: 'main',
      });
      const panel = await openSwitcher();
      const groups = within(panel).getAllByRole('group');
      expect(groups).toHaveLength(2);
      expect(nth(groups, 0)).toHaveAccessibleName('3 branches from your second question');
      expect(nth(groups, 1)).toHaveAccessibleName('2 branches from your third question');
      expect(
        within(nth(groups, 0)).getByTestId(TEST_ID_BUILDERS.branchRow('main'))
      ).toBeInTheDocument();
      expect(
        within(nth(groups, 1)).getByTestId(TEST_ID_BUILDERS.branchRow('main'))
      ).toBeInTheDocument();
    });
  });

  describe('focus after the dialogs', () => {
    async function openWithKeyboard(
      user: ReturnType<typeof userEvent.setup>
    ): Promise<HTMLElement> {
      screen.getByTestId(TEST_IDS.branchSwitcher).focus();
      await user.keyboard('{Enter}');
      return screen.findByTestId(TEST_IDS.branchSwitcherMenu);
    }

    it('returns to the switcher trigger when the rename dialog is cancelled', async () => {
      const user = userEvent.setup();
      render(<SwitcherWithDialogs />);
      const panel = await openWithKeyboard(user);
      within(panel).getByTestId(TEST_ID_BUILDERS.branchRename('main')).focus();
      await user.keyboard('{Enter}');
      await screen.findByText('Rename conversation');
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByText('Rename conversation')).not.toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.branchSwitcher)).toHaveFocus();
      });
    });

    it('returns to the switcher trigger when the delete dialog is confirmed', async () => {
      const user = userEvent.setup();
      render(<SwitcherWithDialogs />);
      const panel = await openWithKeyboard(user);
      within(panel).getByTestId(TEST_ID_BUILDERS.branchDelete('f1')).focus();
      await user.keyboard('{Enter}');
      await screen.findByText('Delete conversation?');
      screen.getByTestId(TEST_IDS.confirmDeleteButton).focus();
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(screen.queryByText('Delete conversation?')).not.toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.branchSwitcher)).toHaveFocus();
      });
    });
  });

  describe('the handlers', () => {
    it('switches to a branch picked from its row', async () => {
      const props = renderSwitcher();
      const panel = await openSwitcher();
      await userEvent.setup().click(within(panel).getByRole('button', { name: 'Main' }));
      expect(props.onSelect).toHaveBeenCalledWith('main');
    });

    it('closes once a branch is picked', async () => {
      renderSwitcher();
      const panel = await openSwitcher();
      await userEvent.setup().click(within(panel).getByRole('button', { name: 'Main' }));
      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.branchSwitcherMenu)).not.toBeInTheDocument();
      });
    });

    it('does not switch when the current branch is picked', async () => {
      const props = renderSwitcher();
      const panel = await openSwitcher();
      await userEvent.setup().click(within(panel).getByRole('button', { name: 'SQL version' }));
      expect(props.onSelect).not.toHaveBeenCalled();
    });

    it('asks to rename a branch with its current name', async () => {
      const props = renderSwitcher();
      const panel = await openSwitcher();
      await userEvent
        .setup()
        .click(within(panel).getByTestId(TEST_ID_BUILDERS.branchRename('main')));
      expect(props.onRename).toHaveBeenCalledWith('main', 'Main');
    });

    it('names the rename control after its branch', async () => {
      renderSwitcher();
      const panel = await openSwitcher();
      expect(within(panel).getByTestId(TEST_ID_BUILDERS.branchRename('main'))).toHaveAccessibleName(
        'Rename Main'
      );
    });

    it('asks to delete a branch', async () => {
      const props = renderSwitcher();
      const panel = await openSwitcher();
      await userEvent.setup().click(within(panel).getByTestId(TEST_ID_BUILDERS.branchDelete('f1')));
      expect(props.onDelete).toHaveBeenCalledWith('f1');
    });

    it('names the delete control after its branch', async () => {
      renderSwitcher();
      const panel = await openSwitcher();
      expect(within(panel).getByTestId(TEST_ID_BUILDERS.branchDelete('f1'))).toHaveAccessibleName(
        'Delete SQL version'
      );
    });

    it('closes before a rename or delete dialog opens', async () => {
      renderSwitcher();
      const panel = await openSwitcher();
      await userEvent.setup().click(within(panel).getByTestId(TEST_ID_BUILDERS.branchDelete('f1')));
      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.branchSwitcherMenu)).not.toBeInTheDocument();
      });
    });
  });
});
