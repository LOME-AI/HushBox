import path from 'node:path';
import process from 'node:process';
import { existsSync, globSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = import.meta.dirname;

// Every bundle directory vite emits here: `dist` from the ordinary build, plus
// one `dist-<platform>` sibling per mobile target (ci.yml runs
// `vite build --outDir dist-$platform` over its platform list). Each holds
// hundreds of minified vendor modules. They are gitignored, which buys nothing,
// because flat config does not read .gitignore — and none of them is checked
// in, so no path below may be asserted to exist.
const BUILD_OUTPUT_DIRECTORIES = [
  'dist',
  'dist-ota',
  'dist-android',
  'dist-android-direct',
  'dist-ios',
];

// A build-output directory no target emits today. The ignore pattern has to
// reach it, which an enumeration of the five above cannot.
const UNBUILT_VARIANT = 'dist-visionos';

const SOURCE_FIXTURE = 'src/main.tsx';

// The guard tests checked in under the two native project trees — plain-text
// assertions over AndroidManifest.xml, the Fastfiles, the Xcode project and the
// entitlements. Discovered rather than listed: the set grows with each native
// invariant somebody decides to pin, and an enumeration stops covering the next
// one added without anybody noticing.
const NATIVE_GUARD_TESTS = globSync(['android/**/*.test.ts', 'ios/**/*.test.ts'], {
  cwd: PACKAGE_ROOT,
}).map((found) => found.split(path.sep).join('/'));

// Where `cap sync` copies the web bundle into each native project. Hypothetical
// paths: `isPathIgnored` matches against the config and never reads the file.
const NATIVE_BUILD_OUTPUT = [
  'android/app/src/main/assets/public/assets/bundle.js',
  'ios/App/App/public/assets/bundle.js',
];

const PROBED_PATHS = [
  ...BUILD_OUTPUT_DIRECTORIES.map((directory) => `${directory}/assets/bundle.js`),
  `${UNBUILT_VARIANT}/assets/bundle.js`,
  SOURCE_FIXTURE,
  ...NATIVE_GUARD_TESTS,
  ...NATIVE_BUILD_OUTPUT,
];

/**
 * Which of {@link PROBED_PATHS} ESLint ignores under the config this package
 * ships — answered by ESLint's own resolution rather than by reading the config
 * file, so a pattern that looks right but resolves against the wrong base still
 * fails.
 *
 * Out of process because this package's vitest project cannot import that
 * config: vite's SSR transform rewrites `import.meta.url` for a module outside
 * the project root, and the shared config it composes reads its extension
 * directory from that URL. A plain Node child loads the config file exactly as
 * the lint gate does.
 */
async function probeIgnoredPaths() {
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
      out[relativePath] = await linter.isPathIgnored(path.join(root, ...relativePath.split('/')));
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

const ignoredPaths = await probeIgnoredPaths();

describe('build output stays out of the lint gate', () => {
  it.each(BUILD_OUTPUT_DIRECTORIES)('ignores %s', (directory) => {
    expect(ignoredPaths[`${directory}/assets/bundle.js`]).toBe(true);
  });

  it('ignores a build-output directory no target emits yet', () => {
    // The arm that outlives the next variant. Naming the directories one at a
    // time is what let three of them walk back in after the first was patched
    // in reactively: a target added to the build list emits a sibling nobody
    // edits this config for. Probing a directory that does not exist is what an
    // enumeration of today's names cannot satisfy and a family glob can.
    expect(existsSync(path.join(PACKAGE_ROOT, UNBUILT_VARIANT))).toBe(false);
    expect(ignoredPaths[`${UNBUILT_VARIANT}/assets/bundle.js`]).toBe(true);
  });

  it('still lints the application source the gate exists for', () => {
    // Without this arm a pattern wide enough to silence the whole package
    // satisfies every assertion above. The fixture is asserted to exist so a
    // rename reddens here instead of leaving a check that measures nothing.
    expect(existsSync(path.join(PACKAGE_ROOT, SOURCE_FIXTURE))).toBe(true);
    expect(ignoredPaths[SOURCE_FIXTURE]).toBe(false);
  });
});

describe('the native guard tests are inside the lint gate', () => {
  it('found guard tests to probe', () => {
    // Without this arm an empty discovery satisfies the block below by running
    // no cases at all, which is exactly the shape of the failure it guards.
    expect(NATIVE_GUARD_TESTS.length).toBeGreaterThan(0);
  });

  it.each(NATIVE_GUARD_TESTS)('lints %s', (relativePath) => {
    expect(ignoredPaths[relativePath]).toBe(false);
  });

  it.each(NATIVE_BUILD_OUTPUT)('still ignores the synced bundle at %s', (relativePath) => {
    // The other half of the pair: whatever releases the guard tests must not
    // also release the web bundle `cap sync` copies in beside them.
    expect(ignoredPaths[relativePath]).toBe(true);
  });
});
