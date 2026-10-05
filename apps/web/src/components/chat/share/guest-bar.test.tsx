import * as React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ROUTES, TEST_IDS, TEST_ID_BUILDERS, noticeText } from '@hushbox/shared';
import { GuestBar } from './guest-bar';

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({
      to,
      children,
      ...rest
    }: Readonly<
      { to: string; children: React.ReactNode } & React.ComponentProps<'a'>
    >): React.JSX.Element => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  };
});

const READ_ONLY_ID = TEST_ID_BUILDERS.budgetMessage('conversation_read_only');

describe('GuestBar', () => {
  it('shows the read-only notice under its budget-message id', () => {
    render(<GuestBar signedIn={false} />);

    expect(screen.getByTestId(READ_ONLY_ID)).toHaveTextContent(
      noticeText('conversation_read_only')
    );
  });

  it('draws the notice in the error tone', () => {
    render(<GuestBar signedIn={false} />);

    expect(screen.getByTestId(READ_ONLY_ID)).toHaveAttribute('data-tone', 'error');
  });

  it('offers a signed-out visitor Sign Up, linking to sign-up', () => {
    render(<GuestBar signedIn={false} />);

    const signUp = screen.getByTestId(TEST_IDS.guestBarSignUp);
    expect(signUp).toHaveAccessibleName('Sign Up');
    expect(signUp).toHaveAttribute('href', ROUTES.SIGNUP);
  });

  it('offers a signed-in visitor no Sign Up', () => {
    render(<GuestBar signedIn={true} />);

    expect(screen.queryByTestId(TEST_IDS.guestBarSignUp)).not.toBeInTheDocument();
  });

  it('keeps the notice for a signed-in visitor', () => {
    render(<GuestBar signedIn={true} />);

    expect(screen.getByTestId(READ_ONLY_ID)).toBeInTheDocument();
  });

  it('holds the notice and Sign Up in the guest bar', () => {
    render(<GuestBar signedIn={false} />);

    const bar = screen.getByTestId(TEST_IDS.guestBar);
    expect(bar).toContainElement(screen.getByTestId(READ_ONLY_ID));
    expect(bar).toContainElement(screen.getByTestId(TEST_IDS.guestBarSignUp));
  });
});
