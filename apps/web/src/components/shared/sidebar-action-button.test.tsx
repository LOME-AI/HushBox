import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SidebarActionButton } from './sidebar-action-button';

describe('SidebarActionButton', () => {
  describe('expanded mode', () => {
    it('renders button with label and icon', () => {
      render(
        <SidebarActionButton
          icon={<span data-testid="test-icon">+</span>}
          label="New Chat"
          onClick={vi.fn()}
        />
      );

      expect(screen.getByRole('button', { name: 'New Chat' })).toBeInTheDocument();
      expect(screen.getByTestId('test-icon')).toBeInTheDocument();
      expect(screen.getByText('New Chat')).toBeInTheDocument();
    });

    it('defaults to expanded when collapsed is undefined', () => {
      render(
        <SidebarActionButton
          icon={<span data-testid="test-icon">+</span>}
          label="New Chat"
          onClick={vi.fn()}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('w-full');
      expect(screen.getByText('New Chat')).toBeInTheDocument();
    });

    it('has gradient classes', () => {
      render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button).toHaveClass('bg-gradient-to-r');
    });

    it('has clip-path style', () => {
      render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={vi.fn()} />);

      const button = screen.getByRole('button');
      expect(button.style.clipPath).toBe('polygon(0 0, 100% 0, 95% 100%, 0 100%)');
    });
  });

  describe('collapsed mode', () => {
    it('renders icon only without label', () => {
      render(
        <SidebarActionButton
          icon={<span data-testid="test-icon">+</span>}
          label="New Chat"
          onClick={vi.fn()}
          collapsed={true}
        />
      );

      expect(screen.getByTestId('test-icon')).toBeInTheDocument();
      expect(screen.queryByText('New Chat')).not.toBeInTheDocument();
    });

    it('has compact size classes', () => {
      render(
        <SidebarActionButton
          icon={<span>+</span>}
          label="Action"
          onClick={vi.fn()}
          collapsed={true}
        />
      );

      const button = screen.getByRole('button');
      expect(button).toHaveClass('h-9');
      expect(button).toHaveClass('w-9');
    });
  });

  it('calls onClick when clicked', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={onClick} />);

    await user.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('has aria-label matching label prop', () => {
    render(<SidebarActionButton icon={<span>+</span>} label="My Action" onClick={vi.fn()} />);

    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'My Action');
  });

  it('applies testId as data-testid', () => {
    render(
      <SidebarActionButton
        icon={<span>+</span>}
        label="Action"
        onClick={vi.fn()}
        testId="custom-btn"
      />
    );

    expect(screen.getByTestId('custom-btn')).toBeInTheDocument();
  });

  it('renders shine animation div', () => {
    render(<SidebarActionButton icon={<span>+</span>} label="Action" onClick={vi.fn()} />);

    const button = screen.getByRole('button');
    const shineDiv = button.querySelector('[aria-hidden="true"]');
    expect(shineDiv).not.toBeNull();
    expect(shineDiv).toHaveClass('pointer-events-none', 'absolute', 'inset-0');
  });
});
