import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge, type BadgeTone } from './badge';
import type { IconGlyphProps } from '../icons/icon';

function Glyph(props: Readonly<IconGlyphProps>): React.JSX.Element {
  return <svg data-testid="badge-glyph" {...props} />;
}

describe('Badge', () => {
  it('draws a small medium-weight pill', () => {
    render(<Badge tone="neutral">Draft</Badge>);

    expect(screen.getByText('Draft')).toHaveClass(
      'inline-flex',
      'rounded-full',
      'px-2',
      'py-0.5',
      'text-xs',
      'font-medium',
      'whitespace-nowrap'
    );
  });

  it.each([
    ['neutral', ['bg-muted', 'text-muted-foreground']],
    ['success', ['bg-success/12', 'text-success-text']],
    ['warning', ['bg-warning/12', 'text-warning-text']],
    ['error', ['bg-error/12', 'text-error-text']],
    ['info', ['bg-info/12', 'text-info-text']],
    ['brand', ['bg-primary', 'text-primary-foreground']],
    ['secondary', ['bg-secondary', 'text-secondary-foreground']],
  ] as const satisfies readonly (readonly [BadgeTone, readonly string[]])[])(
    'draws the %s tone in its ink on its fill',
    (tone, classes) => {
      render(<Badge tone={tone}>Label</Badge>);

      expect(screen.getByText('Label')).toHaveClass(...classes);
    }
  );

  it('draws no border, so a tone is its fill and ink alone', () => {
    render(<Badge tone="success">Verified</Badge>);

    const tokens = [...screen.getByText('Verified').classList];
    expect(tokens.filter((token) => token.startsWith('border'))).toEqual([]);
  });

  it('draws an icon before its label at the extra-small size', () => {
    render(
      <Badge tone="success" icon={Glyph}>
        Verified
      </Badge>
    );

    const glyph = screen.getByTestId('badge-glyph');
    expect(glyph).toHaveClass('size-3');
    expect(screen.getByText('Verified').firstChild).toBe(glyph);
  });

  it('hides its icon from assistive technology', () => {
    render(
      <Badge tone="success" icon={Glyph}>
        Verified
      </Badge>
    );

    expect(screen.getByTestId('badge-glyph')).toHaveAttribute('aria-hidden', 'true');
  });

  it('passes native span attributes through to the pill', () => {
    render(
      <Badge
        tone="neutral"
        data-testid="audit-undo"
        title="Undoes an earlier row"
        aria-live="polite"
      >
        undo
      </Badge>
    );

    const pill = screen.getByTestId('audit-undo');
    expect(pill).toHaveTextContent('undo');
    expect(pill).toHaveAttribute('title', 'Undoes an earlier row');
    expect(pill).toHaveAttribute('aria-live', 'polite');
  });

  it('refuses a class or style, so tone alone sets its look', () => {
    render(
      // @ts-expect-error -- a badge's look comes from its tone, never a caller's class
      <Badge tone="info" className="mt-2">
        Queued
      </Badge>
    );
    render(
      // @ts-expect-error -- a badge's look comes from its tone, never a caller's style
      <Badge tone="info" style={{ margin: 0 }}>
        Held
      </Badge>
    );

    expect(screen.getByText('Queued')).not.toHaveClass('mt-2');
  });

  it('draws the compact size in small uppercase semibold type', () => {
    render(
      <Badge tone="neutral" size="compact">
        Feature
      </Badge>
    );

    expect(screen.getByText('Feature')).toHaveClass(
      'px-[0.4375rem]',
      'py-[0.0625rem]',
      'text-[0.625rem]',
      'leading-4',
      'font-semibold',
      'tracking-[0.04em]',
      'uppercase'
    );
  });

  it('drops the default size and weight at the compact size', () => {
    render(
      <Badge tone="warning" size="compact">
        Bug
      </Badge>
    );

    const pill = screen.getByText('Bug');
    expect(pill).not.toHaveClass('px-2');
    expect(pill).not.toHaveClass('py-0.5');
    expect(pill).not.toHaveClass('py-px');
    expect(pill).not.toHaveClass('text-xs');
    expect(pill).not.toHaveClass('font-medium');
    expect(pill).toHaveClass('bg-warning/12', 'text-warning-text');
  });

  it('keeps the default size when none is given', () => {
    render(<Badge tone="neutral">Draft</Badge>);

    expect(screen.getByText('Draft')).not.toHaveClass('uppercase');
  });

  it('draws no icon when none is given', () => {
    render(<Badge tone="info">In progress</Badge>);

    expect(screen.getByText('In progress').querySelector('svg')).toBeNull();
  });
});
