import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { authClient } from '@/lib/auth';
import { toast } from '@lome-chat/ui';
import { useSearch } from '@tanstack/react-router';

const mockNavigate = vi.fn();

// Mock TanStack Router
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => vi.fn()),
  useSearch: vi.fn(() => ({ token: 'test-token' })),
  useNavigate: vi.fn(() => mockNavigate),
}));

// Mock auth client
vi.mock('@/lib/auth', () => ({
  authClient: {
    verifyEmail: vi.fn(),
  },
}));

// Mock UI components
vi.mock('@lome-chat/ui', () => ({
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
      () => new Promise<{ data: null; error: null }>(() => undefined)
    );
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    expect(screen.getByText(/verifying/i)).toBeInTheDocument();
  });

  it('redirects to /chat on successful verification', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({
      data: {},
      error: null,
    });
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
    expect(toast.success).toHaveBeenCalledWith('Email verified successfully!');
  });

  it('shows error state on verification failure', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({
      data: null,
      error: { message: 'Invalid or expired token' },
    });
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
  });

  it('shows default error message when no specific message', async () => {
    vi.mocked(authClient.verifyEmail).mockResolvedValue({
      data: null,
      error: {},
    });
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
  });

  it('shows error state on network failure', async () => {
    vi.mocked(authClient.verifyEmail).mockRejectedValue(new Error('Network error'));
    const { VerifyPage } = await import('./verify');

    render(<VerifyPage />);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /verification failed/i })).toBeInTheDocument();
    });
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
