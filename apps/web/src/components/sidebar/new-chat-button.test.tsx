import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui/ui';
import { useRightPane } from '@/stores/ui/right-pane';
import { NewChatButton } from './new-chat-button';

const mockNavigate = vi.fn();
const mockLocation = { pathname: '/chat/some-id' };
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => mockLocation,
}));

const mockDrawer = { isDrawer: false, close: vi.fn() };
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useSidebarDrawer: () => mockDrawer,
  };
});

describe('NewChatButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRightPane.setState({ active: null });
    mockDrawer.isDrawer = false;
    mockLocation.pathname = '/chat/some-id';
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
  });

  describe('expanded', () => {
    it('renders a link named "New chat"', () => {
      render(<NewChatButton />);
      expect(screen.getByRole('link', { name: 'New chat' })).toBeInTheDocument();
    });

    it('points the link at /chat so a middle click opens a new tab', () => {
      render(<NewChatButton />);
      expect(screen.getByRole('link')).toHaveAttribute('href', '/chat');
    });

    it('shows "New chat" as visible text', () => {
      render(<NewChatButton />);
      expect(screen.getByText('New chat')).toBeInTheDocument();
    });

    it('draws the new-chat shortcut hint', () => {
      render(<NewChatButton />);
      expect(screen.getByText('Ctrl ⇧ O').tagName).toBe('KBD');
    });

    it('carries the new-chat row test id', () => {
      render(<NewChatButton />);
      expect(screen.getByTestId(TEST_IDS.newChatRow)).toBe(screen.getByRole('link'));
    });

    it('navigates to /chat on a plain click', async () => {
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });

    it('prevents the full page load on a plain click', () => {
      render(<NewChatButton />);
      const link = screen.getByRole('link');
      const clickEvent = createEvent.click(link);

      fireEvent(link, clickEvent);

      expect(clickEvent.defaultPrevented).toBe(true);
    });
  });

  describe('modified clicks pass through to the browser', () => {
    it.each([
      ['meta', { metaKey: true }],
      ['ctrl', { ctrlKey: true }],
      ['shift', { shiftKey: true }],
      ['middle-button', { button: 1 }],
    ])('does not navigate in the app on a %s click', (_name, init) => {
      render(<NewChatButton />);

      fireEvent.click(screen.getByRole('link'), init);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it.each([
      ['meta', { metaKey: true }],
      ['ctrl', { ctrlKey: true }],
      ['shift', { shiftKey: true }],
      ['middle-button', { button: 1 }],
    ])('keeps the default action on a %s click', (_name, init) => {
      render(<NewChatButton />);
      const link = screen.getByRole('link');
      const clickEvent = createEvent.click(link, init);

      fireEvent(link, clickEvent);

      expect(clickEvent.defaultPrevented).toBe(false);
    });

    it('leaves the phone drawer open on a modified click', () => {
      mockDrawer.isDrawer = true;
      render(<NewChatButton />);

      fireEvent.click(screen.getByRole('link'), { ctrlKey: true });
      expect(mockDrawer.close).not.toHaveBeenCalled();
    });
  });

  describe('in the phone drawer', () => {
    beforeEach(() => {
      mockDrawer.isDrawer = true;
    });

    it('closes the drawer without navigating when already on /chat', async () => {
      mockLocation.pathname = '/chat';
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockDrawer.close).toHaveBeenCalledTimes(1);
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('closes the drawer when navigating from a conversation', async () => {
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockDrawer.close).toHaveBeenCalledTimes(1);
    });

    it('navigates to /chat from a conversation', async () => {
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
  });

  it('navigates on the desktop panel even when already on /chat', async () => {
    mockLocation.pathname = '/chat';
    const user = userEvent.setup();
    render(<NewChatButton />);

    await user.click(screen.getByRole('link'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
  });

  describe('beside a docked right pane', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: true });
      useRightPane.setState({ active: 'members' });
    });

    it('shows the icon alone while the saved choice is open', () => {
      render(<NewChatButton />);
      expect(screen.queryByText('New chat')).not.toBeInTheDocument();
    });
  });

  describe('collapsed to the rail', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('keeps the name "New chat"', () => {
      render(<NewChatButton />);
      expect(screen.getByRole('link', { name: 'New chat' })).toBeInTheDocument();
    });

    it('shows the icon alone', () => {
      render(<NewChatButton />);
      expect(screen.queryByText('New chat')).not.toBeInTheDocument();
    });

    it('still navigates to /chat on a plain click', async () => {
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
  });
});
