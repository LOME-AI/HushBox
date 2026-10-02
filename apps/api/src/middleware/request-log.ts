import { matchedRoutes } from 'hono/route';
import { createEnvUtilities } from '@hushbox/shared';
import { readPipelineVariable } from './pipeline-markers.js';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../lib/context/index.js';

/**
 * The matched route TEMPLATE ('/conversations/:id'), never the concrete URL —
 * path tokens and query strings can carry user content (share ids, tokens).
 * The terminal handler's registration path is the last non-wildcard match;
 * a request nothing routed (404) answers the placeholder instead.
 */
function routeTemplate(matched: readonly { path: string }[]): string {
  for (const route of matched.toReversed()) {
    if (route.path !== '*' && route.path !== '/*') return route.path;
  }
  return 'unmatched';
}

/**
 * Dev-only per-request log line through the typed SafeLogFields logger
 * (no-op in production). Runs ahead of the pipeline, so envUtils is built
 * directly (the documented pre-`envMiddleware` pattern) and the logger is
 * read after `next()` — by then the bindings stage has installed it; if a
 * defect kept the pipeline from running there is nothing typed to log with,
 * and the request is skipped rather than logged loosely.
 */
export function requestLog(): MiddlewareHandler<AppEnv> {
  // eslint-disable-next-line unicorn/consistent-function-scoping -- middleware factory pattern
  return async (c, next) => {
    if (createEnvUtilities(c.env).isProduction) {
      return next();
    }
    const startedAt = Date.now();
    await next();
    const logger = readPipelineVariable(c, 'logger');
    if (logger === undefined) return;
    // Unlatched, unlike the capture: every availability refusal names its
    // dependency here, where a local reader triages each 503 on its own.
    const failure = readPipelineVariable(c, 'dependencyFailure');
    // The `msg` below is a PARSE CONTRACT, not free text: the mobile-test log
    // slice (scripts/lib/mobile/extract-mobile-api-log.ts) keys on this exact
    // literal, reading it out of wrangler's per-port debug log rather than its
    // stdout — this logs at `info`, which the `error` log level the dev stack starts
    // wrangler at (scripts/wrangler-dev.ts) keeps off the console, while the debug
    // file is written before that level check. It is written INLINE, never a shared
    // constant, because the `redaction/logger-msg-literal` rule requires a syntactic
    // string literal here (so redaction can statically prove no content leaks); the
    // consumer names its own copy and documents the dependency direction.
    logger.info('request completed', {
      method: c.req.method,
      route: routeTemplate(matchedRoutes(c)),
      statusCode: c.res.status,
      latencyMs: Date.now() - startedAt,
      ...(failure === undefined
        ? {}
        : {
            dependency: failure.dependency,
            dependencyFailure: failure.failure,
            dependencyLate: failure.late,
          }),
    });
  };
}
