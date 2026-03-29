import { describe, it, expect } from 'vitest';
import { ROUTES, MARKETING_BASE_URL } from './routes.js';

describe('ROUTES constants', () => {
  const routeEntries = Object.entries(ROUTES);
  const routeValues = Object.values(ROUTES);

  it('contains the expected number of route definitions', () => {
    expect(routeEntries.length).toBe(20);
  });

  it('has all values as non-empty strings', () => {
    for (const [key, value] of routeEntries) {
      expect(typeof value).toBe('string');
      expect(value.length, `ROUTES.${key} is empty`).toBeGreaterThan(0);
    }
  });

  it('has all values starting with /', () => {
    for (const [key, value] of routeEntries) {
      expect(value.startsWith('/'), `ROUTES.${key} = "${value}" does not start with /`).toBe(true);
    }
  });

  it('has no duplicate route values', () => {
    const unique = new Set(routeValues);
    expect(unique.size, `Found duplicate route values`).toBe(routeValues.length);
  });

  it('has parameter placeholders prefixed with $', () => {
    const parameterRoutes = routeEntries.filter(([_, value]) => value.includes('$'));
    expect(parameterRoutes.length).toBeGreaterThan(0);
    for (const [key, value] of parameterRoutes) {
      expect(value, `ROUTES.${key} has parameter not prefixed with $`).toMatch(/\$[a-zA-Z]+/);
    }
  });

  it('matches the expected route definitions', () => {
    expect(ROUTES).toMatchInlineSnapshot(`
      {
        "BILLING": "/billing",
        "CHAT": "/chat",
        "CHAT_ID": "/chat/$id",
        "CHAT_NEW": "/chat/new",
        "CHAT_TRIAL": "/chat/trial",
        "DEV_ASSETS": "/dev/assets",
        "DEV_EMAILS": "/dev/emails",
        "DEV_PERSONAS": "/dev/personas",
        "DEV_RENDER_ASSET": "/dev/render-asset/$name",
        "LOGIN": "/login",
        "MARKETING": "/welcome",
        "PRIVACY": "/privacy",
        "PROJECTS": "/projects",
        "SETTINGS": "/settings",
        "SHARE_CONVERSATION": "/share/c/$conversationId",
        "SHARE_MESSAGE": "/share/m/$shareId",
        "SIGNUP": "/signup",
        "TERMS": "/terms",
        "USAGE": "/usage",
        "VERIFY": "/verify",
      }
    `);
  });
  it('MARKETING route is not root to prevent Astro/Vite index.html conflict', () => {
    expect(ROUTES.MARKETING).not.toBe('/');
  });
});

describe('MARKETING_BASE_URL', () => {
  it('is the production hushbox.ai URL', () => {
    expect(MARKETING_BASE_URL).toBe('https://hushbox.ai');
  });

  it('has no trailing slash', () => {
    expect(MARKETING_BASE_URL.endsWith('/')).toBe(false);
  });
});
