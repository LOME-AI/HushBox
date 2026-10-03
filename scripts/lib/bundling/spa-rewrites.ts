/**
 * The `_redirects` rules that make Cloudflare Pages serve the web app's shell
 * for every route the production app owns.
 *
 * The merged bundle carries the marketing site's top-level `404.html`, and a
 * Pages project with one gets no single-page-application fallback, so each app
 * route needs a `200` rewrite of its own. The rules derive from the shared
 * route registry: a catch-all would turn every unknown URL into a soft 200 and
 * defeat the 404 page.
 */
import { DEVELOPMENT_ROUTES, MARKETING_ROUTES, ROUTES } from '@hushbox/shared/routes';

export interface RouteRegistry {
  readonly routes: readonly string[];
  readonly marketingRoutes: readonly string[];
  readonly developmentRoutes: readonly string[];
}

export const ROUTE_REGISTRY: RouteRegistry = {
  routes: Object.values(ROUTES),
  marketingRoutes: MARKETING_ROUTES,
  developmentRoutes: DEVELOPMENT_ROUTES,
};

/**
 * The rewrite target that serves the shell. Not `/index.html`: Pages answers
 * that path with a redirect to `/`, and a rewrite to `/` serves the file
 * without applying the root's own redirect rule.
 */
export const SPA_SHELL_PATH = '/';

const REWRITE_SUFFIX = ` ${SPA_SHELL_PATH} 200`;

function isWithin(route: string, prefix: string): boolean {
  return route === prefix || route.startsWith(`${prefix}/`);
}

/** The route's path before its first `$param` segment, or the route when it has none. */
function staticPrefix(route: string): string {
  const segments = route.split('/');
  const firstParameter = segments.findIndex((segment) => segment.startsWith('$'));
  return firstParameter === -1 ? route : segments.slice(0, firstParameter).join('/');
}

/**
 * One rule per line, static rules first: Pages requires a static rule to
 * precede every splat rule.
 */
export function spaRewriteRules(registry: RouteRegistry = ROUTE_REGISTRY): string[] {
  const excluded = [...registry.marketingRoutes, ...registry.developmentRoutes];
  const appRoutes = registry.routes.filter(
    (route) => !excluded.some((prefix) => isWithin(route, prefix))
  );

  const statics = appRoutes.filter((route) => staticPrefix(route) === route);
  const splats = new Set<string>();
  for (const route of appRoutes) {
    const prefix = staticPrefix(route);
    if (prefix === '') {
      throw new Error(`${route} has a parameter at the root; its splat would rewrite every path`);
    }
    if (prefix !== route || appRoutes.some((other) => other.startsWith(`${route}/`))) {
      splats.add(prefix);
    }
  }

  for (const splat of splats) {
    const covered = excluded.find((route) => route.startsWith(`${splat}/`));
    if (covered !== undefined) {
      throw new Error(`${splat}/* would rewrite ${covered}, which the app does not serve`);
    }
  }

  return [...statics, ...[...splats].map((splat) => `${splat}/*`)].map(
    (source) => `${source}${REWRITE_SUFFIX}`
  );
}

/** Whether a `_redirects` line is a rewrite to the shell, the class of rule this module writes. */
export function isSpaRewriteRule(line: string): boolean {
  return line.endsWith(REWRITE_SUFFIX);
}
