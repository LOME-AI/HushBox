import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Globe, Plus } from '@hushbox/ui/icons';
import { Chip } from './chip';

describe('Chip', () => {
  it('renders a button that submits nothing', () => {
    render(<Chip label="Search" />);

    expect(screen.getByRole('button', { name: 'Search' })).toHaveAttribute('type', 'button');
  });

  it('draws a 2rem pill on the control border in muted ink', () => {
    render(<Chip label="Search" />);

    expect(screen.getByRole('button')).toHaveClass(
      'h-8',
      'rounded-full',
      'border',
      'border-border-control',
      'bg-transparent',
      'text-muted-foreground'
    );
  });

  it('sets its label in the small ui role at medium weight on one line', () => {
    render(<Chip label="Search" />);

    expect(screen.getByRole('button')).toHaveClass(
      'text-ui-sm',
      'font-medium',
      'leading-none',
      'whitespace-nowrap'
    );
  });

  it('keeps its size in a row that runs short of space', () => {
    render(<Chip label="Search" />);

    expect(screen.getByRole('button')).toHaveClass('shrink-0');
  });

  it('draws its icon before the label, hidden from assistive tech', () => {
    render(<Chip icon={Globe} label="Search" />);

    const button = screen.getByRole('button', { name: 'Search' });
    const icon = button.firstElementChild;
    expect(icon?.tagName.toLowerCase()).toBe('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws no icon when it is given none', () => {
    render(<Chip label="Search" />);

    expect(screen.getByRole('button').querySelector('svg')).toBeNull();
  });

  describe('pressed', () => {
    it('reports its pressed state', () => {
      render(<Chip label="Search" pressed />);

      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
    });

    it('reports an unpressed state when told it is not pressed', () => {
      render(<Chip label="Search" pressed={false} />);

      expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'false');
    });

    it('is no toggle when it is given no pressed state', () => {
      render(<Chip label="Search" />);

      expect(screen.getByRole('button')).not.toHaveAttribute('aria-pressed');
    });

    it('draws the pressed look from its pressed state', () => {
      render(<Chip label="Search" pressed />);

      expect(screen.getByRole('button')).toHaveClass(
        'aria-pressed:bg-brand-red-subtle',
        'aria-pressed:border-brand-red',
        'aria-pressed:text-foreground',
        'aria-pressed:font-semibold'
      );
    });

    it('turns its icon red while pressed', () => {
      render(<Chip icon={Globe} label="Search" pressed />);

      expect(screen.getByRole('button').querySelector('svg')).toHaveClass(
        '[[aria-pressed=true]>&]:text-brand-red'
      );
    });
  });

  describe('disabled', () => {
    it('reports itself disabled while staying reachable', () => {
      render(<Chip label="Search" disabled />);

      const button = screen.getByRole('button');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      expect(button).not.toBeDisabled();
    });

    it('draws a dashed border and a not-allowed cursor from its disabled state', () => {
      render(<Chip label="Search" disabled />);

      expect(screen.getByRole('button')).toHaveClass(
        'aria-disabled:border-dashed',
        'aria-disabled:cursor-not-allowed',
        'aria-disabled:hover:bg-transparent',
        'aria-disabled:hover:text-muted-foreground'
      );
    });

    it('does not act on a click', async () => {
      const onClick = vi.fn();
      render(<Chip label="Search" disabled onClick={onClick} />);

      await userEvent.click(screen.getByRole('button'));

      expect(onClick).not.toHaveBeenCalled();
    });

    it('carries no disabled state when enabled', () => {
      render(<Chip label="Search" />);

      expect(screen.getByRole('button')).not.toHaveAttribute('aria-disabled');
    });
  });

  describe('expanded', () => {
    it('reports its expanded state', () => {
      render(<Chip label="Mid" expanded />);

      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    });

    it('reports a collapsed state when told it is collapsed', () => {
      render(<Chip label="Mid" expanded={false} />);

      expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    });

    it('draws the accent fill from its expanded state', () => {
      render(<Chip label="Mid" expanded />);

      expect(screen.getByRole('button')).toHaveClass(
        'aria-expanded:bg-accent',
        'aria-expanded:text-foreground',
        'aria-expanded:border-muted-foreground'
      );
    });
  });

  it('shows the pointer cursor', () => {
    render(<Chip label="Search" />);

    expect(screen.getByRole('button')).toHaveClass('cursor-pointer');
  });

  it('draws the hover fill in foreground ink', () => {
    render(<Chip label="Search" />);

    expect(screen.getByRole('button')).toHaveClass('hover:bg-accent', 'hover:text-foreground');
  });

  it('eases only its colours, so a focus outline appears at once', () => {
    render(<Chip label="Search" />);

    expect(screen.getByRole('button')).toHaveClass(
      'transition-[background-color,border-color,color]',
      'duration-150'
    );
  });

  describe('icon only', () => {
    it('is a 2rem square', () => {
      render(<Chip icon={Plus} iconOnly label="Change mode" />);

      expect(screen.getByRole('button')).toHaveClass('w-8', 'px-0', 'justify-center');
    });

    it('is named by its label', () => {
      render(<Chip icon={Plus} iconOnly label="Change mode" />);

      expect(screen.getByRole('button', { name: 'Change mode' })).toBeInTheDocument();
    });

    it('shows no label text', () => {
      render(<Chip icon={Plus} iconOnly label="Change mode" />);

      expect(screen.getByRole('button')).toHaveTextContent('');
    });

    it('keeps a name its caller gives', () => {
      render(<Chip icon={Plus} iconOnly label="Change mode" aria-label="Open the mode menu" />);

      expect(screen.getByRole('button', { name: 'Open the mode menu' })).toBeInTheDocument();
    });
  });

  it('extends its target on a coarse pointer without growing its box', () => {
    render(<Chip label="Search" />);

    // The pseudo-element is placed from the padding box, so its vertical reach adds the
    // 1px border back to land the target on 2.75rem.
    expect(screen.getByRole('button')).toHaveClass(
      'relative',
      'pointer-coarse:before:absolute',
      'pointer-coarse:before:-inset-x-0.5',
      'pointer-coarse:before:-inset-y-[calc(0.375rem+1px)]'
    );
  });

  it('draws its children after the label', () => {
    render(
      <Chip label="Search">
        <span>extra</span>
      </Chip>
    );

    expect(screen.getByRole('button')).toHaveTextContent('Searchextra');
  });

  it('acts on a click', async () => {
    const onClick = vi.fn();
    render(<Chip label="Search" onClick={onClick} />);

    await userEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('passes native attributes to its button', () => {
    render(<Chip label="Search" data-testid="search-chip" aria-haspopup="menu" />);

    const button = screen.getByTestId('search-chip');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('merges a caller class over its own', () => {
    render(<Chip label="Search" className="shrink" />);

    const button = screen.getByRole('button');
    expect(button).toHaveClass('shrink');
    expect(button).not.toHaveClass('shrink-0');
  });
});
