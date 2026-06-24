import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { signUp } from '@/lib/auth';
import { renderRoute } from '@/test-utils/render';
import { Route } from './signup';

// Keep the real router (createFileRoute must run for the route file); mock only
// the Link the page renders.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }): React.JSX.Element => (
      <a href={to}>{children}</a>
    ),
  };
});

vi.mock('@/lib/auth', () => ({
  signUp: {
    email: vi.fn(),
  },
  authClient: {
    resendVerification: vi.fn(),
  },
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => false,
}));

vi.mock('@/capacitor/browser', () => ({
  openExternalPage: vi.fn(),
}));

describe('SignupPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders signup form with all fields', () => {
    renderRoute(Route);

    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
  }, 15_000);

  it('renders login link', () => {
    renderRoute(Route);

    expect(screen.getByRole('link', { name: /log in/i })).toHaveAttribute('href', '/login');
  });

  it('marks the brand tagline as a reading surface so it renders in the serif', () => {
    renderRoute(Route);

    expect(screen.getByText('One interface. Every feature. Private.')).toHaveAttribute(
      'data-reading'
    );
  });

  it('validates email format', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'invalid-email');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).not.toHaveBeenCalled();
  });

  it('validates password minimum length', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'short');
    await user.type(screen.getByLabelText(/confirm password/i), 'short');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).not.toHaveBeenCalled();
  });

  it('validates passwords match', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'different123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).not.toHaveBeenCalled();
    expect(screen.getByText(/passwords do not match/i)).toBeInTheDocument();
  });

  it('calls signUp.email with valid data', async () => {
    vi.mocked(signUp.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(signUp.email).toHaveBeenCalledWith({
      username: 'test_user',
      email: 'test@example.com',
      password: 'password123',
    });
  });

  it('shows success message on successful signup', async () => {
    vi.mocked(signUp.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    expect(screen.getByText(/check your email/i)).toBeInTheDocument();
  });

  it('shows inline error on signup failure', async () => {
    vi.mocked(signUp.email).mockResolvedValue({
      error: { message: 'Email already exists' },
    });
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    const errorAlert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent === 'Email already exists');
    expect(errorAlert).toBeInTheDocument();
  });

  it('shows fallback error message when error has no message', async () => {
    vi.mocked(signUp.email).mockResolvedValue({
      error: { message: 'Signup failed' },
    });
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');
    await user.type(screen.getByLabelText(/email/i), 'test@example.com');
    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /create account/i }));

    const errorAlert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent === 'Signup failed');
    expect(errorAlert).toBeInTheDocument();
  });

  it('shows success message when username is valid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/username/i), 'test_user');

    expect(screen.getByText('Looks good!')).toBeInTheDocument();
  });

  it('shows success message when email is valid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email/i), 'test@example.com');

    expect(screen.getByText('Valid email')).toBeInTheDocument();
  });

  it('shows error message when email is invalid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email/i), 'invalid');

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid email');
  });

  it('shows success message when password meets requirements as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/^password$/i), 'password123');

    expect(screen.getByText('Password meets requirements')).toBeInTheDocument();
  });

  it('shows error message when password is too short as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/^password$/i), 'short');

    expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters');
  });

  it('shows success message when confirm password matches as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'password123');

    expect(screen.getByText('Passwords match')).toBeInTheDocument();
  });

  it('shows error message when confirm password does not match as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/^password$/i), 'password123');
    await user.type(screen.getByLabelText(/confirm password/i), 'different');

    expect(screen.getAllByRole('alert')[0]).toHaveTextContent('Passwords do not match');
  });

  it('Enter on username focuses email field', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByLabelText(/username/i));
    await user.keyboard('{Enter}');

    expect(screen.getByLabelText(/email/i)).toHaveFocus();
  });

  it('Enter on email focuses password field', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByLabelText(/email/i));
    await user.keyboard('{Enter}');

    expect(screen.getByLabelText(/^password$/i)).toHaveFocus();
  });

  it('renders terms acceptance text with links', () => {
    renderRoute(Route);

    expect(screen.getByText(/by creating an account, you agree to our/i)).toBeInTheDocument();

    const termsLink = screen.getByRole('link', { name: /terms of service/i });
    expect(termsLink).toHaveAttribute('href', '/terms');
    expect(termsLink).toHaveAttribute('target', '_blank');

    const privacyLink = screen.getByRole('link', { name: /privacy policy/i });
    expect(privacyLink).toHaveAttribute('href', '/privacy');
    expect(privacyLink).toHaveAttribute('target', '_blank');
  });

  it('renders new-password field with new-password autocomplete hint', () => {
    renderRoute(Route);

    expect(screen.getByLabelText(/^password$/i)).toHaveAttribute('autocomplete', 'new-password');
  });
});
