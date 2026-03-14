import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ForkTabs } from './fork-tabs';

interface Fork {
  id: string;
  conversationId: string;
  name: string;
  tipMessageId: string | null;
  createdAt: string;
}

function createFork(overrides: Partial<Fork> = {}): Fork {
  return {
    id: 'fork-1',
    conversationId: 'conv-1',
    name: 'Main',
    tipMessageId: 'msg-1',
    createdAt: '2026-03-03',
    ...overrides,
  };
}

describe('ForkTabs', () => {
  const defaultForks: Fork[] = [
    createFork({ id: 'fork-main', name: 'Main', tipMessageId: 'msg-5' }),
    createFork({ id: 'fork-1', name: 'Fork 1', tipMessageId: 'msg-3' }),
  ];

  const defaultProps = {
    forks: defaultForks,
    activeForkId: 'fork-main',
    onForkSelect: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when fewer than 2 forks', () => {
    const { container } = render(<ForkTabs {...defaultProps} forks={[createFork()]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when forks array is empty', () => {
    const { container } = render(<ForkTabs {...defaultProps} forks={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders tab buttons for each fork', () => {
    render(<ForkTabs {...defaultProps} />);
    expect(screen.getByRole('tab', { name: /Main/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Fork 1/ })).toBeInTheDocument();
  });

  it('marks the active tab with aria-selected', () => {
    render(<ForkTabs {...defaultProps} activeForkId="fork-main" />);
    expect(screen.getByRole('tab', { name: /Main/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Fork 1/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onForkSelect when clicking an inactive tab', async () => {
    const user = userEvent.setup();
    render(<ForkTabs {...defaultProps} activeForkId="fork-main" />);
    await user.click(screen.getByRole('tab', { name: /Fork 1/ }));
    expect(defaultProps.onForkSelect).toHaveBeenCalledWith('fork-1');
  });

  it('does not call onForkSelect when clicking the active tab', async () => {
    const user = userEvent.setup();
    render(<ForkTabs {...defaultProps} activeForkId="fork-main" />);
    await user.click(screen.getByRole('tab', { name: /Main/ }));
    expect(defaultProps.onForkSelect).not.toHaveBeenCalled();
  });

  it('opens a dropdown menu when clicking the three-dot button', async () => {
    const user = userEvent.setup();
    render(<ForkTabs {...defaultProps} />);
    const tabContainer = screen.getByTestId('fork-tab-fork-main');
    const menuButton = within(tabContainer).getByRole('button', { name: /more options/i });
    await user.click(menuButton);
    expect(screen.getByRole('menuitem', { name: /rename/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });

  it('calls onRename when clicking Rename in the menu', async () => {
    const user = userEvent.setup();
    render(<ForkTabs {...defaultProps} />);
    const tabContainer = screen.getByTestId('fork-tab-fork-main');
    const menuButton = within(tabContainer).getByRole('button', { name: /more options/i });
    await user.click(menuButton);
    await user.click(screen.getByRole('menuitem', { name: /rename/i }));
    expect(defaultProps.onRename).toHaveBeenCalledWith('fork-main', 'Main');
  });

  it('calls onDelete when clicking Delete in the menu', async () => {
    const user = userEvent.setup();
    render(<ForkTabs {...defaultProps} />);
    const tabContainer = screen.getByTestId('fork-tab-fork-1');
    const menuButton = within(tabContainer).getByRole('button', { name: /more options/i });
    await user.click(menuButton);
    await user.click(screen.getByRole('menuitem', { name: /delete/i }));
    expect(defaultProps.onDelete).toHaveBeenCalledWith('fork-1');
  });

  it('renders a tablist role on the container', () => {
    render(<ForkTabs {...defaultProps} />);
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('applies accent styling to the active tab container', () => {
    render(<ForkTabs {...defaultProps} activeForkId="fork-1" />);
    const container = screen.getByTestId('fork-tab-fork-1');
    expect(container.className).toContain('bg-accent');
  });

  it('shows pointer cursor on tab buttons', () => {
    render(<ForkTabs {...defaultProps} />);
    const tab = screen.getByRole('tab', { name: /Main/ });
    expect(tab.className).toContain('cursor-pointer');
  });

  it('applies hover-exclusion class to tab containers', () => {
    render(<ForkTabs {...defaultProps} />);
    const container = screen.getByTestId('fork-tab-fork-main');
    expect(container.className).toContain('[&:hover:not(:has([data-menu-trigger]:hover))]');
    expect(container.className).toContain('bg-muted');
  });

  it('renders all tabs when there are many forks', () => {
    const manyForks = [
      createFork({ id: 'f-main', name: 'Main' }),
      createFork({ id: 'f-1', name: 'Fork 1' }),
      createFork({ id: 'f-2', name: 'Fork 2' }),
      createFork({ id: 'f-3', name: 'Fork 3' }),
      createFork({ id: 'f-4', name: 'Fork 4' }),
    ];
    render(<ForkTabs {...defaultProps} forks={manyForks} activeForkId="f-main" />);
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });
});
