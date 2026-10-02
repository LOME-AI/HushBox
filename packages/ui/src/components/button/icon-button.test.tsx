import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { IconButton, type IconButtonSize } from './icon-button';

function Glyph({ className }: Readonly<{ className?: string }>): React.JSX.Element {
  return <svg data-testid="glyph" className={className} />;
}

function button(): HTMLElement {
  return screen.getByRole('button');
}

describe('IconButton', () => {
  it('is named by its aria-label', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} />);

    expect(button()).toHaveAccessibleName('Copy');
  });

  it('requires an accessible name', () => {
    // @ts-expect-error -- an icon button without aria-label has no accessible name
    render(<IconButton icon={Glyph} />);

    expect(button()).toBeInTheDocument();
  });

  it('draws its icon', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} />);

    expect(within(button()).getByTestId('glyph')).toBeInTheDocument();
  });

  it.each([
    ['2xs', 'size-6'],
    ['xs', 'size-7'],
    ['sm', 'size-8'],
    ['md', 'size-9'],
    ['lg', 'size-10'],
  ] as const)('the %s size is a square of %s', (size: IconButtonSize, token) => {
    render(<IconButton aria-label="Copy" icon={Glyph} size={size} />);

    expect(button()).toHaveAttribute('data-size', size);
    expect(button()).toHaveClass(token, 'p-0');
  });

  it('is 2.25rem square when no size is named', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} />);

    expect(button()).toHaveClass('size-9');
  });

  it('draws the ghost look', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} />);

    expect(button()).toHaveAttribute('data-variant', 'ghost');
    expect(button()).toHaveClass('hover:bg-accent', 'disabled:text-disabled-ink');
  });

  it('grows to 2.75rem on a coarse pointer by default', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} />);

    expect(button()).toHaveClass('pointer-coarse:size-11');
  });

  it('keeps its box and extends a 2.75rem target around it when asked', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} size="2xs" hitArea="extend" />);

    expect(button()).not.toHaveClass('pointer-coarse:size-11');
    expect(button()).toHaveClass(
      'relative',
      'pointer-coarse:before:absolute',
      'pointer-coarse:before:size-11',
      'pointer-coarse:before:top-1/2',
      'pointer-coarse:before:left-1/2',
      'pointer-coarse:before:-translate-1/2'
    );
  });

  it('takes no minimum height beside its square', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} hitArea="extend" />);

    expect(button()).not.toHaveClass('pointer-coarse:min-h-11');
  });

  it('transitions no outline property', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} />);
    const transitions = [...button().classList].filter((token) => token.startsWith('transition'));

    expect(transitions).toEqual([
      'transition-[color,background-color,border-color,box-shadow,opacity]',
    ]);
  });

  it('an aria-disabled icon button does not call onClick', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton aria-label="Copy" icon={Glyph} aria-disabled="true" onClick={onClick} />);

    await user.click(button());

    expect(onClick).not.toHaveBeenCalled();
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<IconButton aria-label="Copy" icon={Glyph} onClick={onClick} />);

    await user.click(button());

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('marks its slot', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} />);

    expect(button()).toHaveAttribute('data-slot', 'icon-button');
  });

  it('applies a caller class', () => {
    render(<IconButton aria-label="Copy" icon={Glyph} className="text-muted-foreground" />);

    expect(button()).toHaveClass('text-muted-foreground');
  });
});
