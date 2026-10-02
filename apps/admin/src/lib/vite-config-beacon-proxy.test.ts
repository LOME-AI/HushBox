import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GROWTH_BEACON_PATH } from '@hushbox/shared';
import config from '../../vite.config';
import type { ProxyOptions } from 'vite';

/**
 * What this suite covers is the two servers this application runs locally: no
 * proxy entry on either forwards the beacon path, so a beacon posted from a
 * page served on a local admin origin reaches nothing that counts it.
 *
 * What it does not cover is production, where nothing in this file is read at
 * all: the hostname's routing is declared in the deployment configurations,
 * which are a separate artifact with no shared source, and a reader who wants
 * that half must go and read the assertion made over those files.
 */
const BOUND =
  'The admin application forwards the growth beacon nowhere on a local stack. A proxy entry ' +
  'claiming that path would give a page this origin serves a live beacon endpoint, and the ' +
  'framed marketing copy it serves carries the counting script.';

type ProxyTable = Record<string, string | ProxyOptions>;

/** The URLs a beacon post arrives on: the bare path, and the path carrying a campaign tag. */
const BEACON_URLS = [GROWTH_BEACON_PATH, `${GROWTH_BEACON_PATH}?c=launch`] as const;

/**
 * Whether a proxy key claims a URL, by the rule the bundler applies to it: a
 * key opening with `^` is a regular expression tested against the whole URL,
 * and any other key is a path prefix.
 */
function claims(key: string, url: string): boolean {
  return key.startsWith('^') ? new RegExp(key).test(url) : url.startsWith(key);
}

/** The keys of a table that would forward a beacon post. */
function beaconKeysIn(table: ProxyTable): readonly string[] {
  return Object.keys(table).filter((key) => BEACON_URLS.some((url) => claims(key, url)));
}

/**
 * The table a resolved config hands one of its servers. A config stating none
 * is refused rather than read as an empty one: the absence would mean this
 * suite is looking somewhere the proxy no longer lives, which is the one way
 * an absence assertion passes while examining nothing.
 */
function proxyTable(server: 'server' | 'preview'): ProxyTable {
  const resolved = config({ command: 'serve', mode: 'development' });
  const proxy = server === 'server' ? resolved.server?.proxy : resolved.preview?.proxy;
  if (proxy === undefined) {
    return expect.fail(`the admin config states no proxy table for its ${server}. ${BOUND}`);
  }
  return proxy;
}

function assertForwardsNoBeacon(table: ProxyTable): void {
  expect(beaconKeysIn(table), BOUND).toEqual([]);
}

/** A copy of a real table with a beacon entry spliced in, which is never written to the config itself. */
function withBeaconEntry(table: ProxyTable, key: string): ProxyTable {
  return { ...table, [key]: { target: 'http://localhost:1', changeOrigin: true } };
}

describe('the admin application’s local beacon routing', () => {
  beforeEach(() => {
    // The config refuses to resolve a served command without the generated
    // ports; vite-config-port-guard.test.ts is where that refusal is covered.
    vi.stubEnv('HB_ADMIN_PORT', '4200');
    vi.stubEnv('HB_API_PORT', '4300');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('forwards nothing a beacon posts to on the development server', () => {
    assertForwardsNoBeacon(proxyTable('server'));
  });

  it('forwards nothing a beacon posts to on the preview server', () => {
    assertForwardsNoBeacon(proxyTable('preview'));
  });

  it('refuses a table carrying a beacon entry written as a regular expression', () => {
    const table = withBeaconEntry(proxyTable('server'), String.raw`^${GROWTH_BEACON_PATH}(\?.*)?$`);

    expect(() => {
      assertForwardsNoBeacon(table);
    }).toThrow(BOUND);
  });

  it('refuses a table carrying a beacon entry written as a path prefix', () => {
    const table = withBeaconEntry(proxyTable('server'), GROWTH_BEACON_PATH);

    expect(() => {
      assertForwardsNoBeacon(table);
    }).toThrow(BOUND);
  });
});
