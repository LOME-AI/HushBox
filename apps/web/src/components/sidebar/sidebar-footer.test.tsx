import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SidebarFooter } from './sidebar-footer';
import { useUIStore } from '@/stores/ui';

describe('SidebarFooter', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true });
  });

  describe('expanded state', () => {
    it('renders placeholder text when expanded', () => {
      render(<SidebarFooter />);
      expect(screen.getByText(/user menu/i)).toBeInTheDocument();
    });

    it('has muted text styling for placeholder', () => {
      render(<SidebarFooter />);
      const placeholder = screen.getByText(/user menu/i);
      expect(placeholder).toHaveClass('text-sm');
    });
  });

  describe('collapsed state (rail mode)', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('does not render placeholder text when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.queryByText(/user menu/i)).not.toBeInTheDocument();
    });

    it('renders user icon when collapsed', () => {
      render(<SidebarFooter />);
      expect(screen.getByTestId('user-icon')).toBeInTheDocument();
    });

    it('has justify-center layout when collapsed', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('justify-center');
    });
  });

  describe('common styles', () => {
    it('has border at top', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('border-t');
    });

    it('uses sidebar border color', () => {
      render(<SidebarFooter />);
      const footer = screen.getByTestId('sidebar-footer');
      expect(footer).toHaveClass('border-sidebar-border');
    });
  });
});
