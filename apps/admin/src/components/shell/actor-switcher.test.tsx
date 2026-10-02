import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { TEST_IDS } from '@hushbox/shared';
import { queryClient } from '@/providers/query-provider';
import { DEV_ADMIN_ACTORS, setDevActor } from '@/lib/dev-actor';
import { ActorSwitcher } from './actor-switcher.js';

const { envMock } = vi.hoisted(() => ({ envMock: { devAuthEnabled: true } }));
vi.mock('@/lib/env', () => ({ isDevAuthEnabled: () => envMock.devAuthEnabled }));

const [ADMIN, OPS, VIEWER] = DEV_ADMIN_ACTORS;

beforeEach(() => {
  envMock.devAuthEnabled = true;
});

afterEach(() => {
  // Inside `act` because a switcher rendered by the test it is resetting after
  // is still mounted here: the store notifies it, and an unwrapped update warns.
  act(() => {
    setDevActor(ADMIN);
  });
  queryClient.clear();
});

describe('ActorSwitcher', () => {
  it('production-leak guard: renders nothing when dev auth is disabled (production shape)', () => {
    envMock.devAuthEnabled = false;
    render(<ActorSwitcher />);
    expect(screen.queryByTestId(TEST_IDS.adminActorSwitcher)).not.toBeInTheDocument();
  });

  it('renders when dev auth is enabled (local dev or E2E)', () => {
    render(<ActorSwitcher />);
    expect(screen.getByTestId(TEST_IDS.adminActorSwitcher)).toBeInTheDocument();
  });

  // The tooltip is copy a human reads in the interface, which is the text
  // DESIGN section 6 bans the long dash from; nothing else gates it.
  it('carries no long dash in the copy it shows a reader', () => {
    render(<ActorSwitcher />);
    const title = screen.getByTestId(TEST_IDS.adminActorSwitcher).getAttribute('title');
    // Asserted present first: a control with no tooltip would satisfy the
    // absence below while showing the reader nothing at all.
    expect(title).toBeTruthy();
    expect(title).not.toMatch(/[\u2013\u2014]/u);
  });

  // Declares a class rather than measuring layout, which this runtime has none
  // of: the group's buttons wrap onto a second line so the group stays inside
  // the topbar's line instead of overhanging it onto the sidebar at the
  // accessibility widget's largest font tier.
  it('declares a group whose buttons may wrap', () => {
    render(<ActorSwitcher />);
    expect(screen.getByTestId(TEST_IDS.adminActorSwitcher).className).toContain('flex-wrap');
  });

  it('offers every allowlisted dev actor, not a pair', () => {
    render(<ActorSwitcher />);
    for (const actor of DEV_ADMIN_ACTORS) {
      expect(screen.getByRole('button', { name: actor })).toBeInTheDocument();
    }
  });

  it('marks the current actor and only the current actor', () => {
    render(<ActorSwitcher />);
    expect(screen.getByRole('button', { name: ADMIN })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: OPS })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: VIEWER })).toHaveAttribute('aria-pressed', 'false');
  });

  // The two claims a toggle's test could not make: a third identity is one
  // click from the first, and the way back does not run through the second.
  it('reaches the read-only actor in one click from the operator it starts on', async () => {
    const user = userEvent.setup();
    render(<ActorSwitcher />);

    await user.click(screen.getByRole('button', { name: VIEWER }));

    expect(screen.getByRole('button', { name: VIEWER })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: ADMIN })).toHaveAttribute('aria-pressed', 'false');
  });

  it('returns from the read-only actor to a named operator without passing through the other', async () => {
    const user = userEvent.setup();
    render(<ActorSwitcher />);

    await user.click(screen.getByRole('button', { name: VIEWER }));
    await user.click(screen.getByRole('button', { name: ADMIN }));

    expect(screen.getByRole('button', { name: ADMIN })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: OPS })).toHaveAttribute('aria-pressed', 'false');
  });

  it('drops what the previous identity read', async () => {
    const user = userEvent.setup();
    render(<ActorSwitcher />);
    queryClient.setQueryData(['admin', 'ops'], { role: 'operator' });

    await user.click(screen.getByRole('button', { name: VIEWER }));

    expect(queryClient.getQueryData(['admin', 'ops'])).toBeUndefined();
  });

  it('re-reads what a mounted screen is showing under the identity just chosen', async () => {
    const user = userEvent.setup();
    const read = vi.fn(() => Promise.resolve({ role: 'operator' }));
    function Screen(): React.JSX.Element {
      const { data } = useQuery({ queryKey: ['admin', 'ops'], queryFn: read });
      return <p>{data === undefined ? 'nothing read' : 'read'}</p>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <Screen />
        <ActorSwitcher />
      </QueryClientProvider>
    );
    await screen.findByText('read');

    await user.click(screen.getByRole('button', { name: VIEWER }));

    await waitFor(() => {
      expect(read).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps what was read when the chosen actor is the current one', async () => {
    const user = userEvent.setup();
    render(<ActorSwitcher />);
    queryClient.setQueryData(['admin', 'ops'], { role: 'operator' });

    await user.click(screen.getByRole('button', { name: ADMIN }));

    expect(queryClient.getQueryData(['admin', 'ops'])).toEqual({ role: 'operator' });
  });
});
