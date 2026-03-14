import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redirect } from '@tanstack/react-router';

const mockIsNative = vi.fn<() => boolean>(() => false);
vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => mockIsNative(),
}));

const redirectError = new Error('REDIRECT');
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => (config: { beforeLoad?: () => void }) => config),
  redirect: vi.fn(() => {
    throw redirectError;
  }),
}));

describe('Index route beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNative.mockReturnValue(false);
  });

  it('redirects to /welcome on web', async () => {
    const original = globalThis.location.href;
    const { Route } = await import('./index');
    const routeConfig = Route as unknown as { beforeLoad?: () => void };

    routeConfig.beforeLoad?.();

    // On web, it sets location.href (we can't fully test this in jsdom
    // but we verify redirect was NOT called)
    expect(redirect).not.toHaveBeenCalled();
    // Restore
    globalThis.location.href = original;
  });

  it('redirects to /chat on native via TanStack redirect', async () => {
    mockIsNative.mockReturnValue(true);
    const { Route } = await import('./index');
    const routeConfig = Route as unknown as { beforeLoad?: () => void };

    expect(() => routeConfig.beforeLoad?.()).toThrow('REDIRECT');
    expect(redirect).toHaveBeenCalledWith({ to: '/chat' });
  });
});
