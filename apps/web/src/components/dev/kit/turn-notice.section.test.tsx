import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import section from './turn-notice.section';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    className,
  }: Readonly<{ children: React.ReactNode; to: string; className?: string }>) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

function renderSection(): void {
  render(<>{section.render()}</>);
}

function tileWith(text: string): HTMLElement {
  const tile = screen
    .getAllByTestId(TEST_IDS.turnNoticeTile)
    .find((candidate) => candidate.textContent.includes(text));
  if (tile === undefined) throw new Error(`no tile holds "${text}"`);
  return tile;
}

describe('turn notice kit section', () => {
  it('is compared against catalog part 5', () => {
    expect(section.part).toBe(5);
  });

  it('is titled Turn notices', () => {
    expect(section.title).toBe('Turn notices');
  });

  it('draws a failed turn as a tile with Regenerate', () => {
    renderSection();

    const tile = tileWith('This service is temporarily unavailable.');
    expect(within(tile).getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });

  it('draws a block that clears on its own with the hourglass', () => {
    renderSection();

    expect(tileWith('This conversation is already generating a reply.')).toHaveAttribute(
      'data-severity',
      'hourglass'
    );
  });

  it('draws the rate-limited tile with its wait', () => {
    renderSection();

    expect(tileWith('Try again in 12 seconds.')).toBeInTheDocument();
  });

  it('draws a refused Regenerate', () => {
    renderSection();

    const tile = tileWith("This message can't be sent right now.");
    expect(within(tile).getByRole('button', { name: 'Regenerate' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });

  it('draws the trial limit without Regenerate', () => {
    renderSection();

    const tile = tileWith("You've reached today's free trial limit.");
    expect(within(tile).queryByRole('button', { name: 'Regenerate' })).not.toBeInTheDocument();
  });

  it('keeps a tile in place when its Regenerate is pressed', () => {
    renderSection();

    const tile = tileWith('This service is temporarily unavailable.');
    fireEvent.click(within(tile).getByRole('button', { name: 'Regenerate' }));

    expect(tileWith('This service is temporarily unavailable.')).toBeInTheDocument();
  });

  it("draws a failed model's slot", () => {
    renderSection();

    expect(screen.getByTestId(TEST_IDS.modelErrorMessage)).toHaveTextContent(
      friendlyErrorMessage('STREAM_ERROR')
    );
  });
});
