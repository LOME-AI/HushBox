import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import section from './marks.section';

function renderSection(): HTMLElement {
  return render(<>{section.render()}</>).container;
}

describe('the marks kit section', () => {
  it('is compared against catalog part 4', () => {
    expect(section.part).toBe(4);
  });

  it.each([
    ['Verified', 'text-success-text'],
    ['Not set', 'text-warning-text'],
    ['Failed', 'text-error-text'],
    ['In progress', 'text-info-text'],
    ['Draft', 'text-muted-foreground'],
    ['2', 'text-primary-foreground'],
  ])('draws the %s badge in its tone', (label, inkClass) => {
    renderSection();

    expect(screen.getByText(label)).toHaveClass(inkClass);
  });

  it('draws a badge with an icon', () => {
    renderSection();

    expect(screen.getByText('Enabled').querySelector('svg')).not.toBeNull();
  });

  it('draws every model swatch at both sizes', () => {
    const container = renderSection();

    expect(container.querySelectorAll('[data-slot="swatch"].size-2')).toHaveLength(8);
    expect(container.querySelectorAll(String.raw`[data-slot="swatch"].size-2\.5`)).toHaveLength(8);
  });

  it('draws key hints', () => {
    const container = renderSection();

    expect(container.querySelectorAll('kbd').length).toBeGreaterThan(0);
  });

  it('draws the theme toggle', () => {
    renderSection();

    expect(screen.getByTestId(TEST_IDS.themeToggle)).toBeInTheDocument();
  });
});
