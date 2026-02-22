import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NewChatButton } from './new-chat-button';
import { useUIStore } from '@/stores/ui';

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
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
