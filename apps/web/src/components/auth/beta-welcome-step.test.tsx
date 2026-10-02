import { describe, it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/test-utils/render';
import { BetaWelcomeStep } from './beta-welcome-step';
import type * as React from 'react';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }): React.JSX.Element => (
      <a href={to}>{children}</a>
    ),
  };
});

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => false,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalPage: vi.fn(),
}));

describe('BetaWelcomeStep', () => {
  it('names the step with its welcome heading', () => {
    renderWithProviders(<BetaWelcomeStep onJoin={vi.fn()} />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'Welcome to the HushBox beta' })
    ).toBeInTheDocument();
  });

  it('holds the heads-up item in a region named by its heading', () => {
    renderWithProviders(<BetaWelcomeStep onJoin={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'Heads up' });
    expect(within(region).getAllByRole('listitem')).toHaveLength(1);
  });

  it('holds the two commitments in a region named by its heading', () => {
    renderWithProviders(<BetaWelcomeStep onJoin={vi.fn()} />);

    const region = screen.getByRole('region', { name: 'What never changes' });
    expect(
      within(region)
        .getAllByRole('listitem')
        .map((item) => item.textContent)
    ).toEqual([
      "We can't read your messages.",
      'Your purchased credit is never lost to our mistakes.',
    ]);
  });

  it('calls onJoin when Join the beta is selected', async () => {
    const onJoin = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<BetaWelcomeStep onJoin={onJoin} />);

    await user.click(screen.getByRole('button', { name: 'Join the beta' }));

    expect(onJoin).toHaveBeenCalledOnce();
  });

  it('links Log in to the log in page', () => {
    renderWithProviders(<BetaWelcomeStep onJoin={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login');
  });

  it('opens the beta terms in a new tab', () => {
    renderWithProviders(<BetaWelcomeStep onJoin={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'Read the full beta terms' })).toHaveAttribute(
      'target',
      '_blank'
    );
  });
});
