import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redirect } from '@tanstack/react-router';

// Mock the redirect function - TanStack Router redirect throws
const redirectError = new Error('REDIRECT');
vi.mock('@tanstack/react-router', () => ({
  redirect: vi.fn(() => {
    throw redirectError;
  }),
}));

// Mock better-auth/react
vi.mock('better-auth/react', () => ({
  createAuthClient: vi.fn(() => ({
    useSession: vi.fn(),
    signIn: {
      email: vi.fn(),
    },
    signUp: {
      email: vi.fn(),
    },
    signOut: vi.fn(),
    getSession: vi.fn(),
  })),
}));

describe('auth client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports authClient', async () => {
    const { authClient } = await import('./auth');
    expect(authClient).toBeDefined();
  });

  it('exports useSession hook', async () => {
    const { useSession } = await import('./auth');
    expect(useSession).toBeDefined();
  });

  it('exports signIn function', async () => {
    const { signIn } = await import('./auth');
    expect(signIn).toBeDefined();
    expect(signIn.email).toBeDefined();
  });

  it('exports signUp function', async () => {
    const { signUp } = await import('./auth');
    expect(signUp).toBeDefined();
    expect(signUp.email).toBeDefined();
  });

  it('exports signOut function', async () => {
    const { signOut } = await import('./auth');
    expect(signOut).toBeDefined();
  });
});

describe('requireAuth', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('throws redirect when no session', async () => {
    vi.doMock('better-auth/react', () => ({
      createAuthClient: vi.fn(() => ({
        useSession: vi.fn(),
        signIn: { email: vi.fn() },
        signUp: { email: vi.fn() },
        signOut: vi.fn(),
        getSession: vi.fn().mockResolvedValue({ data: null }),
      })),
    }));

    const { requireAuth } = await import('./auth');

    await expect(requireAuth()).rejects.toThrow('REDIRECT');
    expect(redirect).toHaveBeenCalledWith({ to: '/login' });
  });

  it('returns session data when authenticated', async () => {
    const mockSession = {
      user: { id: 'user-1', email: 'test@example.com' },
      session: { id: 'session-1' },
    };

    vi.doMock('better-auth/react', () => ({
      createAuthClient: vi.fn(() => ({
        useSession: vi.fn(),
        signIn: { email: vi.fn() },
        signUp: { email: vi.fn() },
        signOut: vi.fn(),
        getSession: vi.fn().mockResolvedValue({ data: mockSession }),
      })),
    }));

    const { requireAuth } = await import('./auth');

    const result = await requireAuth();

    expect(result).toEqual(mockSession);
    expect(redirect).not.toHaveBeenCalled();
  });
});
