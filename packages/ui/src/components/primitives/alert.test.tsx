import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Alert, alertVariants } from './alert';

describe('Alert', () => {
  it('renders children', () => {
    render(<Alert variant="destructive">Warning message</Alert>);
    expect(screen.getByText('Warning message')).toBeInTheDocument();
  });

  it('has role="alert" for the destructive variant', () => {
    render(
      <Alert variant="destructive" data-testid="alert">
        Content
      </Alert>
    );
    expect(screen.getByTestId('alert')).toHaveAttribute('role', 'alert');
  });

  it('has role="status" for the default variant', () => {
    render(
      <Alert variant="default" data-testid="alert">
        Content
      </Alert>
    );
    expect(screen.getByTestId('alert')).toHaveAttribute('role', 'status');
  });

  it('rejects a call site that declares no variant', () => {
    // The required prop is the fix: a call site that says nothing about whether
    // it is an error or information must not compile. Runtime cannot observe a
    // compile error, so the directive itself is the assertion — it fails
    // typecheck the moment `variant` becomes optional again.
    // @ts-expect-error — `variant` is required
    render(<Alert data-testid="alert">Content</Alert>);
    expect(screen.getByTestId('alert')).toBeInTheDocument();
  });

  it('renders as div', () => {
    render(
      <Alert variant="destructive" data-testid="alert">
        Content
      </Alert>
    );
    expect(screen.getByTestId('alert').tagName).toBe('DIV');
  });

  it('applies destructive variant classes', () => {
    render(
      <Alert variant="destructive" data-testid="alert">
        Content
      </Alert>
    );
    const el = screen.getByTestId('alert');
    expect(el).toHaveClass('bg-destructive/10');
    expect(el).toHaveClass('text-destructive');
  });

  it('applies base layout classes', () => {
    render(
      <Alert variant="destructive" data-testid="alert">
        Content
      </Alert>
    );
    const el = screen.getByTestId('alert');
    expect(el).toHaveClass('flex');
    expect(el).toHaveClass('items-center');
    expect(el).toHaveClass('gap-2');
    expect(el).toHaveClass('rounded-md');
    expect(el).toHaveClass('p-3');
    expect(el).toHaveClass('text-sm');
  });

  it('applies custom className', () => {
    render(
      <Alert variant="destructive" className="mb-4" data-testid="alert">
        Content
      </Alert>
    );
    expect(screen.getByTestId('alert')).toHaveClass('mb-4');
  });

  it('auto-sizes direct SVG children', () => {
    render(
      <Alert variant="destructive" data-testid="alert">
        Content
      </Alert>
    );
    const el = screen.getByTestId('alert');
    expect(el.className).toContain('[&>svg]:h-4');
    expect(el.className).toContain('[&>svg]:w-4');
    expect(el.className).toContain('[&>svg]:shrink-0');
  });

  it('applies default variant classes', () => {
    render(
      <Alert variant="default" data-testid="alert">
        Info
      </Alert>
    );
    const el = screen.getByTestId('alert');
    expect(el).toHaveClass('text-muted-foreground');
    expect(el).not.toHaveClass('bg-destructive/10');
    expect(el).not.toHaveClass('text-destructive');
  });

  it('raises an informational alert onto a filled surface at strong emphasis', () => {
    render(
      <Alert variant="default" emphasis="strong" data-testid="alert">
        Caution
      </Alert>
    );
    const el = screen.getByTestId('alert');
    expect(el).toHaveClass('bg-muted');
    expect(el).toHaveClass('text-foreground');
    expect(el).not.toHaveClass('text-muted-foreground');
  });

  it('keeps the polite role when an informational alert is raised', () => {
    render(
      <Alert variant="default" emphasis="strong" data-testid="alert">
        Caution
      </Alert>
    );
    expect(screen.getByTestId('alert')).toHaveAttribute('role', 'status');
  });

  it('drops the tinted surface from a destructive alert at subtle emphasis', () => {
    render(
      <Alert variant="destructive" emphasis="subtle" data-testid="alert">
        Content
      </Alert>
    );
    const el = screen.getByTestId('alert');
    expect(el).toHaveClass('text-destructive');
    expect(el).not.toHaveClass('bg-destructive/10');
  });

  it('keeps the assertive role when a destructive alert is de-emphasized', () => {
    render(
      <Alert variant="destructive" emphasis="subtle" data-testid="alert">
        Content
      </Alert>
    );
    expect(screen.getByTestId('alert')).toHaveAttribute('role', 'alert');
  });

  it('colors an informational alert when called as a styling function without emphasis', () => {
    expect(alertVariants({ variant: 'default' })).toContain('text-muted-foreground');
  });

  it('colors a destructive alert when called as a styling function without emphasis', () => {
    const classes = alertVariants({ variant: 'destructive' });
    expect(classes).toContain('bg-destructive/10');
    expect(classes).toContain('text-destructive');
  });

  it('styles an informational alert identically with and without the emphasis argument', () => {
    expect(alertVariants({ variant: 'default' })).toBe(
      alertVariants({ variant: 'default', emphasis: 'subtle' })
    );
  });

  it('styles a destructive alert identically with and without the emphasis argument', () => {
    expect(alertVariants({ variant: 'destructive' })).toBe(
      alertVariants({ variant: 'destructive', emphasis: 'strong' })
    );
  });

  it('forwards additional HTML attributes', () => {
    render(
      <Alert variant="destructive" data-testid="alert" id="my-alert">
        Content
      </Alert>
    );
    expect(screen.getByTestId('alert')).toHaveAttribute('id', 'my-alert');
  });
});
