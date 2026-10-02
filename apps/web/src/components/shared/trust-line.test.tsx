import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Lock } from '@hushbox/ui/icons';
import { TrustLine } from './trust-line';

const LINE = 'Saved encrypted with a key only your devices hold.';

function lineIn(): HTMLElement {
  const line = screen.getByText(LINE);
  if (line.tagName.toLowerCase() !== 'p') throw new Error('the line is not a paragraph');
  return line;
}

describe('TrustLine', () => {
  it('draws its text as a paragraph', () => {
    render(<TrustLine icon={Lock}>{LINE}</TrustLine>);

    expect(lineIn()).toBeInTheDocument();
  });

  it('sets its text in muted caption type, wrapped balanced', () => {
    render(<TrustLine icon={Lock}>{LINE}</TrustLine>);

    expect(lineIn()).toHaveClass('text-caption', 'text-muted-foreground', 'text-balance');
  });

  it('starts with its icon, hidden from assistive tech', () => {
    render(<TrustLine icon={Lock}>{LINE}</TrustLine>);

    const icon = lineIn().firstElementChild;
    expect(icon?.tagName.toLowerCase()).toBe('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws its icon green, inline with the first line of text', () => {
    render(<TrustLine icon={Lock}>{LINE}</TrustLine>);

    expect(lineIn().querySelector('svg')).toHaveClass(
      'inline-block',
      'size-3.5',
      'me-1.5',
      'align-[-0.15em]',
      'text-success'
    );
  });

  it('starts its text at the line start by default', () => {
    render(<TrustLine icon={Lock}>{LINE}</TrustLine>);

    const line = lineIn();
    expect(line).toHaveClass('text-start');
    expect(line).not.toHaveClass('text-center');
  });

  it('centres the line when asked', () => {
    render(
      <TrustLine icon={Lock} align="center">
        {LINE}
      </TrustLine>
    );

    const line = lineIn();
    expect(line).toHaveClass('text-center');
    expect(line).not.toHaveClass('text-start');
  });

  it('keeps the caption size unless asked for another', () => {
    render(<TrustLine icon={Lock}>{LINE}</TrustLine>);

    expect(lineIn()).toHaveAttribute(
      'class',
      'text-caption text-muted-foreground block text-balance text-start'
    );
  });

  it('draws the small ui size when asked', () => {
    render(
      <TrustLine icon={Lock} size="ui-sm">
        {LINE}
      </TrustLine>
    );

    const line = lineIn();
    expect(line).toHaveClass('text-ui-sm', 'text-muted-foreground');
    expect(line).not.toHaveClass('text-caption');
  });

  it('keeps the caption line height in the small ui size', () => {
    render(
      <TrustLine icon={Lock} size="ui-sm">
        {LINE}
      </TrustLine>
    );

    expect(lineIn()).toHaveClass('leading-(--text-caption--line-height)');
  });
});
