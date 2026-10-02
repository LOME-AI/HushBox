import { describe, it, expect } from 'vitest';
import { GET } from '../pages/robots.txt';
import type { APIContext } from 'astro';

const SITE = new URL('https://example.test');

function contextFor(site?: URL): APIContext {
  return { site } as unknown as APIContext;
}

async function readRobots(): Promise<string> {
  return GET(contextFor(SITE)).text();
}

async function directives(prefix: 'Allow' | 'Disallow'): Promise<string[]> {
  const body = await readRobots();
  return body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${prefix}:`))
    .map((line) => line.slice(`${prefix}:`.length).trim());
}

describe('robots.txt', () => {
  it('does not Allow the empty SPA-shell routes /chat, /login, /signup', async () => {
    const allows = await directives('Allow');
    expect(allows).not.toContain('/chat');
    expect(allows).not.toContain('/login');
    expect(allows).not.toContain('/signup');
  });

  it('disallows the interactive /demo route', async () => {
    expect(await directives('Disallow')).toContain('/demo');
  });

  it('does not Disallow /api, which this origin does not serve', async () => {
    expect(await directives('Disallow')).not.toContain('/api');
  });

  it('still allows the public marketing pages', async () => {
    const allows = await directives('Allow');
    expect(allows).toContain('/terms');
    expect(allows).toContain('/privacy');
    expect(allows).toContain('/blog');
  });

  it('derives the Sitemap URL from the configured site', async () => {
    expect(await readRobots()).toContain('Sitemap: https://example.test/sitemap-index.xml');
  });

  it('throws rather than emitting a default origin when the site is unconfigured', () => {
    expect(() => GET(contextFor())).toThrow(/site/);
  });

  it('serves plain text', () => {
    expect(GET(contextFor(SITE)).headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
  });
});
