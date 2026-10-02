import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse, type TomlTable, type TomlValue } from 'smol-toml';
import { describe, it, expect } from 'vitest';
import { GROWTH_BEACON_PATH } from '@hushbox/shared';

/**
 * What this suite covers is the route patterns the committed deployment
 * configurations declare, and the two facts that together decide what answers
 * a beacon post on the admin hostname in production: no route hands that
 * hostname's beacon path to the product Worker, and the assets-only Worker
 * that answers every other path on it declares no code that could answer one.
 *
 * What it does not cover is a local stack, which reads none of these files,
 * nor a route added through the Cloudflare dashboard rather than written
 * here — the product apex's own custom domain is configured that way, and a
 * route that is not in a file is not something a file can refuse.
 */
const BOUND =
  'The admin hostname answers a growth beacon with nothing that counts it. A route sending ' +
  'that hostname’s beacon path to the product Worker, or code behind the Worker serving the ' +
  'rest of it, would give the framed marketing copy this origin serves a live beacon endpoint.';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const API_WRANGLER = path.join(REPO_ROOT, 'apps', 'api', 'wrangler.toml');
const ADMIN_WRANGLER = path.join(REPO_ROOT, 'apps', 'admin', 'wrangler.toml');

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/**
 * The config as Wrangler reads it — `smol-toml` is the parser Wrangler
 * bundles, so what is read here is the shape a deploy sees rather than the
 * spelling someone happened to type. A file the parser rejects is refused, not
 * admitted: an unreadable config would otherwise be the way past every
 * assertion below.
 */
function parseOrRefuse(toml: string): TomlTable {
  try {
    return parse(toml);
  } catch {
    return expect.fail(BOUND);
  }
}

/** The patterns one `route` or `routes` value states, in each of the three spellings Wrangler accepts. */
function patternsOf(value: TomlValue): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((element) => patternsOf(element));
  if (isTable(value) && typeof value['pattern'] === 'string') return [value['pattern']];
  return [];
}

/**
 * Every route pattern a config states, at every depth, so a pattern inside an
 * environment override is read alongside a top-level one.
 */
function routePatternsIn(value: TomlValue): readonly string[] {
  if (Array.isArray(value)) return value.flatMap((element) => routePatternsIn(element));
  if (!isTable(value)) return [];

  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === 'route' || key === 'routes' ? patternsOf(child) : []),
    ...routePatternsIn(child),
  ]);
}

/**
 * The paths of every key with this name, wherever in the config it sits, so a
 * key inside an environment override is read alongside a top-level one. An
 * array's elements extend no path: an array of tables states the key names a
 * single table would, and the index is not part of what is refused.
 */
function keyPathsNamed(
  value: TomlValue,
  name: string,
  prefix: readonly string[] = []
): readonly string[] {
  if (Array.isArray(value)) return value.flatMap((element) => keyPathsNamed(element, name, prefix));
  if (!isTable(value)) return [];

  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === name ? [[...prefix, key].join('.')] : []),
    ...keyPathsNamed(child, name, [...prefix, key]),
  ]);
}

/**
 * Whether a route pattern claims a host-and-path. Matching is written over
 * both halves because the host half is what decides a subdomain: a pattern on
 * the bare apex claims nothing under `admin.`, while one whose host carries a
 * `*` may. A scheme prefix is stripped rather than matched, since Cloudflare
 * admits one and it is not part of what a pattern selects.
 */
function claims(pattern: string, hostAndPath: string): boolean {
  const withoutScheme = pattern.replace(/^(?:https?|http\*|\*):\/\//u, '');
  const expression = withoutScheme
    .replaceAll(/[.+?^${}()|[\]\\]/gu, String.raw`\$&`)
    .replaceAll('*', String.raw`[\s\S]*`);
  return new RegExp(`^${expression}$`, 'u').test(hostAndPath);
}

/**
 * The admin origin's hostname, read from what the product Worker is itself
 * told that origin is rather than spelled again here, so the two cannot drift
 * into asserting about different hosts.
 */
function adminHostFrom(apiConfig: TomlTable): string {
  const variables = apiConfig['vars'];
  const adminUrl = isTable(variables) ? variables['ADMIN_URL'] : undefined;
  if (typeof adminUrl !== 'string') {
    return expect.fail(`the product Worker's config states no admin origin. ${BOUND}`);
  }
  return new URL(adminUrl).host;
}

/**
 * The one assertion, over the pair of configs a deploy publishes. Both halves
 * are needed for the claim: the second config's route claims every path on the
 * hostname, so what keeps the beacon path unanswered there is that nothing
 * runs behind it.
 */
function assertNoBeaconOnAdminHost(apiToml: string, adminToml: string): void {
  const apiConfig = parseOrRefuse(apiToml);
  const adminConfig = parseOrRefuse(adminToml);
  const beaconUrl = `${adminHostFrom(apiConfig)}${GROWTH_BEACON_PATH}`;

  expect(
    routePatternsIn(apiConfig).filter((pattern) => claims(pattern, beaconUrl)),
    BOUND
  ).toEqual([]);

  expect(keyPathsNamed(adminConfig, 'main'), BOUND).toEqual([]);
}

const apiToml = (): string => readFileSync(API_WRANGLER, 'utf8');
const adminToml = (): string => readFileSync(ADMIN_WRANGLER, 'utf8');

describe('the admin hostname’s declared production routing', () => {
  it('sends no beacon post to the Worker that serves the beacon', () => {
    assertNoBeaconOnAdminHost(apiToml(), adminToml());
  });

  it('refuses a config routing the admin hostname’s beacon path to the product Worker', () => {
    const withBeaconRoute = `${apiToml()}\n[[routes]]\npattern = "admin.hushbox.ai${GROWTH_BEACON_PATH}"\nzone_name = "hushbox.ai"\n`;

    expect(() => {
      assertNoBeaconOnAdminHost(withBeaconRoute, adminToml());
    }).toThrow(BOUND);
  });

  it('refuses a config claiming the beacon path across every subdomain of the zone', () => {
    const widened = `${apiToml()}\n[[routes]]\npattern = "*.hushbox.ai${GROWTH_BEACON_PATH}"\nzone_name = "hushbox.ai"\n`;

    expect(() => {
      assertNoBeaconOnAdminHost(widened, adminToml());
    }).toThrow(BOUND);
  });

  it('refuses a config putting code behind the Worker that answers the rest of the hostname', () => {
    const withCode = `main = "src/index.ts"\n${adminToml()}`;

    expect(() => {
      assertNoBeaconOnAdminHost(apiToml(), withCode);
    }).toThrow(BOUND);
  });

  it('refuses a config the parser rejects', () => {
    expect(() => {
      assertNoBeaconOnAdminHost(`${apiToml()}\nthis line is not toml\n`, adminToml());
    }).toThrow(BOUND);
  });
});
