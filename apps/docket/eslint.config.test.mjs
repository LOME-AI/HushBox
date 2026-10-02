import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = import.meta.dirname;

// The console's browser half must not take a value import of the
// `@hushbox/docket` root barrel; its server and CLI halves may, and so may a
// test module, which runs on Node. The paths below are hypothetical:
// `calculateConfigForFile` matches a path against the config and never reads
// the file.
const TEST_MODULE_MARKERS = ['test', 'spec', 'setup'];
const BROWSER_MODULE = 'src/components/probe.tsx';
const SERVER_MODULE = 'src/server/probe.ts';
const PROBED_PATHS = [
  BROWSER_MODULE,
  SERVER_MODULE,
  ...TEST_MODULE_MARKERS.map((marker) => `src/components/probe.${marker}.tsx`),
];

/**
 * Whether the root-barrel ban is armed for each of {@link PROBED_PATHS}, read
 * off ESLint's own resolution: whether a block releases a file is a property of
 * the resolved config array, not of any one block's `ignores`.
 *
 * Out of process because this package's vitest project cannot import that
 * config — vite's SSR transform rewrites `import.meta.url` for a module outside
 * the project root, and the shared config it composes reads its extension
 * directory from that URL. A plain Node child loads the config file exactly as
 * the lint gate does.
 */
async function probeRootBarrelBan() {
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
      out[relativePath] = config.rules['@typescript-eslint/no-restricted-imports'] !== undefined;
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

const banIsArmed = await probeRootBarrelBan();

describe('the root-barrel ban reaches every test-module spelling', () => {
  it.each(TEST_MODULE_MARKERS)('releases a .%s module', (marker) => {
    expect(banIsArmed[`src/components/probe.${marker}.tsx`]).toBe(false);
  });

  it('still bans the root barrel in console browser source', () => {
    // Without this arm an ignore wide enough to silence the whole package
    // satisfies every assertion above.
    expect(banIsArmed[BROWSER_MODULE]).toBe(true);
  });

  it('leaves the console server released, as its own directory ignore says', () => {
    expect(banIsArmed[SERVER_MODULE]).toBe(false);
  });
});
