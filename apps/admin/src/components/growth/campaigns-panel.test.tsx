import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { CampaignsPanel } from './campaigns-panel.js';
import type { GrowthCampaignWire } from '@hushbox/shared';

const runOp = vi.fn();

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => runOp,
}));

const ROWS: readonly GrowthCampaignWire[] = [
  {
    tag: 'hn-launch',
    label: 'Hacker News launch post',
    status: 'active',
    createdAt: isoAt(TEST_DAY_START),
  },
  {
    tag: 'direct',
    label: 'No tag',
    status: 'active',
    createdAt: isoAt(TEST_DAY_START - 30 * DAY_MS),
  },
  {
    tag: 'old-ad',
    label: 'Retired ad',
    status: 'archived',
    createdAt: isoAt(TEST_DAY_START - 60 * DAY_MS),
  },
];

describe('CampaignsPanel', () => {
  it('lists every campaign, archived ones included', () => {
    render(<CampaignsPanel rows={ROWS} canManage={false} />);
    expect(screen.getByText('hn-launch')).toBeInTheDocument();
    expect(screen.getByText('old-ad')).toBeInTheDocument();
  });

  it('draws no create control when the catalogue named no mutation', () => {
    render(<CampaignsPanel rows={ROWS} canManage={false} />);
    expect(screen.queryByRole('button', { name: /Create campaign/ })).not.toBeInTheDocument();
  });

  it('draws no archive control when the catalogue named no mutation', () => {
    render(<CampaignsPanel rows={ROWS} canManage={false} />);
    expect(screen.queryByRole('button', { name: /Archive/ })).not.toBeInTheDocument();
  });

  it('draws the create control when the catalogue named the mutation', () => {
    render(<CampaignsPanel rows={ROWS} canManage />);
    expect(screen.getByRole('button', { name: /Create campaign/ })).toBeInTheDocument();
  });

  it('offers archive on an active campaign', () => {
    render(<CampaignsPanel rows={ROWS} canManage />);
    expect(screen.getByRole('button', { name: 'Archive hn-launch' })).toBeInTheDocument();
  });

  it('offers no archive on a tag the operation refuses to retire', () => {
    render(<CampaignsPanel rows={ROWS} canManage />);
    expect(screen.queryByRole('button', { name: 'Archive direct' })).not.toBeInTheDocument();
  });

  it('offers no archive on an already archived campaign', () => {
    render(<CampaignsPanel rows={ROWS} canManage />);
    expect(screen.queryByRole('button', { name: 'Archive old-ad' })).not.toBeInTheDocument();
  });

  it('runs the archive through the operation modal with the tag filled in', async () => {
    runOp.mockClear();
    render(<CampaignsPanel rows={ROWS} canManage />);
    await userEvent.click(screen.getByRole('button', { name: 'Archive hn-launch' }));
    expect(runOp).toHaveBeenCalledWith({
      opName: 'growth.campaign.archive',
      initialValues: { tag: 'hn-launch' },
    });
  });

  it('runs the create through the operation modal', async () => {
    runOp.mockClear();
    render(<CampaignsPanel rows={ROWS} canManage />);
    await userEvent.click(screen.getByRole('button', { name: /Create campaign/ }));
    expect(runOp).toHaveBeenCalledWith({ opName: 'growth.campaign.create' });
  });

  it('shows the link a campaign tags, so it can be copied', () => {
    render(<CampaignsPanel rows={ROWS} canManage={false} />);
    expect(screen.getByText(/\?c=hn-launch/)).toBeInTheDocument();
  });
});

describe('CampaignsPanel scroll region', () => {
  it('scrolls the list inside a box a keyboard can reach, named by what it holds', () => {
    render(<CampaignsPanel rows={ROWS} canManage={false} />);
    const region = screen.getByRole('group', { name: 'Campaign tags, active and archived' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toContainElement(screen.getByRole('table'));
  });

  // The rows' rules run to the box's edge, so a rounded box would clip their ends.
  it('keeps the box square, so its corners cut nothing the table draws', () => {
    render(<CampaignsPanel rows={ROWS} canManage={false} />);
    const region = screen.getByRole('group', { name: 'Campaign tags, active and archived' });
    expect(region.className).not.toMatch(/(^|\s)rounded(-|\s|$)/);
  });
});

describe('CampaignsPanel link building', () => {
  it('refuses to render a link rather than inventing one when the site address is missing', () => {
    vi.stubEnv('VITE_WEB_URL', '');
    expect(() => render(<CampaignsPanel rows={ROWS} canManage={false} />)).toThrow();
    vi.unstubAllEnvs();
  });
});
