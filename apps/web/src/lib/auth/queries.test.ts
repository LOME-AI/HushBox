import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import { accountKeys, authKeys, instructionsQueryOptions, meQueryOptions } from './queries';

describe('authKeys', () => {
  it('roots under auth', () => {
    expect(authKeys.all).toEqual(['auth']);
  });

  it('builds the me key from the root', () => {
    expect(authKeys.me()).toEqual(['auth', 'me']);
  });
});

describe('accountKeys', () => {
  it('roots under account', () => {
    expect(accountKeys.all).toEqual(['account']);
  });

  it('builds the instructions key from the root', () => {
    expect(accountKeys.instructions()).toEqual(['account', 'instructions']);
  });
});

describe('meQueryOptions', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keys the query under auth/me via the factory', () => {
    expect(meQueryOptions().queryKey).toEqual(authKeys.me());
  });

  it('fetches the current user from /auth/me via the typed client', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({ user: { id: 'u1' } }),
    } as unknown as Response);

    const data = await meQueryOptions().queryFn();

    expect(data).toEqual({ user: { id: 'u1' } });
    const meCall = mockFetch.mock.calls.find(([input]) =>
      urlFromFetchInput(input).includes('/auth/me')
    );
    expect(meCall).toBeDefined();
  });
});

describe('instructionsQueryOptions', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keys the query under account/instructions via the factory', () => {
    expect(instructionsQueryOptions().queryKey).toEqual(accountKeys.instructions());
  });

  it('fetches the stored blob from the account slice route via the typed client', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => Promise.resolve({ instructions: 'blob' }),
    } as unknown as Response);

    const data = await instructionsQueryOptions().queryFn();

    expect(data).toEqual({ instructions: 'blob' });
    const instructionsCall = mockFetch.mock.calls.find(([input]) =>
      urlFromFetchInput(input).includes('/account/instructions')
    );
    expect(instructionsCall).toBeDefined();
  });
});
