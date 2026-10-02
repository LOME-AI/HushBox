import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parse, type TomlTable, type TomlValue } from 'smol-toml';
import { describe, it, expect } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const PIN_REASON =
  'A Worker served on a workers.dev or preview hostname answers there outside every zone ' +
  'route, WAF rule and Access policy. Wrangler infers workers_dev from whether the config ' +
  'declares routes, and leaves preview_urls to dashboard state for an existing Worker, so ' +
  'each Worker config states both as false rather than inheriting either.';

const HOSTNAME_KEYS = ['workers_dev', 'preview_urls'] as const;

/** The file names Wrangler reads a Worker's config from. */
const CONFIG_NAMES = ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'] as const;

/** Every Worker config in the workspace's apps and packages, found rather than listed. */
function workerConfigs(): readonly string[] {
  return ['apps', 'packages'].flatMap((root) =>
    readdirSync(path.join(REPO_ROOT, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => CONFIG_NAMES.map((name) => path.join(REPO_ROOT, root, entry.name, name)))
      .filter((candidate) => existsSync(candidate))
  );
}

function repoRelative(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/');
}

const WORKER_CONFIGS = workerConfigs();
const TOML_CONFIGS = WORKER_CONFIGS.filter((file) => file.endsWith('.toml')).map((file) => ({
  file: repoRelative(file),
  toml: readFileSync(file, 'utf8'),
}));

const ENV_OVERRIDE = [
  'workers_dev = false',
  'preview_urls = false',
  '',
  '[env.staging]',
  'workers_dev = true',
].join('\n');

/**
 * The config as Wrangler reads it — `smol-toml` is the parser Wrangler
 * bundles. A file the parser rejects is refused rather than admitted, so an
 * unreadable config is not a way past the assertions.
 */
function parseOrRefuse(toml: string): TomlTable {
  try {
    return parse(toml);
  } catch {
    return expect.fail(PIN_REASON);
  }
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

/** The value of every key with this name, wherever in the config it sits. */
function valuesNamed(value: TomlValue, name: string): readonly TomlValue[] {
  if (Array.isArray(value)) return value.flatMap((element) => valuesNamed(element, name));
  if (!isTable(value)) return [];

  return Object.entries(value).flatMap(([key, child]) => [
    ...(key === name ? [child] : []),
    ...valuesNamed(child, name),
  ]);
}

/**
 * Absence is refused alongside `true`: an unstated key is the inference and
 * the dashboard state this pin exists to remove. An environment override is
 * read alongside the top level, so one turning a hostname back on is refused.
 */
function assertHostnamesPinnedOff(config: TomlTable): void {
  for (const key of HOSTNAME_KEYS) {
    expect(config[key], PIN_REASON).toBe(false);
    expect(
      valuesNamed(config, key).filter((value) => value !== false),
      PIN_REASON
    ).toEqual([]);
  }
}

function without(config: TomlTable, key: string): TomlTable {
  return Object.fromEntries(Object.entries(config).filter(([name]) => name !== key));
}

describe('Worker hostnames outside the zone', () => {
  it('finds the product Worker config', () => {
    expect(TOML_CONFIGS.map(({ file }) => file)).toContain('apps/api/wrangler.toml');
  });

  it('finds no Worker config outside TOML', () => {
    expect(
      WORKER_CONFIGS.filter((file) => !file.endsWith('.toml')).map((file) => repoRelative(file)),
      PIN_REASON
    ).toEqual([]);
  });

  it('refuses an environment override that turns one on', () => {
    expect(() => {
      assertHostnamesPinnedOff(parseOrRefuse(ENV_OVERRIDE));
    }).toThrow(PIN_REASON);
  });

  describe.each(TOML_CONFIGS)('$file', ({ toml }) => {
    it('pins both off in the committed config', () => {
      assertHostnamesPinnedOff(parseOrRefuse(toml));
    });

    it.each(HOSTNAME_KEYS)('refuses the config with %s removed', (key) => {
      expect(() => {
        assertHostnamesPinnedOff(without(parseOrRefuse(toml), key));
      }).toThrow(PIN_REASON);
    });

    it.each(HOSTNAME_KEYS)('refuses the config with %s set true', (key) => {
      expect(() => {
        assertHostnamesPinnedOff({ ...parseOrRefuse(toml), [key]: true });
      }).toThrow(PIN_REASON);
    });
  });
});
