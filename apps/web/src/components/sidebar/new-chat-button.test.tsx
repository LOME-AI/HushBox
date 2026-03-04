import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewChatButton } from './new-chat-button';
import { useUIStore } from '@/stores/ui';

// Mock useNavigate and useLocation
const mockNavigate = vi.fn();
const mockLocation = { pathname: '/chat/some-id' };
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useLocation: () => mockLocation,
}));

// Mock useIsMobile
const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

describe('NewChatButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
  });

  describe('expanded state', () => {
    it('renders button with "New Chat" text when expanded', () => {
      render(<NewChatButton />);
      expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
    });

    it('renders plus icon', () => {
      render(<NewChatButton />);
      expect(screen.getByTestId('plus-icon')).toBeInTheDocument();
    });

    it('navigates to /chat on click', async () => {
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('button'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });

    it('has full width styling when expanded', () => {
      render(<NewChatButton />);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('w-full');
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

      await user.click(screen.getByRole('button'));
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
    });

    it('navigates normally on mobile when not on /chat', async () => {
      mockLocation.pathname = '/chat/some-id';
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('button'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });

    it('navigates normally on desktop even when on /chat', async () => {
      mockUseIsMobile.mockReturnValue(false);
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('button'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('renders icon-only button when collapsed', () => {
      render(<NewChatButton />);
      const button = screen.getByRole('button');
      expect(button).toBeInTheDocument();
      expect(screen.queryByText(/new chat/i)).not.toBeInTheDocument();
    });

    it('has icon size styling when collapsed', () => {
      render(<NewChatButton />);
      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-9');
      expect(button).toHaveClass('w-9');
    });

    it('still navigates to /chat on click when collapsed', async () => {
      const user = userEvent.setup();
      render(<NewChatButton />);

      await user.click(screen.getByRole('button'));
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
  });
});
