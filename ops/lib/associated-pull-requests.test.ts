import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveAssociatedPrLabels,
  fetchAssociatedPrLabels,
  type AssociatedPullRequest,
  type PullRequestLabelsResult,
} from './associated-pull-requests.js';

describe('resolveAssociatedPrLabels', () => {
  it('returns the labels of the single associated pull request', () => {
    const prs: readonly AssociatedPullRequest[] = [
      { number: 42, labels: [{ name: 'run-script:configure-r2-cors' }, { name: 'bug' }] },
    ];

    expect(resolveAssociatedPrLabels(prs)).toEqual<PullRequestLabelsResult>({
      ok: true,
      labels: ['run-script:configure-r2-cors', 'bug'],
    });
  });

  it('returns empty labels when no pull request is associated with the commit', () => {
    expect(resolveAssociatedPrLabels([])).toEqual<PullRequestLabelsResult>({
      ok: true,
      labels: [],
    });
  });

  it('fails loudly instead of picking one when a commit maps to multiple pull requests', () => {
    const prs: readonly AssociatedPullRequest[] = [
      { number: 42, labels: [{ name: 'run-script:configure-r2-cors' }] },
      { number: 99, labels: [{ name: 'minor' }] },
    ];

    const result = resolveAssociatedPrLabels(prs);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('#42');
    expect(result.error).toContain('#99');
    expect(result.error).toContain('2');
  });
});

describe('fetchAssociatedPrLabels', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the pull requests GitHub associates with the commit', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([{ number: 7, labels: [{ name: 'minor' }] }]),
    });

    const result = await fetchAssociatedPrLabels({
      repository: 'owner/repo',
      sha: 'abc123',
      token: 'secret-token',
    });

    expect(result).toEqual<PullRequestLabelsResult>({ ok: true, labels: ['minor'] });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo/commits/abc123/pulls',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      })
    );
  });

  it('returns the ambiguity error when the commit maps to multiple pull requests', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve([
          { number: 42, labels: [] },
          { number: 99, labels: [] },
        ]),
    });

    const result = await fetchAssociatedPrLabels({
      repository: 'owner/repo',
      sha: 'abc123',
      token: 'secret-token',
    });

    expect(result).toEqual(
      resolveAssociatedPrLabels([
        { number: 42, labels: [] },
        { number: 99, labels: [] },
      ])
    );
  });

  it('throws with the status and body when GitHub rejects the request', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('rate limited'),
    });

    await expect(
      fetchAssociatedPrLabels({ repository: 'owner/repo', sha: 'abc123', token: 'secret-token' })
    ).rejects.toThrow(/403.*rate limited/);
  });

  it('still throws when the error body itself cannot be read', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('socket closed')),
    });

    await expect(
      fetchAssociatedPrLabels({ repository: 'owner/repo', sha: 'abc123', token: 'secret-token' })
    ).rejects.toThrow(/500/);
  });
});
