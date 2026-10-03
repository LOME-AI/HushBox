import { describe, it, expect } from 'vitest';
import { DEVELOPMENT_ROUTES, MARKETING_ROUTES, ROUTES } from '@hushbox/shared/routes';
import {
  ROUTE_REGISTRY,
  SPA_SHELL_PATH,
  isSpaRewriteRule,
  spaRewriteRules,
  type RouteRegistry,
} from './spa-rewrites.js';

/** Pages' `_redirects` matching: a trailing `/*` matches any path below the prefix. */
function ruleMatches(rule: string, requestPath: string): boolean {
  const [source = ''] = rule.split(' ');
  return source.endsWith('/*')
    ? requestPath.startsWith(source.slice(0, -1))
    : requestPath === source;
}

function isServedByRule(requestPath: string): boolean {
  return spaRewriteRules().some((rule) => ruleMatches(rule, requestPath));
}

function concrete(route: string): string {
  return route.replaceAll(/\$[A-Za-z]+/g, 'any-id');
}

function isWithin(route: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => route === prefix || route.startsWith(`${prefix}/`));
}

const productionAppRoutes = Object.values(ROUTES).filter(
  (route) => !isWithin(route, MARKETING_ROUTES) && !DEVELOPMENT_ROUTES.includes(route)
);

function registryWith(overrides: Partial<RouteRegistry>): RouteRegistry {
  return { routes: [], marketingRoutes: [], developmentRoutes: [], ...overrides };
}

describe('spaRewriteRules', () => {
  it('pins the rewrites for the current route registry', () => {
    expect(spaRewriteRules()).toEqual([
      '/chat / 200',
      '/chat/new / 200',
      '/chat/trial / 200',
      '/billing / 200',
      '/billing-portal / 200',
      '/usage / 200',
      '/settings / 200',
      '/accessibility / 200',
      '/demo / 200',
      '/login / 200',
      '/signup / 200',
      '/verify / 200',
      '/chat/* / 200',
      '/share/c/* / 200',
      '/share/m/* / 200',
    ]);
  });

  it('serves every production app route through a rewrite', () => {
    for (const route of productionAppRoutes) {
      expect(isServedByRule(concrete(route)), `${route} has no rewrite`).toBe(true);
    }
  });

  it('gives no marketing route or page below one a rewrite', () => {
    for (const route of MARKETING_ROUTES) {
      expect(isServedByRule(route), route).toBe(false);
      expect(isServedByRule(`${route}/any-page`), `${route}/any-page`).toBe(false);
    }
  });

  it('gives no development route a rewrite', () => {
    for (const route of DEVELOPMENT_ROUTES) {
      expect(isServedByRule(concrete(route)), route).toBe(false);
    }
  });

  it('places every static rule before the first splat rule', () => {
    const rules = spaRewriteRules();
    const firstSplat = rules.findIndex((rule) => rule.split(' ')[0]?.endsWith('/*'));
    const lastStatic = rules.findLastIndex((rule) => !rule.split(' ')[0]?.endsWith('/*'));
    expect(lastStatic).toBeLessThan(firstSplat);
  });

  it('rewrites every rule to the shell with status 200', () => {
    const rules = spaRewriteRules();
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(rule.split(' ').slice(1)).toEqual([SPA_SHELL_PATH, '200']);
    }
  });

  it('derives the rules from the registry it is given', () => {
    expect(spaRewriteRules(registryWith({ routes: ['/inbox'] }))).toEqual(['/inbox / 200']);
  });

  it('covers a route with a parameter by a splat at its static prefix', () => {
    expect(spaRewriteRules(registryWith({ routes: ['/share/c/$id'] }))).toEqual([
      '/share/c/* / 200',
    ]);
  });

  it('covers a route with sub-routes by a splat below it', () => {
    expect(spaRewriteRules(registryWith({ routes: ['/inbox', '/inbox/archived'] }))).toEqual([
      '/inbox / 200',
      '/inbox/archived / 200',
      '/inbox/* / 200',
    ]);
  });

  it('writes one splat for routes sharing a prefix', () => {
    expect(spaRewriteRules(registryWith({ routes: ['/chat', '/chat/$id'] }))).toEqual([
      '/chat / 200',
      '/chat/* / 200',
    ]);
  });

  it('leaves out a route under a marketing route', () => {
    const registry = registryWith({
      routes: ['/inbox', '/news', '/news/confirmed'],
      marketingRoutes: ['/news'],
    });
    expect(spaRewriteRules(registry)).toEqual(['/inbox / 200']);
  });

  it('leaves out a development route', () => {
    const registry = registryWith({
      routes: ['/inbox', '/dev/tools'],
      developmentRoutes: ['/dev/tools'],
    });
    expect(spaRewriteRules(registry)).toEqual(['/inbox / 200']);
  });

  it('refuses a splat that would cover a marketing page', () => {
    const registry = registryWith({
      routes: ['/guide/$slug', '/guide/intro'],
      marketingRoutes: ['/guide/intro'],
    });
    expect(() => spaRewriteRules(registry)).toThrow(/\/guide\/\* .*\/guide\/intro/);
  });

  it('refuses a parameter at the root, which would rewrite every path', () => {
    expect(() => spaRewriteRules(registryWith({ routes: ['/$slug'] }))).toThrow(/\/\$slug/);
  });

  it('reads the shared route registry by default', () => {
    expect(ROUTE_REGISTRY).toEqual({
      routes: Object.values(ROUTES),
      marketingRoutes: MARKETING_ROUTES,
      developmentRoutes: DEVELOPMENT_ROUTES,
    });
  });
});

describe('isSpaRewriteRule', () => {
  it('recognises a rewrite to the shell', () => {
    expect(isSpaRewriteRule('/chat/* / 200')).toBe(true);
  });

  it('rejects a redirect of the root', () => {
    expect(isSpaRewriteRule('/ /welcome 301')).toBe(false);
  });
});
