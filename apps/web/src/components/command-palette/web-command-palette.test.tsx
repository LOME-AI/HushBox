import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HOUR_MS, TEST_LOCAL_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import { ROUTES, TEST_IDS, type ConversationListItem } from '@hushbox/shared';
import { useAuthStore } from '@/lib/auth/auth';
import { APP_ACTIONS, type AppActionContext } from '@/lib/app-actions';
import { usePaletteStore } from '@/stores/ui/palette';
import { useDecryptedConversations } from '@/hooks/chat/chat';
import { WebCommandPalette } from './web-command-palette';

/** Midday on the reference day, so an update a few hours earlier is still Today in every zone. */
const NOW = TEST_LOCAL_DAY_START + 12 * HOUR_MS;

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: vi.fn(),
}));

function listItem(
  id: string,
  title: string,
  hoursAgo: number,
  memberCount = 1
): ConversationListItem {
  return {
    id,
    title,
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 1,
    createdAt: isoAt(NOW - 100 * HOUR_MS),
    updatedAt: isoAt(NOW - hoursAgo * HOUR_MS),
    accepted: true,
    invitedByUsername: null,
    privilege: 'owner',
    muted: false,
    pinned: false,
    lastReadSeq: 0,
    memberCount,
  };
}

const CONVERSATIONS: ConversationListItem[] = [
  listItem('c-1', 'Merging duplicate contacts', 1),
  listItem('c-2', 'Trip to Lisbon', 2, 3),
  listItem('c-3', 'Garden layout', 3),
  listItem('c-4', 'Tax questions', 4),
];

function useConversationsReturning(
  data?: ConversationListItem[]
): ReturnType<typeof useDecryptedConversations> {
  return {
    data,
    isLoading: false,
    fetchNextPage: vi.fn<() => void>(),
    hasNextPage: false,
    isFetchingNextPage: false,
  };
}

interface ContextSpies {
  context: AppActionContext;
  /** What the context's `navigate` was called with; the router's type is generic, so no mock is one. */
  navigate: Mock<(options: unknown) => void>;
  closeDrawer: Mock<AppActionContext['closeDrawer']>;
}

function makeContext(): ContextSpies {
  const navigateSpy = vi.fn<(options: unknown) => void>();
  const navigate: AppActionContext['navigate'] = (options) => {
    navigateSpy(options);
    return Promise.resolve();
  };
  const closeDrawer = vi.fn<AppActionContext['closeDrawer']>();
  const openFeedback = vi.fn<AppActionContext['openFeedback']>();
  return { context: { navigate, closeDrawer, openFeedback }, navigate: navigateSpy, closeDrawer };
}

function signIn(): void {
  useAuthStore.getState().setUser({
    id: 'user-1',
    email: 'reader@hushbox.ai',
    username: 'reader',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
  });
  useAuthStore.getState().setLoading(false);
}

function sectionLabels(heading: string): string[] {
  const section = screen.getByRole('region', { name: heading });
  return within(section)
    .getAllByRole('option')
    .map((option) => option.textContent);
}

function option(name: RegExp): HTMLElement {
  return screen.getByRole('option', { name });
}

beforeEach(() => {
  // Only the clock is faked, so the user-event timers still run.
  freezeClock(NOW, { toFake: ['Date'] });
  vi.mocked(useDecryptedConversations).mockReturnValue(useConversationsReturning(CONVERSATIONS));
  usePaletteStore.setState({ open: false });
  useAuthStore.getState().setUser(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WebCommandPalette', () => {
  it('stays closed until the palette store opens', () => {
    render(<WebCommandPalette context={makeContext().context} />);
    expect(screen.queryByTestId(TEST_IDS.commandPalette)).toBeNull();
  });

  it('opens when the palette store opens', () => {
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    expect(screen.getByTestId(TEST_IDS.commandPalette)).toBeInTheDocument();
  });

  it('names its field for what it searches', () => {
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    expect(
      screen.getByRole('combobox', { name: 'Search chats, actions, settings' })
    ).toBeInTheDocument();
  });

  it('lists the three most recent conversations with their meta for an account', () => {
    signIn();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    expect(sectionLabels('Recent')).toEqual([
      expect.stringContaining('Merging duplicate contacts'),
      expect.stringContaining('Trip to Lisbon'),
      expect.stringContaining('Garden layout'),
    ]);
  });

  it('reads Today for a solo conversation updated today', () => {
    signIn();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    expect(option(/Merging duplicate contacts/)).toHaveTextContent('Today');
  });

  it('reads the member count for a group conversation', () => {
    signIn();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    expect(option(/Trip to Lisbon/)).toHaveTextContent('3 members');
  });

  it('draws the New chat shortcut as keycaps on its row', () => {
    signIn();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    const caps = within(option(/New chat/)).getAllByText(/^(Ctrl|⇧|O)$/);
    expect(caps.map((cap) => cap.textContent)).toEqual(['Ctrl', '⇧', 'O']);
  });

  it('draws the Settings shortcut as keycaps on its row', () => {
    signIn();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    const caps = within(option(/Settings/)).getAllByText(/^(Ctrl|,)$/);
    expect(caps.map((cap) => cap.textContent)).toEqual(['Ctrl', ',']);
  });

  it('offers a visitor without a session neither Recent nor the account items', () => {
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    expect(screen.getAllByRole('option').map((item) => item.textContent)).toEqual([
      expect.stringContaining('New chat'),
      expect.stringContaining('Accessibility'),
    ]);
  });

  it('lists no conversation while the list has not loaded', () => {
    signIn();
    vi.mocked(useDecryptedConversations).mockReturnValue(useConversationsReturning());
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    expect(screen.queryByRole('region', { name: 'Recent' })).toBeNull();
  });

  it('runs a chosen item through its app action', async () => {
    signIn();
    const run = vi.spyOn(APP_ACTIONS.addCredit, 'run');
    const { context } = makeContext();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={context} />);
    await userEvent.click(option(/Add credit/));
    expect(run).toHaveBeenCalledWith(context);
  });

  it('closes the palette once an item runs', async () => {
    signIn();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    await userEvent.click(option(/Usage/));
    expect(usePaletteStore.getState().open).toBe(false);
  });

  it('opens the accessibility page from Go to', async () => {
    const { context, navigate } = makeContext();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={context} />);
    await userEvent.click(option(/Accessibility/));
    expect(navigate).toHaveBeenCalledWith({ to: ROUTES.ACCESSIBILITY });
  });

  it('opens a chosen conversation', async () => {
    signIn();
    const { context, navigate } = makeContext();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={context} />);
    await userEvent.click(option(/Trip to Lisbon/));
    expect(navigate).toHaveBeenCalledWith({
      to: ROUTES.CHAT_ID,
      params: { id: 'c-2' },
      search: { fork: undefined },
    });
  });

  it('closes the phone drawer when it opens a conversation', async () => {
    signIn();
    const { context, closeDrawer } = makeContext();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={context} />);
    await userEvent.click(option(/Trip to Lisbon/));
    expect(closeDrawer).toHaveBeenCalled();
  });

  it('runs the item a typed query leaves on top when Enter is pressed', async () => {
    signIn();
    const { context, navigate } = makeContext();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={context} />);
    await userEvent.type(screen.getByRole('combobox'), 'usage{Enter}');
    expect(navigate).toHaveBeenCalledWith({ to: ROUTES.USAGE });
  });

  it('finds a loaded conversation that Recent does not show', async () => {
    signIn();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    await userEvent.type(screen.getByRole('combobox'), 'tax');
    expect(screen.getAllByRole('option').map((item) => item.textContent)).toEqual([
      expect.stringContaining('Tax questions'),
    ]);
  });

  it('says what search covers when nothing matches', async () => {
    signIn();
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByText(/chats loaded in your sidebar/)).toBeInTheDocument();
  });

  it('closes through the store when dismissed', async () => {
    usePaletteStore.setState({ open: true });
    render(<WebCommandPalette context={makeContext().context} />);
    await userEvent.keyboard('{Escape}');
    expect(usePaletteStore.getState().open).toBe(false);
  });
});
