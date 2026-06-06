import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui';
import { ProjectsLink } from './projects-link';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className} data-testid="projects-link">
      {children}
    </a>
  ),
}));

describe('ProjectsLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true });
  });

  describe('expanded state', () => {
    it('renders link with "Projects" text when expanded', () => {
      render(<ProjectsLink />);
      expect(screen.getByText('Projects')).toBeInTheDocument();
    });

    it('links to /projects page', () => {
      render(<ProjectsLink />);
      const link = screen.getByTestId(TEST_IDS.projectsLink);
      expect(link).toHaveAttribute('href', '/projects');
    });

    it('renders folder icon', () => {
      render(<ProjectsLink />);
      expect(screen.getByTestId(TEST_IDS.folderIcon)).toBeInTheDocument();
    });
  });

  describe('collapsed state', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('shows only icon when collapsed', () => {
      render(<ProjectsLink />);
      expect(screen.getByTestId(TEST_IDS.folderIcon)).toBeInTheDocument();
      expect(screen.queryByText('Projects')).not.toBeInTheDocument();
    });
  });
});
