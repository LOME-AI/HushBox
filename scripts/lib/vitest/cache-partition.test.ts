import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { discoverTestPackages } from '../test-run/test-packages.js';
import { liftedCacheDir } from './vitest-cache.js';

/**
 * The two shapes this repository invokes vitest in must never address one
 * dependency directory.
 *
 * Vite deletes and rebundles a dependency directory whose recorded optimizer
 * hash is not the one the running invocation computes — under whatever run is
 * importing from it, which kills every file collecting in that gap. The hash
 * covers the plugin-name list, and a package lifted into a project registers
 * different plugin names from the same package invoked at its own root, so two
 * shapes sharing a directory delete each other's bundles indefinitely.
 *
 * Both halves below derive their subject rather than listing it: the package
 * roster comes from the workspace and each shape's directory comes from the
 * configuration a real invocation loads, so a new package, a project lifted
 * differently, and a runner that resolves a cache directory differently all
 * reach these assertions without either being edited.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The segment a lifted project sits beneath, read off the function that adds it. */
const LIFTED_CACHE_SEGMENT = path.basename(liftedCacheDir('cache', 'a package'));

/**
 * The configuration loading runs in a child process, and has to.
 *
 * Evaluating a real runner configuration inside this process pulls the modules
 * it imports at runtime into this run's coverage map at the start offset of a
 * native import, while every other suite records the same modules at the
 * vite-node wrapper's offset. The merge keeps one offset per module and remaps
 * every range recorded under the other out of place, so an in-process load
 * silently rewrites unrelated modules' coverage figures. The child loads the
 * same real files, so nothing below is derived from anything less real.
 *
 * Evaluated rather than run from a file so a bare `vite` specifier resolves
 * against the repository, and answered through a file rather than stdout because
 * arbitrary configuration code evaluates in that child and is free to print.
 *
 * Sequential inside the child for the reason the consolidated config states of
 * its own loop: concurrent `loadConfigFromFile` calls end the process silently
 * mid-evaluation.
 */
const CONFIG_LOADER = `
import { writeFileSync } from 'node:fs';
import { loadConfigFromFile } from 'vite';

const [, payload, out] = process.argv;
const loaded = {};
for (const request of JSON.parse(payload)) {
  const result = await loadConfigFromFile(
    { command: 'serve', mode: 'test' },
    request.configFile,
    request.root
  );
  if (result === null) {
    throw new Error('cache-partition: failed to load ' + request.configFile);
  }
  loaded[request.configFile] = {
    cacheDir: result.config.cacheDir ?? null,
    projects: (result.config.test?.projects ?? []).map((project) => ({
      root: project.root ?? null,
      cacheDir: project.cacheDir ?? null,
    })),
  };
}
writeFileSync(out, JSON.stringify(loaded));
`;

interface ConfigRequest {
  readonly configFile: string;
  readonly root: string;
}

/** All a loaded configuration contributes here; nothing else crosses back. */
interface LoadedConfig {
  readonly cacheDir: string | null;
  readonly projects: readonly { root: string | null; cacheDir: string | null }[];
}

async function loadConfigs(
  requests: readonly ConfigRequest[]
): Promise<Record<string, LoadedConfig | undefined>> {
  const directory = mkdtempSync(path.join(tmpdir(), 'hb-cache-partition-configs-'));
  const answer = path.join(directory, 'configs.json');
  try {
    await execa(
      process.execPath,
      ['--input-type=module', '--eval', CONFIG_LOADER, JSON.stringify(requests), answer],
      { cwd: REPO_ROOT }
    );
    return JSON.parse(readFileSync(answer, 'utf8')) as Record<string, LoadedConfig | undefined>;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The `cacheDir` a config declares; a config declaring none is a collision. */
function declaredCacheDir(config: { readonly cacheDir: string | null }, subject: string): string {
  const { cacheDir } = config;
  if (cacheDir === null || cacheDir === '') {
    throw new Error(`cache-partition: ${subject} declares no cacheDir`);
  }
  return cacheDir;
}

interface LiftedProject {
  readonly root: string;
  readonly cacheDir: string;
}

const packages = discoverTestPackages(REPO_ROOT);
const CONSOLIDATED_CONFIG = path.join(REPO_ROOT, 'vitest.projects.config.ts');
const ROOT_CONFIG = path.join(REPO_ROOT, 'vitest.config.ts');

let configs: Record<string, LoadedConfig | undefined> = {};
let lifted: LiftedProject[] = [];

/** One loaded configuration, or the failure of the child to return it. */
function loadedConfig(configFile: string): LoadedConfig {
  const config = configs[configFile];
  if (config === undefined) {
    throw new Error(`cache-partition: nothing was loaded for ${configFile}`);
  }
  return config;
}

beforeAll(async () => {
  configs = await loadConfigs([
    { configFile: CONSOLIDATED_CONFIG, root: REPO_ROOT },
    { configFile: ROOT_CONFIG, root: REPO_ROOT },
    ...packages.map((testPackage) => ({
      configFile: path.join(REPO_ROOT, testPackage.dir, testPackage.configFile),
      root: path.join(REPO_ROOT, testPackage.dir),
    })),
  ]);
  lifted = loadedConfig(CONSOLIDATED_CONFIG).projects.map((project, index) => {
    const { root } = project;
    if (root === null) {
      throw new Error(`cache-partition: the lifted project at index ${String(index)} has no root`);
    }
    return { root, cacheDir: declaredCacheDir(project, `the project rooted at ${root}`) };
  });
}, 120_000);

describe('the repository configuration, in both invocation shapes', () => {
  it('lifts a project for every discovered package, so none escapes this check', () => {
    const liftedRoots = new Set(lifted.map((project) => project.root));
    for (const testPackage of packages) {
      expect(liftedRoots, testPackage.dir).toContain(path.join(REPO_ROOT, testPackage.dir));
    }
  });

  it('lifts no project from a root that is not a discovered package', () => {
    const discoveredRoots = new Set(
      packages.map((testPackage) => path.join(REPO_ROOT, testPackage.dir))
    );
    for (const project of lifted) {
      expect(discoveredRoots, project.root).toContain(project.root);
    }
  });

  it('resolves a different cache directory per shape for every discovered package', () => {
    for (const testPackage of packages) {
      const packageRoot = path.join(REPO_ROOT, testPackage.dir);
      const own = loadedConfig(path.join(packageRoot, testPackage.configFile));
      const packageRooted = path.resolve(packageRoot, declaredCacheDir(own, testPackage.dir));
      for (const project of lifted.filter((entry) => entry.root === packageRoot)) {
        expect(path.resolve(project.root, project.cacheDir), testPackage.dir).not.toBe(
          packageRooted
        );
      }
    }
  });

  it('resolves a different cache directory per shape for the repository root itself', () => {
    const rootRooted = path.resolve(
      REPO_ROOT,
      declaredCacheDir(loadedConfig(ROOT_CONFIG), 'the repository root config')
    );
    expect(
      path.resolve(
        REPO_ROOT,
        declaredCacheDir(loadedConfig(CONSOLIDATED_CONFIG), 'the consolidated config')
      )
    ).not.toBe(rootRooted);
  });

  it('keeps every lifted directory inside the generation one sweep already reclaims', () => {
    for (const project of lifted) {
      const resolved = path.resolve(project.root, project.cacheDir);
      expect(path.basename(resolved), project.root).toBe(LIFTED_CACHE_SEGMENT);
    }
  });
});

/**
 * The runner's own behaviour, taken from the runner rather than from its source:
 * a relative per-project cache directory resolves against the lifted root, and
 * {@link liftedCacheDir} therefore separates the two shapes' bundles rather than
 * moving one of them somewhere the other still reaches. A runner that resolves
 * either differently fails here instead of failing a run.
 */
describe('the runner itself, invoked in both shapes over one package', () => {
  const FIXTURE_CACHE_DIR = path.join('node_modules', '.vite-fixture');
  let fixture = '';
  let packageRootedHash = '';

  const dependencyDirectories = (): string[] => {
    const found: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const child = path.join(directory, entry.name);
        if (entry.name === 'deps_ssr') {
          found.push(child);
        } else {
          walk(child);
        }
      }
    };
    walk(path.join(fixture, 'pkg', FIXTURE_CACHE_DIR));
    return found;
  };

  const optimizerHash = (dependencyDirectory: string): string => {
    const metadata = readFileSync(path.join(dependencyDirectory, '_metadata.json'), 'utf8');
    return (JSON.parse(metadata) as { configHash: string }).configHash;
  };

  const packageRootedDirectory = (): string =>
    dependencyDirectories().find(
      (directory) => !directory.split(path.sep).includes(LIFTED_CACHE_SEGMENT)
    ) ?? '';

  beforeAll(async () => {
    fixture = mkdtempSync(path.join(tmpdir(), 'hb-cache-partition-'));
    writeFixture(fixture, FIXTURE_CACHE_DIR);
    await runVitest(path.join(fixture, 'pkg'), []);
    packageRootedHash = optimizerHash(packageRootedDirectory());
    await runVitest(fixture, ['--config', path.join(fixture, 'consolidated.config.ts')]);
  }, 120_000);

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('leaves the two shapes holding a bundle each', () => {
    expect(dependencyDirectories()).toHaveLength(2);
  });

  it('writes the lifted bundle beneath the segment, under the lifted root', () => {
    expect(dependencyDirectories()).toContainEqual(
      expect.stringContaining(
        path.join(fixture, 'pkg', FIXTURE_CACHE_DIR, LIFTED_CACHE_SEGMENT) + path.sep
      )
    );
  });

  it('leaves the package-rooted bundle valid for its own shape', () => {
    expect(optimizerHash(packageRootedDirectory())).toBe(packageRootedHash);
  });

  it('gives the two shapes different optimizer hashes, which is what made them collide', () => {
    const liftedDirectory = dependencyDirectories().find((directory) =>
      directory.split(path.sep).includes(LIFTED_CACHE_SEGMENT)
    );
    expect(optimizerHash(liftedDirectory ?? '')).not.toBe(packageRootedHash);
  });
});

/**
 * A two-file workspace the runner can be pointed at in either shape: one package
 * with a dependency to prebundle, and a consolidated config lifting it exactly
 * as the repository's own does. Nothing here imports from the repository, so the
 * fixture needs no installed modules of its own.
 */
function writeFixture(root: string, cacheDir: string): void {
  const packageRoot = path.join(root, 'pkg');
  const dependency = path.join(packageRoot, 'node_modules', 'fixture-dependency');
  mkdirSync(dependency, { recursive: true });
  writeFileSync(
    path.join(dependency, 'package.json'),
    '{"name":"fixture-dependency","version":"1.0.0","type":"module","main":"index.js"}'
  );
  writeFileSync(path.join(dependency, 'index.js'), 'export const value = 42;\n');
  writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"pkg","type":"module"}');
  writeFileSync(
    path.join(packageRoot, 'a.probe.ts'),
    "import { value } from 'fixture-dependency';\n" +
      "if (value !== 42) { throw new Error('fixture dependency did not load'); }\n"
  );
  const test = {
    name: 'pkg',
    include: ['*.probe.ts'],
    deps: { optimizer: { ssr: { enabled: true, include: ['fixture-dependency'] } } },
  };
  writeFileSync(
    path.join(packageRoot, 'vitest.config.ts'),
    `export default ${JSON.stringify({ cacheDir, test }, null, 2)};\n`
  );
  writeFileSync(
    path.join(root, 'consolidated.config.ts'),
    `export default ${JSON.stringify(
      {
        test: {
          projects: [{ root: packageRoot, cacheDir: liftedCacheDir(cacheDir, 'pkg'), test }],
        },
      },
      null,
      2
    )};\n`
  );
}

/**
 * The fixture collects no test, which is the point — the prebundle follows the
 * declared include list, and a fixture that asserted anything would be asserting
 * about vitest rather than about where it caches.
 */
async function runVitest(cwd: string, args: readonly string[]): Promise<void> {
  await execa('vitest', ['run', '--passWithNoTests', ...args], {
    cwd,
    preferLocal: true,
    localDir: REPO_ROOT,
  });
}
