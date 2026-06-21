import { describe, it, expect, vi, beforeEach } from 'vitest';
import { redirect } from '@tanstack/react-router';
import { Route } from './index';

const { mockIsNative, redirectError } = vi.hoisted(() => ({
  mockIsNative: vi.fn<() => boolean>(() => false),
  redirectError: new Error('REDIRECT'),
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: (): boolean => mockIsNative(),
}));

// Keep the real router (createFileRoute must run); mock only redirect, which the
// guard throws on native.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    redirect: vi.fn(() => {
      throw redirectError;
    }),
  };
});

describe('Index route beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsNative.mockReturnValue(false);
  });

  it('redirects to /welcome on web', () => {
    const original = globalThis.location.href;
    const beforeLoad = Route.options.beforeLoad as (() => void) | undefined;

    beforeLoad?.();

    // On web, it sets location.href (we can't fully test this in jsdom
    // but we verify redirect was NOT called)
    expect(redirect).not.toHaveBeenCalled();
    globalThis.location.href = original;
  });

  it('redirects to /chat on native via TanStack redirect', () => {
    mockIsNative.mockReturnValue(true);
    const beforeLoad = Route.options.beforeLoad as (() => void) | undefined;

    expect(() => beforeLoad?.()).toThrow('REDIRECT');
    expect(redirect).toHaveBeenCalledWith({ to: '/chat' });
  });
});
