import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ValueMark, type ValueKind } from './value-mark';

function markOf(container: HTMLElement): HTMLElement {
  const mark = container.querySelector<HTMLElement>('[data-slot="value-mark"]');
  if (mark === null) throw new Error('no value mark rendered');
  return mark;
}

function glyphOf(container: HTMLElement): SVGElement {
  const glyph = markOf(container).querySelector('svg');
  if (glyph === null) throw new Error('no glyph rendered');
  return glyph;
}

describe('ValueMark', () => {
  it('shows its word', () => {
    render(<ValueMark kind="yes" text="Yes" />);
    expect(screen.getByText('Yes')).toBeInTheDocument();
  });

  it('names its kind on the mark', () => {
    const { container } = render(<ValueMark kind="warn" text="To Resend, to send it" />);
    expect(markOf(container)).toHaveAttribute('data-kind', 'warn');
  });

  it('hides its glyph from assistive technology, since the word carries the meaning', () => {
    const { container } = render(<ValueMark kind="no" text="No" />);
    expect(glyphOf(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it.each<[ValueKind, string]>([
    ['yes', 'lucide-circle-check'],
    ['no', 'lucide-circle-x'],
    ['warn', 'lucide-triangle-alert'],
    ['lock', 'lucide-lock'],
  ])('draws the %s answer with its own glyph', (kind, glyphClass) => {
    const { container } = render(<ValueMark kind={kind} text="Answer" />);
    expect(glyphOf(container)).toHaveClass(glyphClass);
  });

  it.each<[ValueKind, string]>([
    ['yes', 'text-success'],
    ['no', 'text-muted-foreground'],
    ['warn', 'text-warning'],
    ['lock', 'text-success'],
  ])('colours the %s glyph by its meaning', (kind, toneClass) => {
    const { container } = render(<ValueMark kind={kind} text="Answer" />);
    expect(glyphOf(container)).toHaveClass(toneClass);
  });

  it('draws its glyph at the scale small step', () => {
    const { container } = render(<ValueMark kind="yes" text="Yes" />);
    expect(glyphOf(container)).toHaveClass('size-3.5');
  });

  it('lets the glyph take the ink around it when the answer is highlighted', () => {
    const { container } = render(<ValueMark kind="yes" text="Yes" highlighted />);
    expect(glyphOf(container)).not.toHaveClass('text-success');
  });

  it('aligns the glyph to the first line of a wrapping answer by default', () => {
    const { container } = render(<ValueMark kind="warn" text="To Resend, to send it" />);
    expect(markOf(container)).toHaveClass('items-start');
  });

  it('nudges the glyph down to the first line of text by default', () => {
    const { container } = render(<ValueMark kind="warn" text="To Resend, to send it" />);
    expect(glyphOf(container)).toHaveClass('mt-[0.15rem]');
  });

  it('centres the glyph and the word when centred', () => {
    const { container } = render(<ValueMark kind="yes" text="Yes" centred />);
    expect(markOf(container)).toHaveClass('items-center', 'justify-center');
  });

  it('keeps the glyph on the text line when centred', () => {
    const { container } = render(<ValueMark kind="yes" text="Yes" centred />);
    expect(glyphOf(container)).not.toHaveClass('mt-[0.15rem]');
  });
});
