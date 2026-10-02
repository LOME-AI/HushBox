import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { buttonVariants as doorButtonVariants } from '../button/button';
import { Button, buttonVariants } from './button';

describe('Button', () => {
  it('renders children', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
  });

  it('calls onClick when clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);

    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not call onClick when disabled', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Click
      </Button>
    );

    await user.click(screen.getByRole('button'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is disabled when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('renders default variant', () => {
    render(<Button>Default</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'default');
  });

  it('renders destructive variant', () => {
    render(<Button variant="destructive">Delete</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'destructive');
  });

  it('renders outline variant', () => {
    render(<Button variant="outline">Outline</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'outline');
  });

  it('renders secondary variant', () => {
    render(<Button variant="secondary">Secondary</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'secondary');
  });

  it('renders ghost variant', () => {
    render(<Button variant="ghost">Ghost</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'ghost');
  });

  it('renders link variant', () => {
    render(<Button variant="link">Link</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'link');
  });

  it('renders default size', () => {
    render(<Button>Default Size</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'default');
  });

  it('renders small size', () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'sm');
  });

  it('renders large size', () => {
    render(<Button size="lg">Large</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'lg');
  });

  it('renders icon size', () => {
    render(<Button size="icon">Icon</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'icon');
  });

  it('icon size resolves to 44px (size-11) for HIG/Material minimum touch target', () => {
    render(<Button size="icon">Icon</Button>);
    expect(screen.getByRole('button')).toHaveClass('size-11');
  });

  it('icon-sm size resolves to 32px (size-8) for dense desktop contexts', () => {
    render(<Button size="icon-sm">Icon</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'icon-sm');
    expect(screen.getByRole('button')).toHaveClass('size-8');
  });

  it('icon-lg size resolves to 48px (size-12)', () => {
    render(<Button size="icon-lg">Icon</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'icon-lg');
    expect(screen.getByRole('button')).toHaveClass('size-12');
  });

  it('a door size renders the new button', () => {
    render(<Button size="sm">Small</Button>);
    expect(screen.getByRole('button')).toHaveClass(
      'h-8',
      'pointer-coarse:min-h-11',
      'disabled:bg-muted'
    );
  });

  it('shares the new button class recipe', () => {
    expect(buttonVariants).toBe(doorButtonVariants);
  });

  it.each(['icon', 'icon-sm', 'icon-lg'] as const)(
    'the %s square keeps no text box of its own',
    (size) => {
      render(<Button size={size}>Icon</Button>);
      const tokens = [...screen.getByRole('button').classList];
      expect(tokens.filter((token) => /^(h-\d|px-|py-|has-)/.test(token))).toEqual([]);
    }
  );

  it.each(['icon', 'icon-sm', 'icon-lg'] as const)(
    'the %s square keeps its size on a coarse pointer',
    (size) => {
      render(<Button size={size}>Icon</Button>);
      expect(screen.getByRole('button')).not.toHaveClass('pointer-coarse:min-h-11');
    }
  );

  it.each(['icon', 'icon-sm', 'icon-lg'] as const)(
    'the %s square fades and passes pointer events through when disabled',
    (size) => {
      render(
        <Button size={size} disabled>
          Icon
        </Button>
      );
      const element = screen.getByRole('button');
      expect(element).toHaveClass('disabled:pointer-events-none', 'disabled:opacity-50');
      expect(element).not.toHaveClass('disabled:bg-muted');
    }
  );

  it('an icon square keeps the pointer cursor while its caller marks it busy', () => {
    render(
      <Button size="icon" aria-busy>
        Icon
      </Button>
    );
    expect(screen.getByRole('button')).toHaveClass('cursor-pointer');
    expect(screen.getByRole('button')).not.toHaveClass('aria-busy:cursor-progress');
  });

  it.each(['icon', 'icon-sm', 'icon-lg'] as const)('the %s square draws no border', (size) => {
    render(<Button size={size}>Icon</Button>);
    expect(screen.getByRole('button')).toHaveClass('border-0');
    expect(screen.getByRole('button')).not.toHaveClass('border');
  });

  it('an icon square draws its variant', () => {
    render(
      <Button size="icon" variant="ghost">
        Icon
      </Button>
    );
    expect(screen.getByRole('button')).toHaveClass('hover:bg-accent');
  });

  it('an icon square draws the default variant when none is named', () => {
    render(<Button size="icon">Icon</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('data-variant', 'default');
    expect(screen.getByRole('button')).toHaveClass('bg-primary');
  });

  it('an icon square transitions no outline property', () => {
    render(<Button size="icon">Icon</Button>);
    expect(screen.getByRole('button')).toHaveClass(
      'transition-[color,background-color,border-color,box-shadow,opacity]'
    );
  });

  it('a bare button ignores a square size', () => {
    render(
      <Button variant="bare" size="icon">
        Row
      </Button>
    );
    expect(screen.getByRole('button')).not.toHaveClass('size-11');
    expect(screen.getByRole('button')).toHaveAttribute('data-size', 'default');
  });

  it('applies custom className', () => {
    render(<Button className="custom-class">Custom</Button>);
    expect(screen.getByRole('button')).toHaveClass('custom-class');
  });

  it('forwards ref to button element', () => {
    const ref = vi.fn();
    render(<Button ref={ref}>Ref</Button>);
    expect(ref).toHaveBeenCalled();
  });

  it('has correct type attribute by default', () => {
    render(<Button>Submit</Button>);
    expect(screen.getByRole('button')).not.toHaveAttribute('type');
  });

  it('accepts type attribute', () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it('renders as child element when asChild is set', () => {
    render(
      <Button asChild>
        <a href="/somewhere">Link button</a>
      </Button>
    );
    const link = screen.getByRole('link', { name: 'Link button' });
    expect(link).toHaveAttribute('href', '/somewhere');
    expect(link).toHaveAttribute('data-slot', 'button');
  });
});
