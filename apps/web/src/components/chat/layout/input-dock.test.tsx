import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { InputDock } from '@/components/chat/layout/input-dock';

function renderDock(
  props: Omit<React.ComponentProps<typeof InputDock>, 'children'> = {}
): HTMLElement {
  render(
    <InputDock {...props}>
      <p>dock content</p>
    </InputDock>
  );
  const dock = screen.getByText('dock content').parentElement;
  if (dock === null) throw new Error('the dock did not render its children');
  return dock;
}

describe('InputDock', () => {
  it('renders its children', () => {
    renderDock();
    expect(screen.getByText('dock content')).toBeInTheDocument();
  });

  it('sits below the thread behind a hairline, with 1rem above and below the composer', () => {
    expect(renderDock()).toHaveClass('border-t', 'py-4');
  });

  it('keeps its height while the thread above it grows, on the page background', () => {
    expect(renderDock()).toHaveClass('flex-shrink-0', 'bg-background');
  });

  it('hands its element to a ref', () => {
    const ref = React.createRef<HTMLDivElement>();
    const dock = renderDock({ ref });
    expect(ref.current).toBe(dock);
  });

  it('takes the style it is given', () => {
    expect(renderDock({ style: { paddingBottom: '3rem' } }).style.paddingBottom).toBe('3rem');
  });

  it('carries the data attributes it is given', () => {
    render(
      <InputDock data-chrome="" data-chat-input>
        <p>dock content</p>
      </InputDock>
    );
    const dock = screen.getByText('dock content').parentElement;
    expect(dock).toHaveAttribute('data-chrome', '');
    expect(dock).toHaveAttribute('data-chat-input', 'true');
  });
});
