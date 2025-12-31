import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarHeader } from './sidebar-header';
import { useUIStore } from '@/stores/ui';

// Mock TanStack Router's Link component
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

describe('SidebarHeader', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true });
  });

  describe('expanded state', () => {
    it('renders LOME text when expanded', () => {
      render(<SidebarHeader />);
      expect(screen.getByText('LOME')).toBeInTheDocument();
    });

    it('renders LOME text with primary color and bold styling', () => {
      render(<SidebarHeader />);
      const logo = screen.getByText('LOME');
      expect(logo).toHaveClass('text-primary');
      expect(logo).toHaveClass('font-bold');
    });

    it('renders logo as a link to /chat when expanded', () => {
      render(<SidebarHeader />);
      const link = screen.getByRole('link', { name: /lome/i });
      expect(link).toHaveAttribute('href', '/chat');
    });

    it('renders collapse toggle button when expanded', () => {
      render(<SidebarHeader />);
      expect(screen.getByRole('button', { name: /collapse sidebar/i })).toBeInTheDocument();
    });

    it('calls toggleSidebar when collapse button is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarHeader />);

      const button = screen.getByRole('button', { name: /collapse sidebar/i });
      await user.click(button);

      expect(useUIStore.getState().sidebarOpen).toBe(false);
    });

    it('has justify-between layout when expanded', () => {
      render(<SidebarHeader />);
      const header = screen.getByTestId('sidebar-header');
      expect(header).toHaveClass('justify-between');
    });
  });

  describe('collapsed state (rail mode)', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('does not render LOME text when collapsed', () => {
      render(<SidebarHeader />);
      expect(screen.queryByText('LOME')).not.toBeInTheDocument();
    });

    it('renders expand button when collapsed', () => {
      render(<SidebarHeader />);
      expect(screen.getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
    });

    it('calls toggleSidebar when expand button is clicked', async () => {
      const user = userEvent.setup();
      render(<SidebarHeader />);

      const button = screen.getByRole('button', { name: /expand sidebar/i });
      await user.click(button);

      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });

    it('has justify-center layout when collapsed', () => {
      render(<SidebarHeader />);
      const header = screen.getByTestId('sidebar-header');
      expect(header).toHaveClass('justify-center');
    });
  });

  describe('common styles', () => {
    it('has border at bottom', () => {
      render(<SidebarHeader />);
      const header = screen.getByTestId('sidebar-header');
      expect(header).toHaveClass('border-b');
    });

    it('uses sidebar border color', () => {
      render(<SidebarHeader />);
      const header = screen.getByTestId('sidebar-header');
      expect(header).toHaveClass('border-sidebar-border');
    });
  });
});
