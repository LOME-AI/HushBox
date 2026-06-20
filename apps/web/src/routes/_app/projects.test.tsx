import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { requireAuth } from '@/lib/auth';
import { renderRoute } from '@/test-utils/render';
import { Route } from './projects';

vi.mock('@/lib/auth', () => ({
  requireAuth: vi.fn(),
}));

describe('/_app/projects route component', () => {
  it('renders the Projects placeholder', () => {
    renderRoute(Route);

    expect(screen.getByText('Projects')).toBeInTheDocument();
  });
});

describe('/_app/projects route beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gates the route behind requireAuth', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
      },
    });

    const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
    await beforeLoad?.();

    expect(requireAuth).toHaveBeenCalledTimes(1);
  });

  it('propagates the redirect when requireAuth rejects', async () => {
    vi.mocked(requireAuth).mockRejectedValue(new Error('REDIRECT'));

    const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
    await expect(beforeLoad?.()).rejects.toThrow('REDIRECT');
  });
});
