import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Alert } from './alert';

describe('Alert', () => {
  it('renders children', () => {
    render(<Alert>Warning message</Alert>);
    expect(screen.getByText('Warning message')).toBeInTheDocument();
  });

  it('has role="alert"', () => {
    render(<Alert data-testid="alert">Content</Alert>);
    expect(screen.getByTestId('alert')).toHaveAttribute('role', 'alert');
  });

  it('renders as div', () => {
    render(<Alert data-testid="alert">Content</Alert>);
    expect(screen.getByTestId('alert').tagName).toBe('DIV');
  });

  it('applies destructive variant classes by default', () => {
    render(<Alert data-testid="alert">Content</Alert>);
    const el = screen.getByTestId('alert');
    expect(el).toHaveClass('bg-destructive/10');
    expect(el).toHaveClass('text-destructive');
  });

  it('applies base layout classes', () => {
    render(<Alert data-testid="alert">Content</Alert>);
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
      <Alert className="mb-4" data-testid="alert">
        Content
      </Alert>
    );
    expect(screen.getByTestId('alert')).toHaveClass('mb-4');
  });

  it('auto-sizes direct SVG children', () => {
    render(<Alert data-testid="alert">Content</Alert>);
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

  it('forwards additional HTML attributes', () => {
    render(
      <Alert data-testid="alert" id="my-alert">
        Content
      </Alert>
    );
    expect(screen.getByTestId('alert')).toHaveAttribute('id', 'my-alert');
  });
});
