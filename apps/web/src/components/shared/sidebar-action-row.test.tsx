import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SquarePen } from 'lucide-react';
import { SidebarActionRow } from './sidebar-action-row';

describe('SidebarActionRow', () => {
  describe('as a link', () => {
    it('renders a link named by its label', () => {
      render(<SidebarActionRow icon={SquarePen} label="New chat" href="/chat" />);
      expect(screen.getByRole('link', { name: 'New chat' })).toBeInTheDocument();
    });

    it('points the link at its href', () => {
      render(<SidebarActionRow icon={SquarePen} label="New chat" href="/chat" />);
      expect(screen.getByRole('link', { name: 'New chat' })).toHaveAttribute('href', '/chat');
    });

    it('passes the click event to onClick', async () => {
      const user = userEvent.setup();
      const onClick = vi.fn((event: React.MouseEvent) => {
        event.preventDefault();
      });
      render(<SidebarActionRow icon={SquarePen} label="New chat" href="/chat" onClick={onClick} />);

      await user.click(screen.getByRole('link', { name: 'New chat' }));

      expect(onClick).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
    });
  });

  describe('as a button', () => {
    it('renders a button when no href is given', () => {
      render(<SidebarActionRow icon={SquarePen} label="Add member" onClick={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Add member' })).toBeInTheDocument();
    });

    it('never submits a surrounding form', () => {
      render(<SidebarActionRow icon={SquarePen} label="Add member" onClick={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Add member' })).toHaveAttribute('type', 'button');
    });

    it('calls onClick when pressed', async () => {
      const user = userEvent.setup();
      const onClick = vi.fn();
      render(<SidebarActionRow icon={SquarePen} label="Add member" onClick={onClick} />);

      await user.click(screen.getByRole('button', { name: 'Add member' }));

      expect(onClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('expanded', () => {
    it('shows its label as visible text', () => {
      render(<SidebarActionRow icon={SquarePen} label="New chat" href="/chat" />);
      expect(screen.getByText('New chat')).toBeInTheDocument();
    });

    it('draws the shortcut hint in the spaced text form', () => {
      render(<SidebarActionRow icon={SquarePen} label="New chat" href="/chat" kbd="mod+shift+o" />);
      const hint = screen.getByText('Ctrl ⇧ O');
      expect(hint.tagName).toBe('KBD');
    });

    it('keeps the hint out of the accessible name', () => {
      render(<SidebarActionRow icon={SquarePen} label="New chat" href="/chat" kbd="mod+shift+o" />);
      expect(screen.getByRole('link')).toHaveAccessibleName('New chat');
    });

    it('draws no hint when none is given', () => {
      const { container } = render(
        <SidebarActionRow icon={SquarePen} label="New chat" href="/chat" />
      );
      expect(container.querySelector('kbd')).toBeNull();
    });

    it('draws no shadow', () => {
      render(<SidebarActionRow icon={SquarePen} label="New chat" href="/chat" />);
      expect(screen.getByRole('link')).toHaveClass('shadow-none');
    });
  });

  describe('collapsed to the rail', () => {
    it('keeps an accessible name', () => {
      render(<SidebarActionRow icon={SquarePen} label="New chat" href="/chat" collapsed />);
      expect(screen.getByRole('link', { name: 'New chat' })).toBeInTheDocument();
    });

    it('shows the icon alone', () => {
      render(<SidebarActionRow icon={SquarePen} label="New chat" href="/chat" collapsed />);
      expect(screen.queryByText('New chat')).not.toBeInTheDocument();
    });

    it('draws no hint', () => {
      const { container } = render(
        <SidebarActionRow
          icon={SquarePen}
          label="New chat"
          href="/chat"
          kbd="mod+shift+o"
          collapsed
        />
      );
      expect(container.querySelector('kbd')).toBeNull();
    });
  });

  it('carries its test id', () => {
    render(
      <SidebarActionRow icon={SquarePen} label="New chat" href="/chat" testId="new-chat-row" />
    );
    expect(screen.getByTestId('new-chat-row')).toBe(screen.getByRole('link'));
  });
});
