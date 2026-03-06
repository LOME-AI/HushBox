const GITHUB_API_URL = 'https://api.github.com/repos/LOME-AI/HushBox';

export async function fetchGitHubStars(): Promise<number> {
  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!response.ok) {
      return 0;
    }

    const data = (await response.json()) as { stargazers_count?: number };
    return data.stargazers_count ?? 0;
  } catch {
    return 0;
  }
}
