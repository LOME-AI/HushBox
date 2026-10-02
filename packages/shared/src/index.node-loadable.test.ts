import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every published entry of this package loads under a `node` that has been
 * given nothing — no loader, no flag, no bundler.
 *
 * This is an execution test rather than a lint rule because the property is a
 * loader's, not a spelling's: `moduleResolution: bundler` accepts `./x.js`
 * where only `x.ts` exists and every bundler rewrites it, so a specifier that
 * no plain loader can follow typechecks clean and passes every other gate. The
 * sites that reach this package without a bundler are the ones that break —
 * Capacitor's CommonJS config load, a Vite or Vitest config load, an Astro
 * config load — and each of them breaks at its own tool, far from here, which
 * is how the package came to carry a convention no loader could follow.
 */

const packageDir = fileURLToPath(new URL('..', import.meta.url));

function exportsMap(): Record<string, string> {
  const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    exports: Record<string, string>;
  };
  return manifest.exports;
}

/** The stderr a plain-Node load of one entry produced, or `undefined` when it exited 0. */
function loadFailure(target: string): string | undefined {
  const result = spawnSync(process.execPath, [target], { cwd: packageDir, encoding: 'utf8' });
  return result.status === 0 ? undefined : result.stderr;
}

/**
 * The one published entry that is a door INTO a DOM environment rather than a
 * module reaching one: it patches `Element.prototype`, and a bare loader has no
 * `Element` to patch. It is pinned below rather than skipped, so that making it
 * loadable reddens here instead of leaving an exception nothing revisits — and
 * the failure it is pinned to is a ReferenceError thrown at its own top level,
 * which is reached only once every specifier in its graph has resolved.
 */
const DOM_ONLY_ENTRY = './test-polyfills';

describe('published entries under a plain Node loader', () => {
  it('publishes the root barrel, so the cases below cannot stop covering it unnoticed', () => {
    expect(exportsMap()['.']).toBe('./src/index.ts');
  });

  it.each(Object.entries(exportsMap()).filter(([subpath]) => subpath !== DOM_ONLY_ENTRY))(
    'loads %s',
    (_subpath, target) => {
      expect(loadFailure(target)).toBeUndefined();
    }
  );

  it('reaches the top level of the one door that needs a DOM, and fails only there', () => {
    const target = exportsMap()[DOM_ONLY_ENTRY];
    if (target === undefined) throw new Error(`${DOM_ONLY_ENTRY} is no longer published`);

    expect(loadFailure(target)).toContain('Element is not defined');
  });
});
