import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { NewChatButton } from './new-chat-button';

const mockNavigate = vi.fn();
const mockLocation = { pathname: '/chat/some-id' };
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => mockLocation,
}));

const mockUseIsMobile = vi.fn(() => false);
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: () => mockUseIsMobile(),
  };
});

describe('NewChatButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
    mockLocation.pathname = '/chat/some-id';
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
  });

  describe('expanded state', () => {
    it('renders a link with "New Chat" text when expanded', () => {
      render(<NewChatButton />);
      expect(screen.getByRole('link', { name: /new chat/i })).toBeInTheDocument();
    });

    it('points the link at /chat so middle-click opens a new tab', () => {
      render(<NewChatButton />);
      expect(screen.getByRole('link')).toHaveAttribute('href', '/chat');
    });

    it('renders plus icon', () => {
      render(<NewChatButton />);
      expect(screen.getByTestId(TEST_IDS.plusIcon)).toBeInTheDocument();
    });

    it('navigates to /chat on plain click', async () => {
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });

    it('prevents default full navigation on plain click', () => {
      render(<NewChatButton />);
      const link = screen.getByRole('link');
      const clickEvent = createEvent.click(link);

      fireEvent(link, clickEvent);

      expect(clickEvent.defaultPrevented).toBe(true);
    });

    it('has full width styling when expanded', () => {
      render(<NewChatButton />);
      expect(screen.getByRole('link')).toHaveClass('w-full');
    });
  });

  describe('new-tab clicks', () => {
    it('does not SPA-navigate on cmd/meta-click', () => {
      render(<NewChatButton />);

      fireEvent.click(screen.getByRole('link'), { metaKey: true });
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('does not prevent default on cmd/meta-click', () => {
      render(<NewChatButton />);
      const link = screen.getByRole('link');
      const clickEvent = createEvent.click(link, { metaKey: true });

      fireEvent(link, clickEvent);

      expect(clickEvent.defaultPrevented).toBe(false);
    });

    it('does not SPA-navigate on ctrl-click', () => {
      render(<NewChatButton />);

      fireEvent.click(screen.getByRole('link'), { ctrlKey: true });
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('mobile sidebar close behavior', () => {
    beforeEach(() => {
      mockUseIsMobile.mockReturnValue(true);
      mockLocation.pathname = '/chat';
      useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: true });
    });

    it('closes mobile sidebar without navigating when already on /chat', async () => {
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('navigates normally on mobile when not on /chat', async () => {
      mockLocation.pathname = '/chat/some-id';
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });

    it('navigates normally on desktop even when on /chat', async () => {
      mockUseIsMobile.mockReturnValue(false);
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('renders icon-only link when collapsed', () => {
      render(<NewChatButton />);
      const link = screen.getByRole('link');
      expect(link).toBeInTheDocument();
      expect(screen.queryByText(/new chat/i)).not.toBeInTheDocument();
    });

    it('has icon size styling when collapsed', () => {
      render(<NewChatButton />);
      const link = screen.getByRole('link');
      expect(link).toHaveClass('h-9');
      expect(link).toHaveClass('w-9');
    });

    it('still navigates to /chat on plain click when collapsed', async () => {
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('link'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
  });
});
