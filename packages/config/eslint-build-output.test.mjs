import path from 'node:path';
import { readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MODULE_EXTENSIONS } from './test-file-spellings.ts';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

const LINTABLE_SUFFIXES = MODULE_EXTENSIONS.map((extension) => `.${extension}`);

// Two anchors rather than one: a tree may scope its rule set to a source root, and
// a single anchor landing outside it would read as "this tree lints nothing".
const SOURCE_ANCHORS = ['lint-probe.ts', 'src/lint-probe.ts'];

/**
 * The directories version control is told to ignore, as git itself reports them.
 *
 * This is the whole point of the probe: which directories hold build output is a
 * fact the tree already carries, so the sweep asks git rather than re-reading the
 * ignore list the assertions are about. `--directory` collapses a wholly ignored
 * tree to its top entry, so a build directory costs one line here however many
 * files it holds.
 */
async function gitIgnoredDirectories() {
  const { stdout } = await promisify(execFile)(
    'git',
    ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'],
    { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024 }
  );
  return stdout
    .split('\n')
    .filter((line) => line.endsWith('/'))
    .map((line) => line.slice(0, -1))
    .filter((line) => !line.split('/').includes('node_modules'));
}

/** The first file ESLint could lint anywhere under `relativeDir`, or undefined. */
function firstLintableFile(relativeDir) {
  // An entry git reported can be gone or unreadable by the time this walks it;
  // a directory holding nothing lintable and one that cannot be read are the
  // same answer here, so neither is an error.
  let entries = [];
  try {
    entries = readdirSync(path.join(REPO_ROOT, ...relativeDir.split('/')), {
      withFileTypes: true,
    });
  } catch {
    entries = [];
  }
  const here = entries.find(
    (entry) => entry.isFile() && LINTABLE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
  );
  if (here !== undefined) return `${relativeDir}/${here.name}`;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const found = firstLintableFile(`${relativeDir}/${entry.name}`);
    if (found !== undefined) return found;
  }
}

/**
 * The tree whose `eslint.config.js` governs `relativeFile` — the nearest ancestor
 * carrying one, because every package lints with `eslint .` from its own root. The
 * repository root, which governs the level below no package, is the empty string.
 */
function governingTree(relativeFile) {
  const segments = relativeFile.split('/').slice(0, -1);
  while (segments.length > 0) {
    const candidate = segments.join('/');
    const entries = readdirSync(path.join(REPO_ROOT, ...segments), { withFileTypes: true });
    if (entries.some((entry) => entry.name === 'eslint.config.js')) return candidate;
    segments.pop();
  }
  return '';
}

/**
 * Resolve every probe out of the eslint configs as shipped, in a child process.
 *
 * Out of process for the reason the sibling suite is: resolving a config in this
 * process loads a second copy of every vendored rule module through a specifier
 * rooted outside this package, and the barely-executed copy lands in this package's
 * coverage report. The reported figure is the length of the serialized
 * configuration, which is what `eslint --print-config` writes — an ignored path
 * resolves nothing at all, and the exit code says only that the command ran.
 */
async function resolveProbes(probes) {
  const source = `
    const path = (await import('node:path')).default;
    const { pathToFileURL } = await import('node:url');
    const { ESLint } = await import('eslint');

    const root = ${JSON.stringify(REPO_ROOT)};
    const probes = ${JSON.stringify(probes)};

    const linters = new Map();
    const resolved = [];
    for (const probe of probes) {
      if (!linters.has(probe.tree)) {
        const cwd = path.join(root, ...probe.tree.split('/').filter(Boolean));
        const config = await import(pathToFileURL(path.join(cwd, 'eslint.config.js')).href);
        linters.set(probe.tree, {
          cwd,
          linter: new ESLint({ cwd, overrideConfigFile: true, overrideConfig: config.default }),
        });
      }
      const { cwd, linter } = linters.get(probe.tree);
      const config = await linter.calculateConfigForFile(path.join(cwd, ...probe.file.split('/')));
      resolved.push({ ...probe, bytes: config === undefined ? 0 : JSON.stringify(config).length });
    }
    process.stdout.write(JSON.stringify(resolved));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', source],
    { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 }
  );
  return JSON.parse(stdout);
}

let answer;

async function buildOutputProbes() {
  answer ??= (async () => {
    const built = [];
    for (const directory of await gitIgnoredDirectories()) {
      const file = firstLintableFile(directory);
      if (file === undefined) continue;
      const tree = governingTree(file);
      built.push({ kind: 'built', tree, file: file.slice(tree === '' ? 0 : tree.length + 1) });
    }
    // The repository root is always present, so the control below measures something
    // in a checkout where nothing has been built yet and the sweep finds no output.
    const trees = [...new Set(['', ...built.map((probe) => probe.tree)])];
    const source = trees.flatMap((tree) =>
      SOURCE_ANCHORS.map((file) => ({ kind: 'source', tree, file }))
    );
    return { trees, resolved: await resolveProbes([...built, ...source]) };
  })();
  return answer;
}

describe('git-ignored build output against the lint gate', () => {
  it('resolves no lint configuration for a built file under any of it', async () => {
    const { resolved } = await buildOutputProbes();

    const linted = resolved
      .filter((probe) => probe.kind === 'built' && probe.bytes > 0)
      .map((probe) => `${probe.tree || '<repo root>'}: ${probe.file} (${probe.bytes} bytes)`);

    expect(linted).toEqual([]);
  });

  // Without this, the assertion above is satisfiable by a resolver that answers
  // "nothing" for every path, and the law would read as held while nothing measured
  // it. A tree that lints no source at either anchor is the same failure wearing a
  // different hat, so both are one list.
  it('still resolves a configuration for source in every tree it swept', async () => {
    const { trees, resolved } = await buildOutputProbes();

    const unmeasured = trees.filter(
      (tree) =>
        !resolved.some((probe) => probe.kind === 'source' && probe.tree === tree && probe.bytes > 0)
    );

    expect(trees.length).toBeGreaterThan(0);
    expect(unmeasured).toEqual([]);
  });
});
