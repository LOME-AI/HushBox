import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { pageColumnHeaders, PagesPanel } from './pages-panel.js';

const TOTALS = [
  { key: '/welcome', visitors: 1102, landings: 980, overflow: false },
  { key: '/pricing', visitors: 488, landings: null, overflow: false },
];

describe('PagesPanel', () => {
  it('closes with a line naming the page counted most and what a landing is', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    expect(screen.getByText(/\/welcome was counted most/)).toBeInTheDocument();
  });

  it('lists each page with its visitors', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    expect(screen.getByRole('row', { name: /\/welcome 1,102 980/ })).toBeInTheDocument();
  });

  it('states a page with no landing figure as unknown rather than zero', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    expect(screen.getByRole('row', { name: /\/pricing 488 No data/ })).toBeInTheDocument();
  });

  it('marks a figure the ceiling cut off as a floor', () => {
    render(
      <PagesPanel
        totals={[{ key: '/a', visitors: 100_000, landings: null, overflow: true }]}
        bucketing="daily"
      />
    );
    expect(screen.getByText('100,000+')).toBeInTheDocument();
  });

  it('says nothing was counted when there are no pages', () => {
    render(<PagesPanel totals={[]} bucketing="daily" />);
    expect(screen.getByText(/Nothing was counted/i)).toBeInTheDocument();
  });
});

describe('PagesPanel column headings', () => {
  it('says which buckets the visitor figure was summed from', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    expect(
      screen.getByRole('columnheader', { name: 'Visitors (daily uniques, summed)' })
    ).toBeInTheDocument();
  });

  it('says which buckets the landing figure was summed from', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    expect(
      screen.getByRole('columnheader', { name: 'Landings (daily uniques, summed)' })
    ).toBeInTheDocument();
  });

  it('follows the hour grain into the headings', () => {
    render(<PagesPanel totals={TOTALS} bucketing="hourly" />);
    expect(
      screen.getByRole('columnheader', { name: 'Visitors (hourly uniques, summed)' })
    ).toBeInTheDocument();
  });

  it('draws every heading from the definition the export writes from', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    const headings = pageColumnHeaders('daily');
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      headings.path,
      headings.visitors,
      headings.landings,
    ]);
  });
});

describe('PagesPanel bounded box', () => {
  it('scrolls its rows and columns inside a box a keyboard can reach and name', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    const box = document.querySelector('[data-slot="pages-scrollport"]');
    expect(box).not.toBeNull();
    expect(box).toHaveAttribute('tabindex', '0');
    expect(box).toHaveAttribute('role', 'group');
    expect(box).toHaveAccessibleName(/pages by visitors and landings/i);
    expect((box as HTMLElement).className).toMatch(/\boverflow-auto\b/);
  });

  it('holds the list to a bound in rem, so a long tail does not stretch the panel', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    const box = document.querySelector('[data-slot="pages-scrollport"]');
    expect((box as HTMLElement).className).toMatch(/\bmax-h-\d+\b/);
  });

  it('keeps the column names in view while the rows scroll under them', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    for (const heading of screen.getAllByRole('columnheader')) {
      expect(heading.className).toMatch(/\bsticky\b/);
    }
  });

  it('says how many pages the list holds, so the bound never reads as a truncation', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    expect(screen.getByText(/All 2 pages counted are listed/)).toBeInTheDocument();
  });

  it('leaves that count outside the box, so the bound never scrolls it away', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    const box = document.querySelector('[data-slot="pages-scrollport"]');
    expect(box?.contains(screen.getByText(/All 2 pages counted are listed/))).toBe(false);
  });

  it('leaves the landing note outside that box, so it never scrolls out of view', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    const box = document.querySelector('[data-slot="pages-scrollport"]');
    expect(box?.contains(screen.getByText(/A landing is a visit that began/))).toBe(false);
  });

  // Its rows stop short of the box's corners, so the rounding clips nothing.
  it('draws the box rounded, its own shape rather than the scroll region’s', () => {
    render(<PagesPanel totals={TOTALS} bucketing="daily" />);
    expect(document.querySelector('[data-slot="pages-scrollport"]')).toHaveClass('rounded-sm');
  });
});
