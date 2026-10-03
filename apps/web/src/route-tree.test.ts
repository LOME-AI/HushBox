import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DEVELOPMENT_ROUTES } from '@hushbox/shared/routes';
import { spaRewriteRules } from '../../../scripts/lib/bundling/spa-rewrites';

// Pages serves the shell only for paths a rewrite rule names, and the rules derive
// from the shared route registry, so a route the router serves but the registry
// lacks answers 404 in production. The generated tree is read as text: importing
// it would load every route component.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTE_TREE = readFileSync(path.resolve(HERE, 'routeTree.gen.ts'), 'utf8');

function servedPaths(): string[] {
  const paths = [...ROUTE_TREE.matchAll(/fullPath: '([^']*)'/g)].map(([, fullPath = '']) =>
    fullPath.length > 1 && fullPath.endsWith('/') ? fullPath.slice(0, -1) : fullPath
  );
  return [...new Set(paths)];
}

/** Pages' `_redirects` matching: a trailing `/*` matches any path below the prefix. */
function isRewritten(route: string): boolean {
  const requestPath = route.replaceAll(/\$[A-Za-z]+/g, 'any-id');
  return spaRewriteRules().some((rule) => {
    const [source = ''] = rule.split(' ');
    return source.endsWith('/*')
      ? requestPath.startsWith(source.slice(0, -1))
      : requestPath === source;
  });
}

describe('the generated route tree', () => {
  it('serves at least one path the test can read', () => {
    expect(servedPaths()).toContain('/login');
  });

  it('serves no path the Pages rewrites or the development routes leave out', () => {
    const uncovered = servedPaths().filter(
      (route) => route !== '/' && !DEVELOPMENT_ROUTES.includes(route) && !isRewritten(route)
    );

    expect(uncovered).toEqual([]);
  });
});
