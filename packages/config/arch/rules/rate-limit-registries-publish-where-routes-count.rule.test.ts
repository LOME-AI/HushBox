import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './rate-limit-registries-publish-where-routes-count.rule.js';

/**
 * The route-module layout the rule pins itself to, seeded into every fixture so
 * a project stands where the repository does. Both seeds belong to a slice the
 * fixtures never give a registry, so neither is a subject of any case below.
 */
const LAYOUT: Record<string, string> = {
  'apps/api/src/slices/chat/routes.ts': 'export {};\n',
  'apps/api/src/slices/chat/routes/refusals.ts': 'export {};\n',
};

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries({ ...LAYOUT, ...files })) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const SLICE = 'apps/api/src/slices/media/';
const REGISTRY = `${SLICE}domain/rate-limit.ts`;
const BARREL = `${SLICE}domain/index.ts`;
const ROUTES = `${SLICE}routes.ts`;
const POSTURE = `${SLICE}rate-limit-posture.ts`;

/**
 * A registry in the shape the tree writes one: definitions, a function that
 * spends through the primitive, and the surrounding forms a real one carries —
 * a type-only import, a non-counting import, an anonymous default, and a
 * declaration it keeps to itself.
 */
const REGISTRY_SOURCE = `import { consume, rateLimitKey } from '../../../lib/rate-limit/index.js';
import { redisMGet } from '../../../lib/redis/index.js';
import type { ThrottleLimit } from '../../../lib/rate-limit/index.js';

export type { RateLimitDecision } from '../../../lib/rate-limit/index.js';
export { rateLimitKey } from '../../../lib/rate-limit/index.js';

const MINT_PREFIX = 'ratelimit:media:download:link-mint:';

export const MEDIA_RATE_LIMITS = {
  mint: {
    kind: 'throttle',
    maxAttempts: 1200,
    windowSeconds: 60,
    buildKey: (linkId: string) => \`\${MINT_PREFIX}\${linkId}\`,
  } as const satisfies ThrottleLimit,
} as const;

export default function () {
  return rateLimitKey(MEDIA_RATE_LIMITS.mint, redisMGet);
}

export function consumeLinkMint(redis: RedisClient, linkId: string) {
  return consume(redis, MEDIA_RATE_LIMITS.mint, linkId);
}
`;

/** A registry publishing two counting functions, of which a route may import either. */
const REGISTRY_WITH_TWO_COUNTERS = `import { consume } from '../../../lib/rate-limit/index.js';

export function reserveShareRemint(redis: RedisClient, shareId: string) {
  return consume(redis, MEDIA_RATE_LIMITS.remint, shareId);
}

export function consumeLinkMint(redis: RedisClient, linkId: string) {
  return consume(redis, MEDIA_RATE_LIMITS.mint, linkId);
}
`;

function barrelRepublishing(names: string): string {
  return `export { authorizePresign } from './presign-authz.js';
export { ${names} } from './rate-limit.js';
`;
}

/** A barrel that publishes no registry, alongside the two specifier forms this rule passes over. */
const BARREL_WITHOUT_REGISTRY = `export { authorizePresign } from './presign-authz.js';
export { z } from 'zod';
export {};
`;

function routesImporting(names: string): string {
  return `import { ${names} } from './domain/index.js';\n`;
}

const ROUTES_IMPORTING_NOTHING = `import { authorizePresign } from './domain/index.js';\n`;

/** A slice whose routes live in group modules counts from one of them, not from `routes.ts`. */
const ROUTES_DIRECTORY = `${SLICE}routes/`;
const DOWNLOAD_ROUTES = `${ROUTES_DIRECTORY}download-routes.ts`;

function groupModuleImporting(names: string): string {
  return `import { ${names} } from '../domain/index.js';\n`;
}

const GROUP_MODULE_IMPORTING_NOTHING = groupModuleImporting('authorizePresign');

describe('rate-limit-registries-publish-where-routes-count', () => {
  it('holds a slice whose routes live in group modules inside its scope', () => {
    const counted = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: barrelRepublishing('MEDIA_RATE_LIMITS, consumeLinkMint'),
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
      [DOWNLOAD_ROUTES]: groupModuleImporting('consumeLinkMint'),
    });
    const uncounted = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: barrelRepublishing('MEDIA_RATE_LIMITS, consumeLinkMint'),
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
      [DOWNLOAD_ROUTES]: GROUP_MODULE_IMPORTING_NOTHING,
    });

    expect(rule.check(counted)).toEqual([]);
    expect(rule.check(uncounted)).toHaveLength(1);
  });

  it('flags a group module counting off a registry the domain barrel republishes nowhere', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: BARREL_WITHOUT_REGISTRY,
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
      [DOWNLOAD_ROUTES]: groupModuleImporting('consumeLinkMint'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: DOWNLOAD_ROUTES });
    expect(violations[0]?.message).toMatch(/consumeLinkMint/);
  });

  it('does not count a republication off a group module of a different slice', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: barrelRepublishing('MEDIA_RATE_LIMITS, consumeLinkMint'),
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
      ['apps/api/src/slices/conversations/routes/download-routes.ts']:
        groupModuleImporting('consumeLinkMint'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BARREL });
  });

  it('does not count a republication off a test module under the routes directory', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: barrelRepublishing('MEDIA_RATE_LIMITS, consumeLinkMint'),
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
      [`${ROUTES_DIRECTORY}download-routes.test.ts`]: groupModuleImporting('consumeLinkMint'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BARREL });
  });

  it('admits a republished registry whose counting function the routes import', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: barrelRepublishing('MEDIA_RATE_LIMITS, consumeLinkMint'),
      [ROUTES]: routesImporting('consumeLinkMint'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a republished registry whose counting functions the routes never import', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: barrelRepublishing('MEDIA_RATE_LIMITS, consumeLinkMint'),
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BARREL });
    expect(violations[0]?.message).toMatch(/consumeLinkMint/);
  });

  it('flags a republished registry whose sibling specifiers are written with `.ts`', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: `export { authorizePresign } from './presign-authz.ts';
export { MEDIA_RATE_LIMITS, consumeLinkMint } from './rate-limit.ts';
`,
      [ROUTES]: `import { authorizePresign } from './domain/index.ts';\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BARREL });
  });

  it('admits a registry the routes count off through `.ts` specifiers', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: `export { authorizePresign } from './presign-authz.ts';
export { MEDIA_RATE_LIMITS, consumeLinkMint } from './rate-limit.ts';
`,
      [ROUTES]: `import { consumeLinkMint } from './domain/index.ts';\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('admits a registry exporting a counting function beyond the one the routes import', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_WITH_TWO_COUNTERS,
      [BARREL]: barrelRepublishing('consumeLinkMint, reserveShareRemint'),
      [ROUTES]: routesImporting('consumeLinkMint'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a republished registry the routes reach for a definition alone', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: barrelRepublishing('MEDIA_RATE_LIMITS, consumeLinkMint'),
      [ROUTES]: routesImporting('MEDIA_RATE_LIMITS'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BARREL });
  });

  it('names every counting function the registry exports, in a stable order', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_WITH_TWO_COUNTERS,
      [BARREL]: barrelRepublishing('consumeLinkMint, reserveShareRemint'),
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('(consumeLinkMint, reserveShareRemint)');
  });

  it('flags a republished registry that exports no counting function at all', () => {
    const project = projectWith({
      [REGISTRY]: `export const userSearchRateLimit = { kind: 'throttle' } as const;\n`,
      [BARREL]: barrelRepublishing('userSearchRateLimit'),
      [ROUTES]: routesImporting('userSearchRateLimit'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/exports no counting function at all/);
  });

  it('flags a republished registry in a slice carrying no routes module', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: barrelRepublishing('consumeLinkMint'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: BARREL });
  });

  it('admits a slice publishing its registry off the slice barrel instead', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: BARREL_WITHOUT_REGISTRY,
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags routes counting off a registry the domain barrel republishes nowhere', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: `export { consumeLinkMint } from './counters.js';\n`,
      [ROUTES]: routesImporting('consumeLinkMint'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ROUTES });
    expect(violations[0]?.message).toMatch(/consumeLinkMint/);
  });

  it('flags routes counting off a registry in a slice carrying no domain barrel', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [ROUTES]: routesImporting('consumeLinkMint'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ROUTES });
  });

  it('admits routes counting through a function the registry does not declare', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: `export { consumeTrialQuota } from './trial/quota.js';\n`,
      [`${SLICE}domain/trial/quota.ts`]: `import { consumeLayers } from '../../../../lib/rate-limit/index.js';

export function consumeTrialQuota(redis: RedisClient, ipHash: string) {
  return consumeLayers(redis, []);
}
`,
      [ROUTES]: routesImporting('consumeTrialQuota'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('admits a registry whose exported function spends through no counting primitive', () => {
    const project = projectWith({
      [REGISTRY]: `export function mintKey(linkId: string) {
  return \`ratelimit:media:download:link-mint:\${linkId}\`;
}
`,
      [BARREL]: BARREL_WITHOUT_REGISTRY,
      [ROUTES]: routesImporting('mintKey'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('admits a slice whose posture declares flow counting while its routes import no counter', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [POSTURE]: `export const MEDIA_ROUTE_POSTURES = {
  'POST /media/presign': countedInFlow({ kind: 'named' }),
  'GET /media/download': countedInFlow({ kind: 'named' }),
} as const;
`,
      [BARREL]: BARREL_WITHOUT_REGISTRY,
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads a counting function published through a separate export statement', () => {
    const project = projectWith({
      [REGISTRY]: `import { consume as spend } from '../../../lib/rate-limit/index.js';

const LOOKUP = 4800;

function consumeLinkMint(redis: RedisClient, linkId: string) {
  return spend(redis, MEDIA_RATE_LIMITS.mint, linkId);
}

export { consumeLinkMint };
`,
      [BARREL]: barrelRepublishing('consumeLinkMint'),
      [ROUTES]: routesImporting('consumeLinkMint'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reads a counting function declared as an exported arrow constant', () => {
    const project = projectWith({
      [REGISTRY]: `import { consume } from '../../../lib/rate-limit/index.js';

let pending;

export const consumeLinkMint = (redis: RedisClient, linkId: string) =>
  consume(redis, MEDIA_RATE_LIMITS.mint, linkId);

export const mintKey = (linkId: string) => \`ratelimit:media:download:link-mint:\${linkId}\`;
`,
      [BARREL]: barrelRepublishing('consumeLinkMint'),
      [ROUTES]: routesImporting('consumeLinkMint'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a type-only republication of the registry', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: `export type { MediaLimit } from './rate-limit.js';\n`,
      [ROUTES]: ROUTES_IMPORTING_NOTHING,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a type-only import of a counting function in the routes', () => {
    const project = projectWith({
      [REGISTRY]: REGISTRY_SOURCE,
      [BARREL]: BARREL_WITHOUT_REGISTRY,
      [ROUTES]: `import type { consumeLinkMint } from './domain/index.js';
import { type authorizePresign, mintKey } from './domain/index.js';
`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('names the sibling modules repo-relative however the project is rooted', () => {
    const mount = 'srv/checkout/';
    const project = projectWith({
      [`${mount}${REGISTRY}`]: REGISTRY_SOURCE,
      [`${mount}${BARREL}`]: barrelRepublishing('consumeLinkMint'),
      [`${mount}${ROUTES}`]: ROUTES_IMPORTING_NOTHING,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain(`${SLICE}routes.ts`);
    expect(violations[0]?.message).toContain(`${SLICE}routes/`);
    expect(violations[0]?.message).not.toContain(mount);
  });

  it('throws when no slice writes its routes where this rule reads them', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(REGISTRY, REGISTRY_SOURCE);
    project.createSourceFile(BARREL, barrelRepublishing('consumeLinkMint'));
    project.createSourceFile(ROUTES, routesImporting('consumeLinkMint'));

    expect(() => rule.check(project)).toThrow(/names no file/);
  });

  it('throws when no slice declares a rate-limit registry at all', () => {
    const project = projectWith({
      [`${SLICE}domain/presign-authz.ts`]: `export const authorizePresign = () => true;\n`,
    });

    expect(() => rule.check(project)).toThrow(/registry/);
  });
});
