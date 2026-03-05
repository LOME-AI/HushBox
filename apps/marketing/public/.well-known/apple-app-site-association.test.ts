import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const AASA_PATH = path.join(import.meta.dirname, 'apple-app-site-association');

interface AASADetail {
  appIDs: string[];
  components: { '/': string }[];
}

interface AASA {
  applinks: {
    details: AASADetail[];
  };
}

function readAASA(): AASA {
  const content = readFileSync(AASA_PATH, 'utf8');
  return JSON.parse(content) as AASA;
}

describe('apple-app-site-association', () => {
  it('is valid JSON', () => {
    expect(() => readAASA()).not.toThrow();
  });

  it('has applinks.details array', () => {
    const aasa = readAASA();
    expect(aasa.applinks).toBeDefined();
    expect(aasa.applinks.details).toBeInstanceOf(Array);
    expect(aasa.applinks.details).toHaveLength(1);
  });

  it('has an appID with the correct bundle identifier', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    expect(detail.appIDs).toHaveLength(1);
    expect(detail.appIDs[0]).toMatch(/\.ai\.hushbox\.app$/);
  });

  it('includes /chat/* path component', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).toContain('/chat/*');
  });

  it('includes /billing path component', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).toContain('/billing');
  });

  it('includes /settings path component', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).toContain('/settings');
  });

  it('includes /login and /signup path components', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).toContain('/login');
    expect(paths).toContain('/signup');
  });

  it('does not include /privacy or /terms (legal pages open in browser)', () => {
    const aasa = readAASA();
    const detail = aasa.applinks.details[0];
    const paths = detail.components.map((c) => c['/']);
    expect(paths).not.toContain('/privacy');
    expect(paths).not.toContain('/terms');
  });
});
