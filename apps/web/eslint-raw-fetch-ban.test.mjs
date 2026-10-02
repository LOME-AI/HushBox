import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = import.meta.dirname;

// The raw-fetch ban governs application source and releases every test-module
// spelling the shared declaration names, which is wider than the two endings
// the block used to list. The paths below are hypothetical:
// `calculateConfigForFile` matches a path against the config and never reads
// the file.
const TEST_MODULE_MARKERS = ['test', 'spec', 'setup'];
const GOVERNED_MODULE = 'src/main.tsx';
const PROBED_PATHS = [
  GOVERNED_MODULE,
  ...TEST_MODULE_MARKERS.map((marker) => `src/probe.${marker}.tsx`),
];

/**
 * The `no-restricted-globals` entries this package's config resolves for each
 * of {@link PROBED_PATHS} — read off ESLint's own resolution, because whether a
 * block releases a file is a property of the resolved config array and not of
 * any one block's `ignores`.
 *
 * Out of process because this package's vitest project cannot import that
 * config: vite's SSR transform rewrites `import.meta.url` for a module outside
 * the project root, and the shared config it composes reads its extension
 * directory from that URL. A plain Node child loads the config file exactly as
 * the lint gate does.
 */
async function probeRestrictedGlobals() {
  const source = `
    const path = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { ESLint } = await import('eslint');
    const root = ${JSON.stringify(PACKAGE_ROOT)};
    const configUrl = pathToFileURL(path.join(root, 'eslint.config.js'));
    const linter = new ESLint({
      cwd: root,
      overrideConfigFile: true,
      overrideConfig: (await import(configUrl.href)).default,
    });
    const out = {};
    for (const relativePath of ${JSON.stringify(PROBED_PATHS)}) {
      const config = await linter.calculateConfigForFile(
        path.join(root, ...relativePath.split('/'))
      );
      const entry = config.rules['no-restricted-globals'] ?? [];
      out[relativePath] = entry.slice(1).map((restriction) => restriction.name);
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', source],
    { cwd: PACKAGE_ROOT }
  );
  return JSON.parse(stdout);
}

const restrictedGlobals = await probeRestrictedGlobals();

describe('the raw-fetch ban reaches every test-module spelling', () => {
  it.each(TEST_MODULE_MARKERS)('releases a .%s module', (marker) => {
    expect(restrictedGlobals[`src/probe.${marker}.tsx`]).not.toContain('fetch');
  });

  it('still bans raw fetch in application source', () => {
    // Without this arm an ignore wide enough to silence the whole package
    // satisfies every assertion above.
    expect(restrictedGlobals[GOVERNED_MODULE]).toContain('fetch');
  });

  it('leaves the accessibility motion ban armed in a released test module', () => {
    // The two restrictions share one rule key deliberately (see the config), so
    // a released file must keep the base config's entry rather than lose both.
    expect(restrictedGlobals['src/probe.test.tsx']).toContain('requestAnimationFrame');
  });
});
