import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LAYOUT } from '@hushbox/shared/design-tokens';
import { ChatColumn } from '@/components/chat/layout/chat-column';

function renderColumn(): HTMLElement {
  render(
    <ChatColumn>
      <p>column content</p>
    </ChatColumn>
  );
  const column = screen.getByText('column content').parentElement;
  if (column === null) throw new Error('the column did not render its children');
  return column;
}

describe('ChatColumn', () => {
  it('renders its children', () => {
    renderColumn();
    expect(screen.getByText('column content')).toBeInTheDocument();
  });

  it('caps its content box at the chat measure', () => {
    const column = renderColumn();
    expect(column.style.maxWidth).toBe(LAYOUT.measureChat);
    expect(column).toHaveClass('box-content');
  });

  it('centres itself in the space it is given', () => {
    expect(renderColumn()).toHaveClass('mx-auto');
  });

  it("sets the band's gutters outside the measure", () => {
    expect(renderColumn()).toHaveClass('px-4', 'md:px-6');
  });
});
