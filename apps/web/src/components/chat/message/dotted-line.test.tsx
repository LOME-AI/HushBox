import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DottedLine } from './dotted-line';

const ITEMS = [
  { key: 'cost', node: <span>$0.0151</span> },
  { key: 'saved', node: <span>Saved encrypted</span> },
  { key: 'date', node: <span>Today</span> },
];

const DOT_CLASS = 'before:rounded-full';

describe('DottedLine', () => {
  it('draws no dot before the first item', () => {
    render(<DottedLine items={ITEMS} />);

    expect(screen.getByText('$0.0151').parentElement).not.toHaveClass(DOT_CLASS);
  });

  it('draws each later dot on the item it precedes, so it wraps with that item', () => {
    render(<DottedLine items={ITEMS} />);

    expect(screen.getByText('Saved encrypted').parentElement).toHaveClass(DOT_CLASS);
    expect(screen.getByText('Today').parentElement).toHaveClass(DOT_CLASS);
  });

  it('takes the classes its place sets, such as the type size', () => {
    render(<DottedLine items={ITEMS} className="text-caption" />);

    expect(screen.getByText('$0.0151').parentElement?.parentElement).toHaveClass('text-caption');
  });
});
