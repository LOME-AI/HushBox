import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, { CACHE_POLICY_MAP_MODULE } from './cacheable-routes-prove-caller-invariance.rule.js';

/** The policy map, one entry per line, in the shape the composition root writes. */
function policyMap(entries: Record<string, string>): string {
  const lines = Object.entries(entries)
    .map(([key, policy]) => `  '${key}': ${policy},`)
    .join('\n');
  return `export const ROUTE_CACHE_POLICIES = {\n${lines}\n} as const satisfies Record<RouteKey, CachePolicy>;\n`;
}

const NO_STORE = `{ kind: 'no-store' }`;
const SHARED = `{ kind: 'shared', sharedMaxAgeSeconds: 60, tag: 'catalog' }`;
const IMMUTABLE = `{ kind: 'immutable', maxAgeSeconds: 86_400, tag: 'ota' }`;

const CATALOG = '$get /models';
const BANNER = '$get /announcements/banner';
const DOWNLOAD = '$get /updates/download/:platform/:version';

const CATALOG_TEST = 'apps/api/src/slices/models/routes-caller-invariance.integration.test.ts';

/** A proof call in the shape a colocated proof test writes it. */
function proof(routeKey: string): string {
  return `it('serves every caller the same bytes', async () => {
  await proveCallerInvariance('${routeKey}', { sessionSecret: SECRET, respondTo: get });
});\n`;
}

interface Fixture {
  /** Route key to policy literal. */
  readonly policies: Record<string, string>;
  /** Proof-carrying (or not) files, by repo-relative path. */
  readonly files?: Record<string, string>;
}

function projectWith(fixture: Fixture): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(CACHE_POLICY_MAP_MODULE, policyMap(fixture.policies));
  for (const [filePath, source] of Object.entries(fixture.files ?? {})) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

describe('the rule reaches what it claims to check', () => {
  it('throws when the policy map module is absent from the scanned tree', () => {
    const project = new Project({ useInMemoryFileSystem: true });

    expect(() => rule.check(project)).toThrow(/composition\/route-cache-policy\.ts/);
  });

  it('throws when the map is no longer an object literal it can read', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      CACHE_POLICY_MAP_MODULE,
      'export const ROUTE_CACHE_POLICIES = buildPolicies();\n'
    );

    expect(() => rule.check(project)).toThrow(/ROUTE_CACHE_POLICIES/);
  });

  it('throws when an entry names its route with something other than a string literal', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      CACHE_POLICY_MAP_MODULE,
      `export const ROUTE_CACHE_POLICIES = {\n  [CATALOG]: ${SHARED},\n} as const;\n`
    );

    expect(() => rule.check(project)).toThrow(/string literal/);
  });

  it('throws when the module carries no policy map at all', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(CACHE_POLICY_MAP_MODULE, 'export const NOTHING_HERE = {};\n');

    expect(() => rule.check(project)).toThrow(/ROUTE_CACHE_POLICIES/);
  });

  it('throws when an entry is spread in rather than assigned', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      CACHE_POLICY_MAP_MODULE,
      `export const ROUTE_CACHE_POLICIES = {\n  ...inheritedPolicies,\n} as const;\n`
    );

    expect(() => rule.check(project)).toThrow(/assignment/);
  });

  it('throws when an entry names a policy it cannot read as an object literal', () => {
    const project = projectWith({ policies: { [CATALOG]: 'SHARED_SIXTY' } });

    expect(() => rule.check(project)).toThrow(/object literal/);
  });

  it('throws when an entry declares a kind that is not a literal', () => {
    const project = projectWith({ policies: { [CATALOG]: '{ kind: SHARED_KIND }' } });

    expect(() => rule.check(project)).toThrow(/kind/);
  });

  it('throws when an entry declares no kind it can read', () => {
    const project = projectWith({ policies: { [CATALOG]: '{ ...sharedDefaults }' } });

    expect(() => rule.check(project)).toThrow(/kind/);
  });

  it('throws when a proof names its route with something other than a string literal', () => {
    const project = projectWith({
      policies: { [CATALOG]: SHARED },
      files: {
        [CATALOG_TEST]: `await proveCallerInvariance(routeKey, { respondTo: get });\n`,
      },
    });

    expect(() => rule.check(project)).toThrow(/string literal/);
  });
});

describe('a storable declaration without a proof', () => {
  it('reports a cacheable declaration that no proof names', () => {
    const project = projectWith({
      policies: { [CATALOG]: SHARED, [BANNER]: SHARED },
      files: { [CATALOG_TEST]: proof(CATALOG) },
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain(BANNER);
    expect(violations[0]?.file).toBe(CACHE_POLICY_MAP_MODULE);
  });

  it('reports the line the declaration is written on', () => {
    const project = projectWith({ policies: { [CATALOG]: NO_STORE, [BANNER]: SHARED } });

    expect(rule.check(project)[0]?.line).toBe(3);
  });

  it('holds an immutable declaration to the same proof as a shared one', () => {
    const project = projectWith({ policies: { [DOWNLOAD]: IMMUTABLE } });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('passes a route declared no-store, which is storable nowhere', () => {
    const project = projectWith({ policies: { [CATALOG]: NO_STORE } });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a storable route whose proof names it', () => {
    const project = projectWith({
      policies: { [CATALOG]: SHARED },
      files: { [CATALOG_TEST]: proof(CATALOG) },
    });

    expect(rule.check(project)).toEqual([]);
  });
});

describe('what does not count as a proof', () => {
  it('refuses a proof written in a comment rather than called', () => {
    const project = projectWith({
      policies: { [CATALOG]: SHARED },
      files: {
        [CATALOG_TEST]: `// proveCallerInvariance('${CATALOG}', { respondTo: get });\nit('reads the catalog', () => undefined);\n`,
      },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('refuses a proof naming a different route than the one declared', () => {
    const project = projectWith({
      policies: { [CATALOG]: SHARED },
      files: { [CATALOG_TEST]: proof(BANNER) },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('refuses a proof that runs outside a test file, where nothing asserts it', () => {
    const project = projectWith({
      policies: { [CATALOG]: SHARED },
      files: { 'apps/api/src/slices/models/routes.ts': proof(CATALOG) },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('refuses a proof carried by a test outside the api tree', () => {
    const project = projectWith({
      policies: { [CATALOG]: SHARED },
      files: { 'apps/web/src/lib/models.test.ts': proof(CATALOG) },
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('refuses a proof carried by a test outside the slice tree', () => {
    const project = projectWith({
      policies: { [CATALOG]: SHARED },
      files: { 'apps/api/src/test-support/caller-invariance.integration.test.ts': proof(CATALOG) },
    });

    expect(rule.check(project)).toHaveLength(1);
  });
});
