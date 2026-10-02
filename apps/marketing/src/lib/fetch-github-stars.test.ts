import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchGitHubStars } from './fetch-github-stars';

describe('fetchGitHubStars', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns star count from GitHub API', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ stargazers_count: 42 }),
    } as Response);

    const stars = await fetchGitHubStars();
    expect(stars).toBe(42);
  });

  it('calls the correct GitHub API endpoint', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ stargazers_count: 0 }),
    } as Response);

    await fetchGitHubStars();
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/LOME-AI/HushBox',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'application/vnd.github.v3+json',
        }),
      })
    );
  });

  it('returns 0 when API returns non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const stars = await fetchGitHubStars();
    expect(stars).toBe(0);
  });

  it('returns 0 when fetch throws', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('Network error'));

    const stars = await fetchGitHubStars();
    expect(stars).toBe(0);
  });

  it('returns 0 when response has no stargazers_count', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    const stars = await fetchGitHubStars();
    expect(stars).toBe(0);
  });
});
