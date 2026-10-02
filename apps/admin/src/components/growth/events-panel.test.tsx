import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { EventsPanel, eventTotals } from './events-panel.js';
import type { GrowthEventRowWire } from '@hushbox/shared';

function eventRow(over: Partial<GrowthEventRowWire>): GrowthEventRowWire {
  return {
    hour: isoAt(TEST_DAY_START + 10 * HOUR_MS),
    campaign: 'direct',
    eventName: 'link:/signup',
    path: '/welcome',
    visitors: 10,
    overflow: false,
    ...over,
  };
}

describe('eventTotals', () => {
  it('sums one event and page pair across the hours in the window', () => {
    const totals = eventTotals([
      eventRow({}),
      eventRow({ hour: isoAt(TEST_DAY_START + 11 * HOUR_MS), visitors: 5 }),
    ]);
    expect(totals).toEqual([
      { eventName: 'link:/signup', path: '/welcome', visitors: 15, overflow: false },
    ]);
  });

  it('keeps the same event on two pages apart', () => {
    const totals = eventTotals([eventRow({}), eventRow({ path: '/pricing' })]);
    expect(totals).toHaveLength(2);
  });

  it('marks a pair overflowed when any of its hours hit the ceiling', () => {
    const totals = eventTotals([eventRow({}), eventRow({ visitors: 100_000, overflow: true })]);
    expect(totals[0]?.overflow).toBe(true);
  });

  it('orders the pairs largest first', () => {
    const totals = eventTotals([
      eventRow({ eventName: 'small', visitors: 1 }),
      eventRow({ eventName: 'big', visitors: 9 }),
    ]);
    expect(totals.map((total) => total.eventName)).toEqual(['big', 'small']);
  });
});

describe('EventsPanel', () => {
  it('lists each event with the page it fired on', () => {
    render(<EventsPanel rows={[eventRow({})]} page={0} hasMore={false} onPageChange={() => {}} />);
    expect(screen.getByRole('row', { name: /link:\/signup \/welcome 10/ })).toBeInTheDocument();
  });

  it('names the figure as summed hourly counts rather than distinct people', () => {
    render(<EventsPanel rows={[eventRow({})]} page={0} hasMore={false} onPageChange={() => {}} />);
    expect(screen.getByRole('columnheader', { name: /summed/i })).toBeInTheDocument();
  });

  it('offers no next page when the server said this is the last', () => {
    render(<EventsPanel rows={[eventRow({})]} page={0} hasMore={false} onPageChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Next page' })).not.toBeInTheDocument();
  });

  it('offers the next page when the server said another follows', () => {
    render(<EventsPanel rows={[eventRow({})]} page={0} hasMore onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();
  });

  it('offers no previous page on the first one', () => {
    render(<EventsPanel rows={[eventRow({})]} page={0} hasMore onPageChange={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Previous page' })).not.toBeInTheDocument();
  });

  it('says nothing was counted when there are no events', () => {
    render(<EventsPanel rows={[]} page={0} hasMore={false} onPageChange={() => {}} />);
    expect(screen.getByText(/No named events/i)).toBeInTheDocument();
  });
});

describe('EventsPanel scroll region', () => {
  it('scrolls the table inside a box a keyboard can reach, named by what it holds', () => {
    render(<EventsPanel rows={[eventRow({})]} page={0} hasMore={false} onPageChange={() => {}} />);
    const region = screen.getByRole('group', { name: 'Named events by page' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
  });

  // The rows' rules run to the box's edge, so a rounded box would clip their ends.
  it('keeps the box square, so its corners cut nothing the table draws', () => {
    render(<EventsPanel rows={[eventRow({})]} page={0} hasMore={false} onPageChange={() => {}} />);
    expect(screen.getByRole('group', { name: 'Named events by page' }).className).not.toMatch(
      /(^|\s)rounded(-|\s|$)/
    );
  });
});

describe('EventsPanel paging', () => {
  it('asks for the next page when the control is used', async () => {
    const onPageChange = vi.fn();
    render(<EventsPanel rows={[eventRow({})]} page={0} hasMore onPageChange={onPageChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it('offers a way back once past the first page', () => {
    render(<EventsPanel rows={[eventRow({})]} page={2} hasMore onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeInTheDocument();
  });

  it('asks for the previous page when the control is used', async () => {
    const onPageChange = vi.fn();
    render(<EventsPanel rows={[eventRow({})]} page={2} hasMore onPageChange={onPageChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});
