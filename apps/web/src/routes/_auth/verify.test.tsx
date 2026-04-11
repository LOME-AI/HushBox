import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { authClient } from '@/lib/auth';
import { toast } from '@hushbox/ui';
import { useSearch } from '@tanstack/react-router';

const mockNavigate = vi.fn();

// Mock TanStack Router
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => vi.fn()),
  useSearch: vi.fn(() => ({ token: 'test-token' })),
  useNavigate: vi.fn(() => mockNavigate),
  Link: ({ children, ...props }: { children: React.ReactNode; to: string; className?: string }) => (
    <a href={props.to} className={props.className}>
      {children}
    </a>
  ),
}));

// Mock shared routes
vi.mock('@hushbox/shared', () => ({
  ROUTES: {
    LOGIN: '/login',
  },
}));

// Mock auth client
vi.mock('@/lib/auth', () => ({
  authClient: {
    verifyEmail: vi.fn(),
  },
}));

// Mock UI components
vi.mock('@hushbox/ui', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('VerifyPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearch).mockReturnValue({ token: 'test-token' });
  });

  it('shows loading state initially', async () => {
    vi.mocked(authClient.verifyEmail).mockImplementation(
      // Promise that never resolves to keep loading state
      () => new Promise(() => {})
    );
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    expect(screen.getByText(/verifying/i)).toBeInTheDocument();
  });

  it('shows success state on successful verification', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({});
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument();
    });
    expect(toast.success).toHaveBeenCalledWith('Email verified successfully!');
    expect(screen.getByRole('link', { name: /continue to login/i })).toHaveAttribute(
      'href',
      '/login'
    );
  });

  it('shows error state on verification failure', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({
      error: { message: 'Invalid or expired token' },
    });
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(screen.getByText('Invalid or expired token')).toBeInTheDocument();
    expect(screen.getByText(/log in to receive a new verification email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to login/i })).toBeInTheDocument();
  });

  it('shows default error message when no specific message', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({
      error: { message: '' },
    });
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(screen.getByText('This verification link has expired.')).toBeInTheDocument();
    expect(screen.getByText(/log in to receive a new verification email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to login/i })).toHaveAttribute('href', '/login');
  });

  it('shows error state on network failure', async () => {
    vi.mocked(authClient.verifyEmail).mockRejectedValue(new Error('Network error'));
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
    expect(screen.getByText('Verification failed. Please try again.')).toBeInTheDocument();
    expect(screen.getByText(/log in to receive a new verification email/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to login/i })).toBeInTheDocument();
  });
});

describe('VerifyPage without token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSearch).mockReturnValue({ token: undefined });
  });

  it('shows error when no token provided', async () => {
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    expect(screen.getByText(/no verification token/i)).toBeInTheDocument();
  });
});
