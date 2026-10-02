import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TypeFilter } from './TypeFilter';
import type { TypeFilterValue } from './types';

const counts: Readonly<Record<TypeFilterValue, number>> = { all: 14, feature: 11, bug: 3 };

function renderFilter(
  type: TypeFilterValue = 'all',
  onChange: (next: TypeFilterValue) => void = vi.fn()
): ReturnType<typeof render> {
  return render(<TypeFilter type={type} counts={counts} onChange={onChange} />);
}

describe('TypeFilter', () => {
  it('names its pill group Type', () => {
    renderFilter();
    expect(screen.getByRole('group', { name: 'Type' })).toBeInTheDocument();
  });

  it('offers All, Features and Bugs in that order, each with its count', () => {
    renderFilter();
    const pills = within(screen.getByRole('group', { name: 'Type' })).getAllByRole('button');
    expect(pills.map((pill) => pill.textContent)).toEqual(['All14', 'Features11', 'Bugs3']);
  });

  it('tracks each pill under a name its count never enters', () => {
    renderFilter();
    const pills = within(screen.getByRole('group', { name: 'Type' })).getAllByRole('button');
    expect(pills.map((pill) => pill.dataset['track'])).toEqual(['All', 'Features', 'Bugs']);
  });

  it('presses the pill for the chosen type', () => {
    renderFilter('bug');
    expect(screen.getByRole('button', { name: /^Bugs/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^All/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('reports the type of the clicked pill', async () => {
    const onChange = vi.fn();
    renderFilter('all', onChange);
    await userEvent.setup().click(screen.getByRole('button', { name: /^Features/ }));
    expect(onChange).toHaveBeenCalledWith('feature');
  });

  it('draws the compact pills', () => {
    renderFilter();
    expect(screen.getByRole('button', { name: /^All/ })).toHaveClass('h-8');
  });

  it('leaves the base focus outline on every pill, so focus shows under forced colors', () => {
    renderFilter();
    const suppressions = screen
      .getAllByRole('button')
      .flatMap((pill) => [...pill.classList].filter((token) => /(^|:)(outline|ring)-/.test(token)));
    expect(suppressions).toEqual([]);
  });

  it('hides the status legend from assistive technology', () => {
    const { container } = renderFilter();
    const legend = container.querySelector('[data-roadmap-legend]');
    expect(legend).toHaveAttribute('aria-hidden', 'true');
  });

  it('names the three status icons in the legend', () => {
    const { container } = renderFilter();
    const legend = container.querySelector('[data-roadmap-legend]');
    expect([...(legend?.children ?? [])].map((entry) => entry.textContent)).toEqual([
      'In progress',
      'Planned',
      'Shipped',
    ]);
  });

  it('colours each legend icon by its status', () => {
    const { container } = renderFilter();
    const icons = [...container.querySelectorAll('[data-roadmap-legend] svg')];
    expect(icons.map((icon) => icon.getAttribute('class'))).toEqual([
      expect.stringContaining('text-primary'),
      expect.stringContaining('text-info'),
      expect.stringContaining('text-success'),
    ]);
  });

  it('draws the rotate, circle and circle-check icons in the legend', () => {
    const { container } = renderFilter();
    const icons = [...container.querySelectorAll('[data-roadmap-legend] svg')];
    expect(icons.map((icon) => icon.getAttribute('class'))).toEqual([
      expect.stringContaining('lucide-rotate-cw'),
      expect.stringMatching(/lucide-circle(?!-)/),
      expect.stringContaining('lucide-circle-check'),
    ]);
  });
});
