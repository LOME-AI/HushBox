import * as React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { CampaignFilter } from './campaign-filter.js';
import type { GrowthCampaignWire } from '@hushbox/shared';

function campaignRow(tag: string): GrowthCampaignWire {
  return { tag, label: tag, status: 'active', createdAt: isoAt(TEST_DAY_START) };
}

const CAMPAIGNS: readonly GrowthCampaignWire[] = [
  campaignRow('hn-launch'),
  campaignRow('x-thread'),
  campaignRow('direct'),
];

function renderFilter(
  overrides: Partial<React.ComponentProps<typeof CampaignFilter>> = {}
): ReturnType<typeof render> {
  return render(
    <CampaignFilter campaigns={CAMPAIGNS} selected={[]} onToggle={vi.fn()} {...overrides} />
  );
}

/** The control an operator opens the list from. */
function trigger(): HTMLElement {
  return screen.getByRole('button', { name: /^Campaigns/ });
}

describe('CampaignFilter', () => {
  it('names itself so the control says what it narrows', () => {
    renderFilter();
    expect(trigger()).toBeInTheDocument();
  });

  it('keeps the global focus outline on its control', () => {
    renderFilter();
    expect(
      [...trigger().classList].filter((token) => /(^|:)outline-(none|hidden)$/.test(token))
    ).toEqual([]);
  });

  it('names the open list for the campaigns it holds', async () => {
    renderFilter();
    await userEvent.click(trigger());
    await screen.findByRole('checkbox', { name: 'hn-launch' });
    expect(document.querySelector('[data-slot="popover-content"]')).toHaveAttribute(
      'aria-label',
      'Campaigns'
    );
  });

  it('draws each campaign as a check field on the control border', async () => {
    renderFilter();
    await userEvent.click(trigger());
    expect(await screen.findByRole('checkbox', { name: 'hn-launch' })).toHaveClass(
      'border-border-control'
    );
  });

  it('counts every campaign while the selection names none', () => {
    renderFilter();
    expect(trigger()).toHaveTextContent('All 3');
  });

  it('counts the campaigns selected against the campaigns there are', () => {
    renderFilter({ selected: ['hn-launch', 'x-thread'] });
    expect(trigger()).toHaveTextContent('2 of 3');
  });

  it('says so where the read returned no campaign at all', () => {
    renderFilter({ campaigns: [] });
    expect(trigger()).toHaveTextContent('No campaigns');
  });

  it('holds the list closed until an operator opens it', () => {
    renderFilter();
    expect(screen.queryByRole('checkbox', { name: 'hn-launch' })).not.toBeInTheDocument();
  });

  it('lists every campaign the read returned once opened', async () => {
    renderFilter();
    await userEvent.click(trigger());
    expect(await screen.findByRole('checkbox', { name: 'hn-launch' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'x-thread' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'direct' })).toBeInTheDocument();
  });

  it('scrolls a list longer than the room it opens into rather than running off the screen', async () => {
    renderFilter();
    await userEvent.click(trigger());
    await screen.findByRole('checkbox', { name: 'hn-launch' });
    const panel = document.querySelector('[data-slot="popover-content"]');
    expect(panel).toHaveClass('overflow-y-auto');
    expect(panel?.className).toContain('var(--radix-popover-content-available-height)');
  });

  it('shows a selected campaign as chosen', async () => {
    renderFilter({ selected: ['x-thread'] });
    await userEvent.click(trigger());
    expect(await screen.findByRole('checkbox', { name: 'x-thread' })).toBeChecked();
  });

  it('reports a campaign an operator adds to the selection', async () => {
    const onToggle = vi.fn();
    renderFilter({ onToggle });
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole('checkbox', { name: 'direct' }));
    expect(onToggle).toHaveBeenCalledWith('direct', true);
  });

  it('reports a campaign an operator drops from the selection', async () => {
    const onToggle = vi.fn();
    renderFilter({ onToggle, selected: ['direct'] });
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole('checkbox', { name: 'direct' }));
    expect(onToggle).toHaveBeenCalledWith('direct', false);
  });

  it('reaches the list by keyboard alone', async () => {
    renderFilter();
    await userEvent.tab();
    expect(trigger()).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByRole('checkbox', { name: 'hn-launch' })).toBeInTheDocument();
  });
});
