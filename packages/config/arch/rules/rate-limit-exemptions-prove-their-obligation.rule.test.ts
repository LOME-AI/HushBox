import path from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule, {
  POSTURE_CAPABILITY_MODULE,
  POSTURE_MAP_MODULE,
  POSTURE_VOCABULARY_MODULE,
} from './rate-limit-exemptions-prove-their-obligation.rule.js';
import type { ObjectLiteralExpression, PropertyAssignment, SourceFile } from 'ts-morph';

/** The vocabulary module, declaring the classes the rule must have a checker for. */
function vocabulary(classes: readonly string[]): string {
  const members = classes.map((name) => `'${name}'`).join(', ');
  return `export const RATE_LIMIT_EXEMPTIONS = [${members}] as const;\n`;
}

/** The capability module, whose binding factory says what a bound posture is. */
function capability(returned: string): string {
  return `export function bindRoutePosture(layers) {
  const [first, ...rest] = layers;
  return ${returned};
}\n`;
}

const BOUND_POSTURE = `{ kind: 'named', keyedBy: identitiesOf(first, rest) }`;

/** The posture map, one entry per line, in the shape the composition root writes. */
function postureMap(entries: Record<string, string>): string {
  const lines = Object.entries(entries)
    .map(([key, posture]) => `  '${key}': ${posture},`)
    .join('\n');
  return `export const ROUTE_POSTURES: RoutePostureMap = {\n${lines}\n} as const satisfies Record<RouteKey, RoutePosture>;\n`;
}

interface Fixture {
  /** Declared exemption classes; defaults to the two this rule checks. */
  readonly classes?: readonly string[];
  /** Route key to posture literal, written as one literal map. */
  readonly postures?: Record<string, string>;
  /** The whole posture-map module, for shapes {@link postureMap} cannot write. */
  readonly mapSource?: string;
  /** What the binding factory returns; defaults to the `named` posture it builds today. */
  readonly bound?: string;
  /** The whole capability module, for shapes {@link capability} cannot write. */
  readonly capabilitySource?: string;
  /** Route-registering files, by repo-relative path. */
  readonly files: Record<string, string>;
}

function projectWith(fixture: Fixture): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(
    POSTURE_VOCABULARY_MODULE,
    vocabulary(fixture.classes ?? ['signature-gated-webhook', 'constant-cost'])
  );
  project.createSourceFile(
    POSTURE_MAP_MODULE,
    fixture.mapSource ?? postureMap(fixture.postures ?? {})
  );
  project.createSourceFile(
    POSTURE_CAPABILITY_MODULE,
    fixture.capabilitySource ?? capability(fixture.bound ?? BOUND_POSTURE)
  );
  for (const [filePath, source] of Object.entries(fixture.files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const BILLING_ROUTES = 'apps/api/src/slices/billing/routes.ts';
const UPDATES_ROUTES = 'apps/api/src/slices/updates/routes.ts';

const WEBHOOK_EXEMPT = `{ kind: 'exempt', exemption: 'signature-gated-webhook' }`;
const CONSTANT_COST_EXEMPT = `{ kind: 'exempt', exemption: 'constant-cost' }`;

/** A billing manifest whose webhook handler body is the argument. */
function billingWebhook(body: string): string {
  return `export function createBillingManifest(deps) {
  return defineSliceManifest({
    basePath: '/billing',
    routes: new Hono<AppEnv>()
      .post('/webhooks/payment', routeClass('public'), async (c) => {
${body}
      }),
  });
}\n`;
}

/** An updates manifest whose `/current` handler body is the argument. */
function updatesCurrent(body: string, modifier = ''): string {
  return `export function createUpdatesManifest() {
  return defineSliceManifest({
    basePath: '/updates',
    routes: new Hono<AppEnv>()
      .get('/current', routeClass('public'), ${modifier}(c) => {
${body}
      }),
  });
}\n`;
}

const VERIFIED_WEBHOOK = `        const rawBody = await c.req.text();
        const verified = await deps.webhookVerifier(c.env).verify(rawBody, {
          signature: c.req.header('webhook-signature'),
        });
        if (verified.isErr()) return respondDomainError(c, verified.error);
        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`;

/**
 * A middleware written as a registration argument, reaching a store handle. The
 * touch sits before the `next()` that enters the terminal handler, so it
 * precedes everything the handler does — the verifier included.
 */
const STORE_TOUCHING_MIDDLEWARE = `(c, next) => {
        const store = c.var.db;
        return next(store);
      }`;

/** A middleware written the same way, reaching no store handle. */
const REQUEST_READING_MIDDLEWARE = `(c, next) => {
        c.set('webhookId', c.req.header('webhook-id'));
        return next();
      }`;

/** A billing manifest whose webhook registration carries the middleware argument. */
function billingWebhookBehind(middleware: string): string {
  return `export function createBillingManifest(deps) {
  return defineSliceManifest({
    basePath: '/billing',
    routes: new Hono<AppEnv>().post(
      '/webhooks/payment',
      routeClass('public'),
      ${middleware},
      async (c) => {
${VERIFIED_WEBHOOK}
      }
    ),
  });
}\n`;
}

describe('the rule reaches what it claims to check', () => {
  it('throws when the posture vocabulary module is absent from the scanned tree', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(POSTURE_MAP_MODULE, postureMap({}));

    expect(() => rule.check(project)).toThrow(/lib\/rate-limit\/posture\.ts/);
  });

  it('throws when the posture map module is absent from the scanned tree', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(POSTURE_VOCABULARY_MODULE, vocabulary(['signature-gated-webhook']));

    expect(() => rule.check(project)).toThrow(/composition\/rate-limit-posture\.ts/);
  });

  it('throws when a declared exemption class carries no obligation checker here', () => {
    const project = projectWith({
      classes: ['signature-gated-webhook', 'constant-cost', 'in-domain-flow'],
      postures: {},
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/in-domain-flow/);
  });

  it('throws when the declared class list cannot be read from the vocabulary module', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      POSTURE_VOCABULARY_MODULE,
      'export const RATE_LIMIT_EXEMPTIONS = buildExemptions();\n'
    );
    project.createSourceFile(POSTURE_MAP_MODULE, postureMap({}));

    expect(() => rule.check(project)).toThrow(/RATE_LIMIT_EXEMPTIONS/);
  });

  it('throws when the posture map is no longer an object literal it can read', () => {
    const project = projectWith({
      classes: ['constant-cost'],
      mapSource: 'export const ROUTE_POSTURES = buildMap();\n',
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/ROUTE_POSTURES/);
  });

  it('throws when an exempt entry names a class this rule has no obligation for', () => {
    const project = projectWith({
      postures: { '$get /updates/current': `{ kind: 'exempt', exemption: 'in-domain-flow' }` },
      files: { [UPDATES_ROUTES]: updatesCurrent(`        return c.json({}, 200);`) },
    });

    expect(() => rule.check(project)).toThrow(/no obligation/);
  });

  it('throws when an exempt entry carries an exemption it cannot read as a literal', () => {
    const project = projectWith({
      postures: { '$get /updates/current': `{ kind: 'exempt', exemption: WEBHOOK_CLASS }` },
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/cannot/);
  });

  it('throws when a map entry carries a kind it cannot read as a literal', () => {
    const project = projectWith({
      postures: { '$get /a': `{ kind: postureKind, exemption: 'constant-cost' }` },
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/kind/);
  });

  it('throws when a map entry declares no kind at all', () => {
    const project = projectWith({
      postures: { '$get /a': `{ exemption: 'constant-cost' }` },
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/kind/);
  });

  it('throws when a map entry declares a posture that is not an object literal', () => {
    const project = projectWith({ postures: { '$get /a': 'DEFAULT_POSTURE' }, files: {} });

    expect(() => rule.check(project)).toThrow(/\$get \/a/);
  });

  it('throws when a map entry names its route with something other than a literal', () => {
    const project = projectWith({
      classes: ['constant-cost'],
      mapSource: `export const ROUTE_POSTURES = {
  [DERIVED_KEY]: { kind: 'exempt', exemption: 'constant-cost' },
} as const;\n`,
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/ROUTE_POSTURES/);
  });

  it('throws when the map carries a property that is not a route declaration', () => {
    const project = projectWith({
      classes: ['constant-cost'],
      mapSource: `export const ROUTE_POSTURES = {
  healthPosture,
} as const;\n`,
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/ROUTE_POSTURES/);
  });

  it('names the posture-map line the unreadable entry is written on', () => {
    const project = projectWith({
      classes: ['constant-cost'],
      mapSource: `export const ROUTE_POSTURES = {
  '$get /health': { kind: 'default' },
  ...INHERITED_POSTURES,
} as const;\n`,
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/line 3/);
  });

  it('throws when the declared class list carries an element it cannot read', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      POSTURE_VOCABULARY_MODULE,
      `export const RATE_LIMIT_EXEMPTIONS = ['constant-cost', ...MORE_EXEMPTIONS] as const;\n`
    );
    project.createSourceFile(POSTURE_MAP_MODULE, postureMap({}));

    expect(() => rule.check(project)).toThrow(/RATE_LIMIT_EXEMPTIONS/);
  });

  it('throws when a declared class names an inherited member rather than a checker', () => {
    const project = projectWith({
      classes: ['constant-cost', 'toString'],
      postures: {},
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/toString/);
  });

  it('flags an exemption declared for a route the api tree registers nowhere', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {},
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: POSTURE_MAP_MODULE });
    expect(violations[0]?.message).toMatch(/registers no route/);
  });

  it('reports the posture-map line the unlocatable exemption is declared on', () => {
    const project = projectWith({
      postures: {
        '$get /health': `{ kind: 'default' }`,
        '$post /billing/webhooks/payment': WEBHOOK_EXEMPT,
      },
      files: {},
    });

    expect(rule.check(project)[0]).toMatchObject({ line: 3 });
  });
});

describe('signature-gated-webhook', () => {
  it('accepts a webhook handler that verifies before it touches the database', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: { [BILLING_ROUTES]: billingWebhook(VERIFIED_WEBHOOK) },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a webhook handler that reads the database before verifying', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: billingWebhook(
          `        const rawBody = await c.req.text();
        await recordEvidence(c.var.db);
        const verified = await deps.webhookVerifier(c.env).verify(rawBody, {});
        if (verified.isErr()) return respondDomainError(c, verified.error);
        return c.json({ received: true }, 200);`
        ),
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/before its signature verifier/);
  });

  it('flags a webhook handler that fetches before verifying', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: billingWebhook(
          `        const rawBody = await c.req.text();
        const ping = fetch('https://provider.example/ping');
        const verified = await deps.webhookVerifier(c.env).verify(rawBody, {});
        return c.json({ received: true }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a webhook handler that never invokes the verifier', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: billingWebhook(
          `        const rawBody = await c.req.text();
        const verified = await schemaGuard.verify(rawBody);
        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`
        ),
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/never invokes/);
  });

  it('does not accept a verifier named only in a comment', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: billingWebhook(
          `        // deps.webhookVerifier(c.env).verify runs in middleware for this subtree.
        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a webhook handler that reaches a store through the context getter first', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: billingWebhook(
          `        const rawBody = await c.req.text();
        c.get('sideBand')(recordEvidence());
        const verified = await deps.webhookVerifier(c.env).verify(rawBody, {});
        if (verified.isErr()) return respondDomainError(c, verified.error);
        return c.json({ received: true }, 200);`
        ),
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/before its signature verifier/);
  });

  it('accepts the raw-body read that signature verification requires', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: billingWebhook(
          `        const rawBody = await c.req.text();
        const verified = await deps.webhookVerifier(c.env).verify(rawBody, {});
        return c.json({ received: true }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  /**
   * The `.catch` is the fixture, not decoration: it puts the awaited call's receiver at
   * `c.req.text()` rather than at `c.req`, which is the only shape reaching the
   * `startsWith` half of `isRequestRead`'s receiver test. Drop it and this passes
   * with that half deleted.
   */
  it('accepts a raw-body read guarded by a chained catch', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: billingWebhook(
          `        const rawBody = await c.req.text().catch(() => '');
        const verified = await deps.webhookVerifier(c.env).verify(rawBody, {});
        return c.json({ received: true }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a webhook handler that calls the verifier dependency without verifying', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: billingWebhook(
          `        const rawBody = await c.req.text();
        const parsed = deps.webhookVerifier(c.env).parse(rawBody);
        return c.json({ received: true, id: parsed.id }, 200);`
        ),
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/never invokes/);
  });

  it('flags a webhook whose handler is defined in another file', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: `import { handlePaymentWebhook } from './handlers.js';
export function createBillingManifest(deps) {
  return defineSliceManifest({
    basePath: '/billing',
    routes: new Hono<AppEnv>()
      .post('/webhooks/payment', routeClass('public'), handlePaymentWebhook),
  });
}\n`,
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/another file/);
  });

  it('flags a store touch in a middleware the registration carries', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: { [BILLING_ROUTES]: billingWebhookBehind(STORE_TOUCHING_MIDDLEWARE) },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/reaches the 'db' handle before its signature verifier/);
  });

  /**
   * The shape a position filter over the registration's nodes would miss: the
   * hoisted handler puts the verifier call above the argument list, so the
   * middleware's touch is written after it and runs before it. Inline the
   * handler and this passes with the non-handler roots read positionally.
   */
  it('flags a store touch in a middleware written below a hoisted handler', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: {
        [BILLING_ROUTES]: `const paymentWebhook = async (c) => {
${VERIFIED_WEBHOOK}
};
export function createBillingManifest(deps) {
  return defineSliceManifest({
    basePath: '/billing',
    routes: new Hono<AppEnv>().post(
      '/webhooks/payment',
      routeClass('public'),
      ${STORE_TOUCHING_MIDDLEWARE},
      paymentWebhook
    ),
  });
}\n`,
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/before its signature verifier/);
  });

  it('accepts a middleware the registration carries that reads only the request', () => {
    const project = projectWith({
      postures: { '$post /billing/webhooks/payment': WEBHOOK_EXEMPT },
      files: { [BILLING_ROUTES]: billingWebhookBehind(REQUEST_READING_MIDDLEWARE) },
    });

    expect(rule.check(project)).toEqual([]);
  });
});

describe('constant-cost', () => {
  it('accepts a handler that reads only the request and its env', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const env: UpdatesBindings = c.env;
        const version = resolveServedVersion(getVersionOverride(), env.APP_VERSION);
        return c.json({ version }, 200, { 'cache-control': 'no-store' });`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a handler that awaits anything off the request', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const row = await readServedVersion(deps.stores);
        return c.json({ version: row.version }, 200);`,
          'async '
        ),
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/constant-cost/);
  });

  it('flags a handler that reaches the request database handle', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const db = c.var.db;
        return c.json({ version: readVersion(db) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that reaches the request redis handle', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        return c.json({ version: readVersion(c.var.redis) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that calls fetch', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const ping = fetch('https://builds.example/current');
        return c.json({ version: 'unknown' }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that defers work through the side band', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        c.var.sideBand(recordHit(deps.stores));
        return c.json({ version: 'v1' }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that discards a call through the void operator', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        void recordHit(deps.stores);
        return c.json({ version: 'v1' }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that chains a promise instead of awaiting it', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        recordHit(deps.stores).then(noop);
        return c.json({ version: 'v1' }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a hoisted handler that awaits, so hoisting subtracts nothing', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: `const currentHandler = async (c) => {
  const row = await readServedVersion(deps.stores);
  return c.json({ version: row.version }, 200);
};
export function createUpdatesManifest() {
  return defineSliceManifest({
    basePath: '/updates',
    routes: new Hono<AppEnv>().get('/current', routeClass('public'), currentHandler),
  });
}\n`,
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  /**
   * Two touches, in two roots the walk reaches in the opposite order to the
   * source: the hoisted declaration is read last but written first, so only a
   * sort by position names the `fetch`. Put both touches in one root, or give
   * them the same description, and the assertion goes inert.
   */
  it('names the touch written first when a hoisted handler precedes the registration', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: `const currentHandler = (c) => {
  const ping = fetch('https://builds.example/current');
  return c.json({ version: 'unknown', ping }, 200);
};
export function createUpdatesManifest() {
  return defineSliceManifest({
    basePath: '/updates',
    routes: new Hono<AppEnv>().get(
      '/current',
      routeClass('public'),
      (c, next) => {
        const store = c.var.db;
        return next(store);
      },
      currentHandler
    ),
  });
}\n`,
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/calls fetch/);
  });

  it('flags a store touch in a middleware the registration carries', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: `export function createUpdatesManifest() {
  return defineSliceManifest({
    basePath: '/updates',
    routes: new Hono<AppEnv>().get(
      '/current',
      routeClass('public'),
      ${STORE_TOUCHING_MIDDLEWARE},
      (c) => c.json({ version: 'pinned' }, 200)
    ),
  });
}\n`,
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/reaches the 'db' handle/);
  });

  it('flags a handler that awaits a value rather than a call', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const version = await pendingVersion;
        return c.json({ version }, 200);`,
          'async '
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a handler reading a request variable that is not a store handle', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        return c.json({ kind: c.var.principal.kind }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a handler that reaches a store handle through the context getter', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        c.get('sideBand')(recordHit(deps.stores));
        return c.json({ version: 'v1' }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that destructures a store handle off the request context', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const { sideBand } = c.var;
        sideBand(recordHit(deps.stores));
        return c.json({ version: 'v1' }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that carries the whole context bag into a local', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const vars = c.var;
        return c.json({ version: readVersion(vars) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that names a context variable through a value it cannot read', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const handle = c.get(HANDLE_NAME);
        return c.json({ version: readVersion(handle) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that binds the whole context bag with a rest element', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const { ...vars } = c.var;
        return c.json({ version: readVersion(vars) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that renames a store handle as it destructures it', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const { sideBand: emit } = c.var;
        emit(recordHit(deps.stores));
        return c.json({ version: 'v1' }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that destructures a store handle under a quoted name', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const { 'sideBand': emit } = c.var;
        emit(recordHit(deps.stores));
        return c.json({ version: 'v1' }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that destructures the context bag by a computed member', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const { [HANDLE_NAME]: handle } = c.var;
        return c.json({ version: readVersion(handle) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that indexes a store handle out of the context bag', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        c.var['sideBand'](recordHit(deps.stores));
        return c.json({ version: 'v1' }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that indexes the context bag by a computed key', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const handle = c.var[HANDLE_NAME];
        return c.json({ version: readVersion(handle) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that carries the context getter into a local', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const getter = c.get;
        return c.json({ version: readVersion(getter) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that hands the context getter to a helper', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        return c.json({ version: readVersion(c.get) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a handler that hands the whole context bag to a helper', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        return c.json({ version: readVersion(c.var) }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a handler that indexes a non-store variable out of the context bag', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        return c.json({ kind: c.var['principal'].kind }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a handler that calls get on something other than the request context', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const cached = servedVersions.get(platform);
        return c.json({ version: cached }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a handler reading a non-store variable through the context getter', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const { isProduction } = c.get('envUtils');
        return c.json({ isProduction }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a handler destructuring a non-store variable off the request context', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const { principal } = c.var;
        return c.json({ kind: principal.kind }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a handler destructuring a non-store variable under a quoted name', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const { 'principal': who } = c.var;
        return c.json({ kind: who.kind }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not flag a store handle named only in a comment', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        // The served version is env-borne; c.var.db is deliberately untouched.
        return c.json({ version: c.env.APP_VERSION }, 200);`
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });
});

describe('what the rule leaves alone', () => {
  it('ignores a route declared named', () => {
    const project = projectWith({
      postures: { '$get /updates/current': `{ kind: 'named', keyedBy: ['ip'] }` },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const row = await readServedVersion(deps.stores);
        return c.json({ version: row.version }, 200);`,
          'async '
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a route declared default', () => {
    const project = projectWith({
      postures: { '$get /updates/current': `{ kind: 'default' }` },
      files: {
        [UPDATES_ROUTES]: updatesCurrent(
          `        const row = await readServedVersion(deps.stores);
        return c.json({ version: row.version }, 200);`,
          'async '
        ),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('resolves a route registered outside any manifest to no registration', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: `app.get('/updates/current', routeClass('public'), async (c) =>
  c.json(await readServedVersion(deps.stores), 200));\n`,
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/registers no route/);
  });

  it('reads no mount prefix out of a manifest call handed a prepared options object', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: `export function createUpdatesManifest() {
  return defineSliceManifest(updatesManifestOptions);
}\n`,
      },
    });

    expect(rule.check(project)[0]?.message).toMatch(/registers no route/);
  });

  it('reads no registration written outside the manifest in the same file', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: `standalone.get('/current', routeClass('public'), (c) => c.json({}, 200));
export function createUpdatesManifest() {
  return defineSliceManifest({
    basePath: '/updates',
    routes: new Hono<AppEnv>().get('/download', routeClass('public'), (c) => c.json({}, 200)),
  });
}\n`,
      },
    });

    expect(rule.check(project)[0]?.message).toMatch(/registers no route/);
  });

  it('reads no registration written after the manifest in the same file', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: `export function createUpdatesManifest() {
  return defineSliceManifest({
    basePath: '/updates',
    routes: new Hono<AppEnv>().get('/download', routeClass('public'), (c) => c.json({}, 200)),
  });
}
standalone.get('/current', routeClass('public'), (c) => c.json({}, 200));\n`,
      },
    });

    expect(rule.check(project)[0]?.message).toMatch(/registers no route/);
  });

  it('reads no mount prefix out of a call to anything but the manifest factory', () => {
    const project = projectWith({
      postures: { '$get /decoy/current': CONSTANT_COST_EXEMPT },
      files: {
        [UPDATES_ROUTES]: `export const updatesDocs = describeSliceRoutes({
  basePath: '/decoy',
  routes: new Hono<AppEnv>().get('/current', routeClass('public'), (c) => c.json({}, 200)),
});
export function createUpdatesManifest() {
  return defineSliceManifest({
    basePath: '/updates',
    routes: new Hono<AppEnv>().get('/current', routeClass('public'), (c) => c.json({}, 200)),
  });
}\n`,
      },
    });

    expect(rule.check(project)[0]?.message).toMatch(/registers no route/);
  });

  it('reads no registration out of a test file', () => {
    const project = projectWith({
      postures: { '$get /updates/current': CONSTANT_COST_EXEMPT },
      files: {
        'apps/api/src/slices/updates/routes.test.ts': updatesCurrent(
          `        const row = await readServedVersion(deps.stores);
        return c.json({ version: row.version }, 200);`,
          'async '
        ),
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/registers no route/);
  });
});

const BILLING_FRAGMENT = 'apps/api/src/slices/billing/rate-limit-posture.ts';
const BILLING_BARREL = 'apps/api/src/slices/billing/index.ts';

/**
 * How the fixture fragment reaches the binding factory. The real fragments that
 * bind import it from the rate-limit barrel instead; this project carries no
 * barrel module, so that spelling resolves no further than its own import
 * specifier and the rule throws.
 */
const FACTORY_IMPORT = `import { bindRoutePosture } from '../../lib/rate-limit/capability.js';\n`;

/** A factory of the fragment's own, wearing the real one's name. */
const FACTORY_SHADOW = `function bindRoutePosture(layers) {
  return { kind: 'exempt', exemption: 'signature-gated-webhook' };
}
`;

/** One route's posture, bound through whichever `bindRoutePosture` is in scope. */
const BOUND = `bindRoutePosture([{ identity: 'ip', countedAt: 'edge', definition: paymentWebhookLimit }])`;

/**
 * A slice's posture fragment and the barrel that republishes it. `preamble`
 * carries whatever the fragment declares above the map.
 */
function billingFragment(entries: Record<string, string>, preamble = ''): Record<string, string> {
  const lines = Object.entries(entries)
    .map(([key, posture]) => `  '${key}': ${posture},`)
    .join('\n');
  return {
    [BILLING_FRAGMENT]: `${preamble}export const BILLING_ROUTE_POSTURES = {\n${lines}\n} satisfies Record<BillingRouteKey, CarriedRoutePosture>;\n`,
    [BILLING_BARREL]: `export { BILLING_ROUTE_POSTURES } from './rate-limit-posture.js';\n`,
  };
}

/** The posture map as a merge over the fragments. */
function mergedMap(body: string): string {
  return `import { BILLING_ROUTE_POSTURES } from '../slices/billing/index.js';

export const ROUTE_POSTURES: RoutePostureMap = {
${body}
} as const satisfies Record<RouteKey, RoutePosture>;
`;
}

describe('declarations that arrive through a spread', () => {
  it('resolves a spread to the fragment it names and checks the exemptions written there', () => {
    const project = projectWith({
      mapSource: mergedMap('  ...BILLING_ROUTE_POSTURES,'),
      files: {
        ...billingFragment({ '$post /billing/webhooks/payment': WEBHOOK_EXEMPT }),
        [BILLING_ROUTES]: billingWebhook(`        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`),
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/never invokes the injected/);
  });

  it('accepts a spread-supplied exemption whose obligation the handler discharges', () => {
    const project = projectWith({
      mapSource: mergedMap('  ...BILLING_ROUTE_POSTURES,'),
      files: {
        ...billingFragment({ '$post /billing/webhooks/payment': WEBHOOK_EXEMPT }),
        [BILLING_ROUTES]: billingWebhook(VERIFIED_WEBHOOK),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reports a spread-supplied exemption against the fragment line that declares it', () => {
    const project = projectWith({
      mapSource: mergedMap('  ...BILLING_ROUTE_POSTURES,'),
      files: billingFragment({ '$post /billing/webhooks/payment': WEBHOOK_EXEMPT }),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BILLING_FRAGMENT, line: 2 });
    expect(violations[0]?.message).toMatch(/registers no route/);
  });

  it('passes over a spread-supplied posture that is not an exemption', () => {
    const project = projectWith({
      mapSource: mergedMap('  ...BILLING_ROUTE_POSTURES,'),
      files: {
        ...billingFragment({ '$post /billing/webhooks/payment': `{ kind: 'default' }` }),
        [BILLING_ROUTES]: billingWebhook(`        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads entries written beside the spreads in the map itself', () => {
    const project = projectWith({
      mapSource: mergedMap(
        `  ...BILLING_ROUTE_POSTURES,\n  '$get /updates/current': ${CONSTANT_COST_EXEMPT},`
      ),
      files: {
        ...billingFragment({ '$post /billing/webhooks/payment': WEBHOOK_EXEMPT }),
        [BILLING_ROUTES]: billingWebhook(VERIFIED_WEBHOOK),
        [UPDATES_ROUTES]: updatesCurrent(
          `        const row = await readServedVersion(deps.stores);
        return c.json({ version: row.version }, 200);`,
          'async '
        ),
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/awaits work/);
  });

  it('follows a spread through a merge object declared in the map module', () => {
    const project = projectWith({
      mapSource: `import { BILLING_ROUTE_POSTURES } from '../slices/billing/index.js';

const SLICE_ROUTE_POSTURES = {
  ...BILLING_ROUTE_POSTURES,
};

export const ROUTE_POSTURES: RoutePostureMap = {
  ...SLICE_ROUTE_POSTURES,
} as const satisfies Record<RouteKey, RoutePosture>;
`,
      files: {
        ...billingFragment({ '$post /billing/webhooks/payment': WEBHOOK_EXEMPT }),
        [BILLING_ROUTES]: billingWebhook(`        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`),
      },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/never invokes the injected/);
  });

  it('throws when a spread names an identifier the scanned tree declares nowhere', () => {
    const project = projectWith({ mapSource: mergedMap('  ...INHERITED_POSTURES,'), files: {} });

    expect(() => rule.check(project)).toThrow(/INHERITED_POSTURES/);
  });

  it('throws when a spread names a declaration whose value it cannot read as a literal', () => {
    const project = projectWith({
      mapSource: `const SLICE_ROUTE_POSTURES = buildSlicePostures();

export const ROUTE_POSTURES: RoutePostureMap = {
  ...SLICE_ROUTE_POSTURES,
} as const satisfies Record<RouteKey, RoutePosture>;
`,
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/SLICE_ROUTE_POSTURES/);
  });

  it('throws when a spread is written over something other than an identifier', () => {
    const project = projectWith({ mapSource: mergedMap('  ...buildSlicePostures(),'), files: {} });

    expect(() => rule.check(project)).toThrow(/buildSlicePostures\(\)/);
  });

  it('throws rather than looping when a spread cycles back to a map already being read', () => {
    const project = projectWith({
      mapSource: `const SLICE_ROUTE_POSTURES = {
  ...ROUTE_POSTURES,
};

export const ROUTE_POSTURES: RoutePostureMap = {
  ...SLICE_ROUTE_POSTURES,
} as const satisfies Record<RouteKey, RoutePosture>;
`,
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/already reading/);
  });
});

describe('postures a slice binds rather than writes', () => {
  it('passes over a route whose posture the binding factory produces', () => {
    const project = projectWith({
      mapSource: mergedMap('  ...BILLING_ROUTE_POSTURES,'),
      files: {
        ...billingFragment({ '$post /billing/webhooks/payment': BOUND }, FACTORY_IMPORT),
        [BILLING_ROUTES]: billingWebhook(`        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`),
      },
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('throws when the capability module is absent from the scanned tree', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(POSTURE_VOCABULARY_MODULE, vocabulary(['constant-cost']));
    project.createSourceFile(POSTURE_MAP_MODULE, postureMap({}));

    expect(() => rule.check(project)).toThrow(/lib\/rate-limit\/capability\.ts/);
  });

  it('throws when the binding factory returns nothing it can read as a posture', () => {
    const project = projectWith({ bound: 'buildNamedPosture(layers)', files: {} });

    expect(() => rule.check(project)).toThrow(/bindRoutePosture/);
  });

  it('throws when the binding factory returns a posture declaring no readable kind', () => {
    const project = projectWith({ bound: '{ keyedBy: identitiesOf(first, rest) }', files: {} });

    expect(() => rule.check(project)).toThrow(/bindRoutePosture/);
  });

  it('throws when the binding factory returns a second posture from inside a guard', () => {
    const project = projectWith({
      capabilitySource: `export function bindRoutePosture(layers) {
  if (layers.length === 0) return { kind: 'exempt', exemption: 'constant-cost' };
  return { kind: 'named', keyedBy: [] };
}\n`,
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/returns exactly one posture/);
  });

  it('throws when the capability module declares no binding factory', () => {
    const project = projectWith({
      capabilitySource: 'export const NOTHING_HERE = true;\n',
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/declares no 'bindRoutePosture'/);
  });

  it('throws when a posture is produced by some call other than the binding factory', () => {
    const project = projectWith({ postures: { '$get /a': 'buildPosture()' }, files: {} });

    expect(() => rule.check(project)).toThrow(/\$get \/a/);
  });

  it('throws when a posture is bound through the factory reached off a namespace', () => {
    const project = projectWith({
      postures: { '$get /a': 'rateLimit.bindRoutePosture([])' },
      files: {},
    });

    expect(() => rule.check(project)).toThrow(/\$get \/a/);
  });

  it('throws when a fragment binds a posture through a factory it declares itself', () => {
    const project = projectWith({
      mapSource: mergedMap('  ...BILLING_ROUTE_POSTURES,'),
      files: {
        ...billingFragment({ '$post /billing/webhooks/payment': BOUND }, FACTORY_SHADOW),
        [BILLING_ROUTES]: billingWebhook(`        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`),
      },
    });

    expect(() => rule.check(project)).toThrow(/cannot resolve to the factory/);
  });

  it('throws when a fragment shadows the binding factory it also imports', () => {
    const project = projectWith({
      mapSource: mergedMap('  ...BILLING_ROUTE_POSTURES,'),
      files: {
        ...billingFragment(
          { '$post /billing/webhooks/payment': BOUND },
          `${FACTORY_IMPORT}${FACTORY_SHADOW}`
        ),
        [BILLING_ROUTES]: billingWebhook(`        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`),
      },
    });

    expect(() => rule.check(project)).toThrow(/cannot resolve to the factory/);
  });

  it('throws when a bound posture names a factory the scanned tree declares nowhere', () => {
    const project = projectWith({
      mapSource: mergedMap('  ...BILLING_ROUTE_POSTURES,'),
      files: {
        ...billingFragment({ '$post /billing/webhooks/payment': BOUND }),
        [BILLING_ROUTES]: billingWebhook(`        await recordEvidence(c.var.db);
        return c.json({ received: true }, 200);`),
      },
    });

    expect(() => rule.check(project)).toThrow(/cannot resolve to the factory/);
  });

  it('demands an exemption class when the binding factory produces an exempt posture', () => {
    const project = projectWith({
      bound: `{ kind: 'exempt' }`,
      mapSource: mergedMap('  ...BILLING_ROUTE_POSTURES,'),
      files: billingFragment({ '$post /billing/webhooks/payment': BOUND }, FACTORY_IMPORT),
    });

    expect(() => rule.check(project)).toThrow(/no obligation can be selected/);
  });
});

/**
 * The rule against the tree it exists for. A red fixture proves the check can
 * fail; only this proves it fails on THIS repository's routes — that the posture
 * map was read, that each exempt key resolved to the registration it names, and
 * that the obligation ran on the registration that actually serves it.
 *
 * The probes mutate the loaded source in memory and never save, so a concurrent
 * agent reading the working tree cannot observe them.
 */
describe('the real api tree', () => {
  function realProject(): Project {
    const project = new Project({ skipAddingFilesFromTsConfig: true });
    project.addSourceFilesAtPaths([
      path.join(REPO_ROOT, 'apps/api/src/lib/rate-limit/posture.ts'),
      path.join(REPO_ROOT, 'apps/api/src/lib/rate-limit/capability.ts'),
      path.join(REPO_ROOT, 'apps/api/src/composition/rate-limit-posture.ts'),
      path.join(REPO_ROOT, 'apps/api/src/app.ts'),
      path.join(REPO_ROOT, 'apps/api/src/slices/*/routes.ts'),
      path.join(REPO_ROOT, 'apps/api/src/slices/*/index.ts'),
      path.join(REPO_ROOT, 'apps/api/src/slices/*/rate-limit-posture.ts'),
    ]);
    return project;
  }

  function realFile(project: Project, repoPath: string): SourceFile {
    const file = project.getSourceFile(path.join(REPO_ROOT, repoPath));
    if (file === undefined) throw new Error(`fixture: ${repoPath} did not load`);
    return file;
  }

  it('reports nothing', () => {
    expect(rule.check(realProject())).toEqual([]);
  });

  it('reports the served-version route once a store read is inserted into its real handler', () => {
    const project = realProject();
    const file = realFile(project, 'apps/api/src/slices/updates/routes.ts');
    file.replaceWithText(
      file
        .getFullText()
        .replace(
          '        const version = resolveServedVersion(',
          '        await c.var.db.select();\n        const version = resolveServedVersion('
        )
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/\/updates\/current/);
  });

  it('reports the health route once a getter-borne store touch is inserted into it', () => {
    const project = realProject();
    const file = realFile(project, 'apps/api/src/app.ts');
    file.replaceWithText(
      file
        .getFullText()
        .replace(
          "c.json({ status: 'ok', timestamp: new Date().toISOString() })",
          "c.get('sideBand')(recordHit())"
        )
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/\/health/);
  });

  it('reports the health route once its real handler destructures the side band', () => {
    const project = realProject();
    const file = realFile(project, 'apps/api/src/app.ts');
    file.replaceWithText(
      file.getFullText().replace(
        `routes: new Hono<AppEnv>().get('/', routeClass('public'), (c) =>
    c.json({ status: 'ok', timestamp: new Date().toISOString() })
  ),`,
        `routes: new Hono<AppEnv>().get('/', routeClass('public'), (c) => {
    const { sideBand } = c.var;
    sideBand(recordHit());
    return c.json({ status: 'ok' });
  }),`
      )
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/\/health/);
  });

  it('reports the payment webhook once a getter-borne touch precedes its real verifier', () => {
    const project = realProject();
    const file = realFile(project, 'apps/api/src/slices/billing/routes.ts');
    file.replaceWithText(
      file
        .getFullText()
        .replace(
          '          const verified = await deps.webhookVerifier(c.env).verify(rawBody, {',
          "          c.get('sideBand')(recordPaymentWebhookEvidence());\n" +
            '          const verified = await deps.webhookVerifier(c.env).verify(rawBody, {'
        )
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/before its signature verifier/);
  });

  it('reports the payment webhook once a store-touching middleware is added to it', () => {
    const project = realProject();
    const file = realFile(project, 'apps/api/src/slices/billing/routes.ts');
    const registration = `        '/webhooks/payment',\n        routeClass('public'),\n`;
    file.replaceWithText(
      file
        .getFullText()
        .replace(
          registration,
          `${registration}        async (c, next) => {\n          const store = c.var.db;\n          return next(store);\n        },\n`
        )
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/reaches the 'db' handle before its signature verifier/);
  });

  it('reports the payment webhook once its real verifier call is removed', () => {
    const project = realProject();
    const file = realFile(project, 'apps/api/src/slices/billing/routes.ts');
    file.replaceWithText(
      file.getFullText().replace('deps.webhookVerifier(c.env).verify(', 'passThrough(')
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/\/billing\/webhooks\/payment/);
  });

  /** One slice's fragment: where it lives, what it exports, and the keys it declares. */
  interface Fragment {
    readonly slice: string;
    readonly name: string;
    readonly keys: readonly string[];
  }

  function sliceFragments(project: Project): Fragment[] {
    return project
      .getSourceFiles()
      .flatMap((file) => {
        const slice = /\/slices\/([^/]+)\/rate-limit-posture\.ts$/.exec(file.getFilePath())?.[1];
        const declaration = file.getVariableDeclarations().find((each) => each.isExported());
        if (slice === undefined || declaration === undefined) return [];
        const literal = declaration.getFirstDescendantByKindOrThrow(
          SyntaxKind.ObjectLiteralExpression
        );
        return [
          {
            slice,
            name: declaration.getName(),
            keys: literal
              .getProperties()
              .flatMap((property) =>
                Node.isPropertyAssignment(property) ? [property.getNameNode().getText()] : []
              ),
          },
        ];
      })
      .toSorted((a, b) => a.slice.localeCompare(b.slice));
  }

  /**
   * The rows the composition root writes itself: the map's own literal, plus
   * every literal it spreads that the same module declares, followed through.
   *
   * The root exports a merge, so the rows it writes are no longer the map
   * literal's own properties — reading only those answers `[]` for a root that
   * declares its routes in a local const and spreads it. A spread naming an
   * imported fragment resolves to no local declaration and is skipped, which is
   * what keeps a fragment's keys out of what the root is said to write.
   */
  function writtenRows(file: SourceFile): PropertyAssignment[] {
    const rows: PropertyAssignment[] = [];
    const collect = (literal: ObjectLiteralExpression): void => {
      for (const property of literal.getProperties()) {
        if (Node.isPropertyAssignment(property)) {
          rows.push(property);
          continue;
        }
        if (!Node.isSpreadAssignment(property)) continue;
        const local = file.getVariableDeclaration(property.getExpression().getText());
        if (local === undefined) continue;
        collect(local.getFirstDescendantByKindOrThrow(SyntaxKind.ObjectLiteralExpression));
      }
    };
    collect(
      file
        .getVariableDeclarationOrThrow('ROUTE_POSTURES')
        .getFirstDescendantByKindOrThrow(SyntaxKind.ObjectLiteralExpression)
    );
    return rows;
  }

  /**
   * The real map rewritten as a merge over the real fragments, with whatever no
   * fragment declares left as the literal rows beside the spreads.
   *
   * Three of the four exemptions this repository declares live in slice
   * fragments, so a literal map exercises none of the resolution that reaches
   * them: the spread has to be followed through the barrel that republishes the
   * fragment before the obligation runs at all. The merge is built from the
   * fragment files rather than from the map, so it is the same shape whether the
   * composition root has taken the spreads yet or not.
   */
  function mergedRealProject(): Project {
    const project = realProject();
    const fragments = sliceFragments(project);
    const declared = new Set(fragments.flatMap((fragment) => fragment.keys));
    const map = realFile(project, 'apps/api/src/composition/rate-limit-posture.ts');
    const literal = map
      .getVariableDeclarationOrThrow('ROUTE_POSTURES')
      .getFirstDescendantByKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const rows = [
      ...fragments.map((fragment) => `  ...${fragment.name},`),
      ...writtenRows(map).flatMap((property) =>
        declared.has(property.getNameNode().getText()) ? [] : [`  ${property.getText()},`]
      ),
    ];
    const imports = fragments.map(
      (fragment) => `import { ${fragment.name} } from '../slices/${fragment.slice}/index.js';`
    );
    const text = map.getFullText();
    const body = `{\n${rows.join('\n')}\n}`;
    map.replaceWithText(
      `${imports.join('\n')}\n${text.slice(0, literal.getStart())}${body}${text.slice(literal.getEnd())}`
    );
    return project;
  }

  it('reports nothing when the map is a merge over the real fragments', () => {
    expect(rule.check(mergedRealProject())).toEqual([]);
  });

  /** The route keys the composition root writes itself, imported spreads excluded. */
  function writtenKeys(project: Project): string[] {
    return writtenRows(realFile(project, 'apps/api/src/composition/rate-limit-posture.ts')).map(
      (property) => property.getNameNode().getText()
    );
  }

  it('reports a fragment-declared webhook once its real verifier call is removed', () => {
    const project = mergedRealProject();
    // The map writes no row for this route, so a report on it came through a spread.
    expect(writtenKeys(project)).not.toContain(`'$post /billing/webhooks/payment'`);
    const file = realFile(project, 'apps/api/src/slices/billing/routes.ts');
    file.replaceWithText(
      file.getFullText().replace('deps.webhookVerifier(c.env).verify(', 'passThrough(')
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/\/billing\/webhooks\/payment/);
  });

  /**
   * The same broken obligation as `reports a fragment-declared webhook once its
   * real verifier call is removed`, behind a `bindRoutePosture` the fragment
   * declares itself. Read by the callee's name alone the entry classifies as
   * whatever the real factory returns, so the exemption the shadow factory
   * returns is passed over and the violation that control reports disappears.
   */
  it('throws when a fragment binds its real webhook through a factory of its own', () => {
    const project = mergedRealProject();
    const fragment = realFile(project, 'apps/api/src/slices/billing/rate-limit-posture.ts');
    const shadowed = fragment
      .getFullText()
      .replace(
        `'$post /billing/webhooks/payment': ${WEBHOOK_EXEMPT}`,
        `'$post /billing/webhooks/payment': bindRoutePosture([])`
      );
    // A replace that matched nothing would leave the real literal in place and
    // measure the control over again.
    expect(shadowed).toContain('bindRoutePosture([])');
    fragment.replaceWithText(`${FACTORY_SHADOW}${shadowed}`);
    const routes = realFile(project, 'apps/api/src/slices/billing/routes.ts');
    routes.replaceWithText(
      routes.getFullText().replace('deps.webhookVerifier(c.env).verify(', 'passThrough(')
    );

    expect(() => rule.check(project)).toThrow(/cannot resolve to the factory/);
  });

  it('reports the health route, declared beside the spreads, once it touches a store', () => {
    const project = mergedRealProject();
    expect(writtenKeys(project)).toContain(`'$get /health'`);
    const file = realFile(project, 'apps/api/src/app.ts');
    file.replaceWithText(
      file
        .getFullText()
        .replace(
          "c.json({ status: 'ok', timestamp: new Date().toISOString() })",
          "c.get('sideBand')(recordHit())"
        )
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/\/health/);
  });
});
