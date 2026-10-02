import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import section from './surface.section';

function renderSection(): void {
  render(<>{section.render()}</>);
}

describe('surface kit section', () => {
  it('is compared against catalog part 5', () => {
    expect(section.part).toBe(5);
  });

  it('draws a card whose title is a level-3 heading', () => {
    renderSection();

    expect(screen.getByRole('heading', { level: 3, name: 'Current Balance' })).toBeInTheDocument();
  });

  it('draws a comfortable table', () => {
    renderSection();

    expect(screen.getByRole('table', { name: 'Purchase history' })).toHaveAttribute(
      'data-density',
      'comfortable'
    );
  });

  it('draws a dense table', () => {
    renderSection();

    expect(screen.getByRole('table', { name: 'Newsletter issues' })).toHaveAttribute(
      'data-density',
      'dense'
    );
  });

  it('draws a loading region', () => {
    renderSection();

    expect(screen.getByRole('group', { name: 'Usage while loading' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
  });

  it('draws a failed region with a retry', () => {
    renderSection();

    expect(screen.getByRole('group', { name: 'Usage after a failed read' })).toContainElement(
      screen.getByRole('button', { name: 'Try again' })
    );
  });

  it('loads the failed region again when Try again is pressed', async () => {
    renderSection();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByRole('group', { name: 'Usage after a failed read' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
  });
});
