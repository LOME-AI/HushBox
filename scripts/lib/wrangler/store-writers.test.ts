import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RUNTIME_MODULES,
  RUNTIME_PACKAGE,
  SCANNED_EXTENSIONS,
  findLocalStoreWriters,
  runtimeEmbedders,
  scanTrackedFiles,
  undeclared,
} from './store-writers.js';

import type { DependencyManifest, InstalledManifests } from './store-writers.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

/** The check's entry point, resolved from the specifier this file imports it by. */
const CHECK_ENTRY_POINT = withoutExtension(
  fileURLToPath(import.meta.resolve('./store-writers.js'))
);

const RELATIVE_IMPORT = /(?:from|import\(|require\()\s*["'](\.[^"']*)["']/g;

function withoutExtension(file: string): string {
  return file.slice(0, file.length - path.extname(file).length);
}

/**
 * Whether a file is a corpus of command lines written to be classified rather
 * than run. It is one exactly when it imports the check's entry point: the
 * corpus exists to feed the check, so it imports it, and nothing else in the
 * tree does. Derived from that edge rather than from a path, so it follows a
 * rename or a move and covers a second corpus file the day one appears.
 *
 * The check's own module needs no entry here — its specimen table is written as
 * mapping keys, which the scan reads as declarations rather than as argv.
 */
function isCorpus(file: string, text: string): boolean {
  const directory = path.dirname(path.join(REPO_ROOT, file));
  return [...text.matchAll(RELATIVE_IMPORT)].some(
    (match) => withoutExtension(path.resolve(directory, match[1] ?? '')) === CHECK_ENTRY_POINT
  );
}

function readManifest(file: string): DependencyManifest | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as DependencyManifest;
}

/** What node resolution finds for a package installed under a directory. */
const installedUnder: InstalledManifests = (from, name) => {
  const directory = path.join(from, 'node_modules', name);
  const manifest = readManifest(path.join(directory, 'package.json'));
  return manifest === undefined ? undefined : { directory, manifest };
};

describe('finding what can write a local store in a file', () => {
  it('reports a shell invocation that names no store and no remote flag', () => {
    const found = findLocalStoreWriters(
      'a.ts',
      "await execa('pnpm', ['exec', 'wrangler', 'r2', 'object', 'put', key, '--file', file]);\n"
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.declares).toBe('none');
    expect(found[0]?.command).toBe('r2 object put');
  });

  it('reads a persist target spelled across the lines of an argv array', () => {
    const found = findLocalStoreWriters(
      'a.ts',
      [
        'execa(',
        "  'wrangler',",
        '  [',
        "    'dev',",
        "    '--persist-to',",
        '    store,',
        '  ]',
        ');',
      ].join('\n')
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.declares).toBe('persist');
  });

  it('reads an explicit remote flag carried on a shell continuation line', () => {
    const found = findLocalStoreWriters(
      'ci.yml',
      'run: pnpm exec wrangler r2 object put "bucket/key" \\\n  --file out.zip --remote\n'
    );
    expect(found[0]?.declares).toBe('remote');
  });

  it('accepts the shared argv builder as the declaration it is', () => {
    const found = findLocalStoreWriters(
      'a.ts',
      "await execa('pnpm', ['exec', 'wrangler', ...r2PutArgs(key, file, target)]);\n"
    );
    expect(found[0]?.declares).toBe('shared-builder');
  });

  it('reads a builder spread onto the line after the program', () => {
    const found = findLocalStoreWriters(
      'a.ts',
      [
        "execa('pnpm', [",
        "  'exec',",
        "  'wrangler',",
        '  ...r2PutArgs(key, file, target),',
        ']);',
      ].join('\n')
    );
    expect(found[0]?.declares).toBe('shared-builder');
  });

  it('reads to the end of a file that stops mid-invocation', () => {
    const found = findLocalStoreWriters('a.sh', 'npx wrangler r2 object put a --file b --remote');
    expect(found[0]?.declares).toBe('remote');
  });

  it('asks nothing of a command wrangler gives no local mode', () => {
    const found = findLocalStoreWriters('ci.yml', 'run: pnpm exec wrangler deploy\n');
    expect(found[0]?.declares).toBe('no-local-mode');
  });

  it('holds a command outside that set to the declaration rule', () => {
    const found = findLocalStoreWriters('ci.yml', 'run: pnpm exec wrangler kv key put a b\n');
    expect(found[0]?.declares).toBe('none');
  });

  it('reports a package manifest script that names the program directly', () => {
    const found = findLocalStoreWriters(
      'apps/api/package.json',
      '{\n  "scripts": {\n    "dev": "wrangler dev"\n  }\n}\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('dev');
    expect(found[0]?.declares).toBe('none');
  });

  it('sees the binary run from where it is installed rather than by bare name', () => {
    const found = findLocalStoreWriters(
      'run.sh',
      '#!/bin/sh\n./node_modules/.bin/wrangler r2 object put a --file b\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('r2 object put');
    expect(found[0]?.declares).toBe('none');
  });

  it('sees a package runner whose word nobody wrote down', () => {
    const found = findLocalStoreWriters(
      'ci.yml',
      'run: pnpm dlx wrangler r2 object put a --file b\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('r2 object put');
    expect(found[0]?.declares).toBe('none');
  });

  it('sees a command built with the subprocess template tag', () => {
    const found = findLocalStoreWriters(
      'a.ts',
      'await $`wrangler r2 object put ${key} --file ${zip}`;\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('r2 object put');
    expect(found[0]?.declares).toBe('none');
  });

  it('sees the installed binary chained after another command', () => {
    const found = findLocalStoreWriters(
      'a.sh',
      'cd apps/api && ../../node_modules/.bin/wrangler dev --port 8787\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('dev');
    expect(found[0]?.declares).toBe('none');
  });

  it('sees a manifest script whose runner is filtered to one workspace', () => {
    const found = findLocalStoreWriters(
      'package.json',
      '{\n  "scripts": {\n    "dev": "pnpm --filter @hushbox/api exec wrangler dev"\n  }\n}\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('dev');
  });

  it('sees an exec filtered to one workspace', () => {
    const found = findLocalStoreWriters(
      'ci.yml',
      'run: pnpm --filter @hushbox/api exec wrangler r2 object put a --file b\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('r2 object put');
    expect(found[0]?.declares).toBe('none');
  });

  it('sees a program separated from its runner by a bare argument separator', () => {
    const found = findLocalStoreWriters('ci.yml', 'run: pnpm exec -- wrangler dev\n');
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('dev');
  });

  it('sees a command line that begins with an environment assignment', () => {
    const found = findLocalStoreWriters('a.sh', 'CLOUDFLARE_ENV=dev wrangler dev\n');
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('dev');
  });

  it('sees a command substituted with backticks in a shell script', () => {
    const found = findLocalStoreWriters('a.sh', 'buckets=`wrangler r2 bucket list`\n');
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('r2 bucket list');
  });

  it('sees a program argument quoted with a template literal', () => {
    const found = findLocalStoreWriters('a.ts', 'await execa(`wrangler`, [`dev`]);\n');
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('dev');
  });

  it('sees a binary interpolated into a template literal', () => {
    const found = findLocalStoreWriters(
      'a.ts',
      'await execa(`${root}/node_modules/.bin/wrangler`, [`dev`]);\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('dev');
  });

  it('sees a program run at a pinned version', () => {
    const found = findLocalStoreWriters(
      'ci.yml',
      'run: pnpm dlx wrangler@4 r2 object put a --file b\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('r2 object put');
  });

  it('sees the binary reached by a resolved path rather than by name', () => {
    const found = findLocalStoreWriters(
      'a.test.ts',
      "execa(process.execPath, [wranglerBinaryPath(), 'dev', '--port', '0'], options);\n"
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.declares).toBe('none');
  });

  it('reads a template literal in a JavaScript source as prose, not a command', () => {
    const text = 'throw new Error(`wrangler could not write ${objectPath}`);\n';
    expect(findLocalStoreWriters('a.ts', text)).toHaveLength(0);
  });

  it('reads a quoted object property in a JavaScript source as prose', () => {
    const text = "const env = { CLOUDFLARE_API_TOKEN: 'the wrangler credential' };\n";
    expect(findLocalStoreWriters('a.test.ts', text)).toHaveLength(0);
  });

  it('sees a manifest script that sets the environment before the program', () => {
    const found = findLocalStoreWriters(
      'package.json',
      '{\n  "scripts": {\n    "dev": "CLOUDFLARE_ENV=dev wrangler dev"\n  }\n}\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('dev');
  });

  it('sees a command built by a template tag that carries options', () => {
    const found = findLocalStoreWriters(
      'a.ts',
      'await $({ cwd: apiDir })`pnpm exec wrangler r2 object put ${key} --file ${zip}`;\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('r2 object put');
    expect(found[0]?.declares).toBe('none');
  });

  it('sees a program named as an element of a block sequence', () => {
    const found = findLocalStoreWriters(
      'action.yml',
      ['runs:', '  args:', '    - wrangler', '    - r2', '    - object', '    - put'].join('\n')
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('r2 object put');
    expect(found[0]?.declares).toBe('none');
  });

  it('reads a flag carried by a later element of the same block sequence', () => {
    const found = findLocalStoreWriters(
      'action.yml',
      [
        'runs:',
        '  args:',
        '    - wrangler',
        '    - r2',
        '    - object',
        '    - put',
        '    - --remote',
        '  shell: bash',
      ].join('\n')
    );
    expect(found[0]?.declares).toBe('remote');
  });

  it('leaves a later command out of the window when a shell substitution carries a slash pair', () => {
    const found = findLocalStoreWriters(
      'ci.yml',
      [
        'run: |',
        '  pnpm exec wrangler kv key put "${key//x/y}" value',
        '  pnpm exec wrangler r2 object get bucket/key --remote',
      ].join('\n')
    );
    expect(found).toHaveLength(2);
    expect(found[0]?.declares).toBe('none');
    expect(found[1]?.declares).toBe('remote');
  });

  it('reads a hash inside a quoted string as the text it is, not as a comment', () => {
    const found = findLocalStoreWriters(
      'ci.yml',
      'run: echo "uploading # now"; pnpm exec wrangler r2 object put a --file b --remote\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.declares).toBe('remote');
  });

  it('reads a metacharacter inside a quoted string as the text it is', () => {
    const text = 'run: echo "failed; refusing to upload. wrangler said: $out"\n';
    expect(findLocalStoreWriters('ci.yml', text)).toHaveLength(0);
  });

  it('reads a version-pinned element of a block sequence as a declaration', () => {
    const text = 'minimumReleaseAgeExclude:\n  - wrangler@4.129.0\n  - workerd@1.0.0\n';
    expect(findLocalStoreWriters('w.yaml', text)).toHaveLength(0);
  });

  it('reads a hash comment beside an invocation as prose rather than as its declaration', () => {
    const found = findLocalStoreWriters(
      'ci.yml',
      'run: pnpm exec wrangler kv key put a b # the deploy job passes --remote\n'
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.declares).toBe('none');
  });

  it('reads a hash comment that merely names the program as prose', () => {
    const text = 'run: pnpm build # then wrangler dev by hand\n';
    expect(findLocalStoreWriters('ci.yml', text)).toHaveLength(0);
  });

  it('ignores a mention inside a comment', () => {
    const text = [
      '/**',
      ' * Spawn wrangler dev with stdout teed to a log.',
      ' */',
      '// pnpm exec wrangler r2 object put a --file b',
      'const x = 1;',
    ].join('\n');
    expect(findLocalStoreWriters('a.ts', text)).toHaveLength(0);
  });

  it('ignores a dependency declaration and a package specifier', () => {
    expect(findLocalStoreWriters('package.json', '  "wrangler": "4.129.0"\n')).toHaveLength(0);
    expect(findLocalStoreWriters('w.yaml', "  'wrangler@4.129.0':\n")).toHaveLength(0);
  });

  it('ignores a path that merely contains the word', () => {
    const text =
      "const p = path.join('.wrangler', 'state');\nimport { x } from './wrangler-dev.js';\n";
    expect(findLocalStoreWriters('a.ts', text)).toHaveLength(0);
  });

  it('reports a module import that leaves persistence at its default', () => {
    const text =
      "import { unstable_startWorker } from 'wrangler';\nawait unstable_startWorker({ config });\n";
    const found = findLocalStoreWriters('a.test.ts', text);
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('(module wrangler)');
    expect(found[0]?.declares).toBe('none');
  });

  it('accepts a module import whose worker declares persistence off', () => {
    const text =
      "import { unstable_startWorker } from 'wrangler';\nawait unstable_startWorker({ dev: { persist: false } });\n";
    expect(findLocalStoreWriters('a.test.ts', text)[0]?.declares).toBe('persist');
  });

  it('refuses persistence left switched on, which is the default location again', () => {
    const text =
      "import { unstable_startWorker } from 'wrangler';\nawait unstable_startWorker({ dev: { persist: true } });\n";
    expect(findLocalStoreWriters('a.test.ts', text)[0]?.declares).toBe('none');
  });
});

describe('a module that embeds the runtime rather than a command line', () => {
  it('passes a pool configuration that declares no persistence, which keeps none', () => {
    const text = [
      "import { cloudflareTest } from '@cloudflare/vitest-pool-workers';",
      'export default defineConfig({ plugins: [cloudflareTest({ miniflare: { compatibilityDate } })] });',
    ].join('\n');
    const found = findLocalStoreWriters('vitest.workers.config.ts', text);
    expect(found).toHaveLength(1);
    expect(found[0]?.command).toBe('(module @cloudflare/vitest-pool-workers)');
    expect(found[0]?.declares).toBe('ephemeral');
  });

  it('refuses a pool configuration that switches persistence on without naming a path', () => {
    const text = [
      "import { cloudflareTest } from '@cloudflare/vitest-pool-workers';",
      'cloudflareTest({ miniflare: { r2Persist: true } });',
    ].join('\n');
    expect(findLocalStoreWriters('vitest.workers.config.ts', text)[0]?.declares).toBe('none');
  });

  it('accepts a pool configuration that names where its state goes', () => {
    const text = [
      "import { cloudflareTest } from '@cloudflare/vitest-pool-workers';",
      'cloudflareTest({ miniflare: { defaultPersistRoot: store } });',
    ].join('\n');
    expect(findLocalStoreWriters('vitest.workers.config.ts', text)[0]?.declares).toBe('persist');
  });

  it('sees a configuration that names the runtime nowhere outside a comment', () => {
    const text = [
      '// mirrors wrangler.toml so a runtime change shows up here',
      "import { cloudflareTest } from '@cloudflare/vitest-pool-workers';",
    ].join('\n');
    expect(findLocalStoreWriters('vitest.workers.config.ts', text)).toHaveLength(1);
  });
});

/** A dependency graph standing in for an install tree, addressed by package name. */
function installTree(packages: Readonly<Record<string, DependencyManifest>>): InstalledManifests {
  return (_from, name) =>
    name in packages ? { directory: name, manifest: packages[name] ?? {} } : undefined;
}

describe('which dependencies open the second door', () => {
  it('names the runtime itself where it is declared directly', () => {
    expect(runtimeEmbedders(installTree({}), '.', [RUNTIME_PACKAGE])).toEqual([RUNTIME_PACKAGE]);
  });

  it('names a dependency that declares the runtime', () => {
    const tree = installTree({ pool: { dependencies: { [RUNTIME_PACKAGE]: '1' } } });
    expect(runtimeEmbedders(tree, '.', ['pool'])).toEqual(['pool']);
  });

  it('names a dependency that reaches the runtime through another package', () => {
    const tree = installTree({
      pool: { dependencies: { cli: '1' } },
      cli: { dependencies: { [RUNTIME_PACKAGE]: '1' } },
    });
    expect(runtimeEmbedders(tree, '.', ['pool'])).toEqual(['pool']);
  });

  it('names a dependency that declares the runtime as a peer', () => {
    const tree = installTree({ pool: { peerDependencies: { [RUNTIME_PACKAGE]: '1' } } });
    expect(runtimeEmbedders(tree, '.', ['pool'])).toEqual(['pool']);
  });

  it('passes over a dependency that never reaches the runtime', () => {
    const tree = installTree({ pool: { dependencies: { zod: '1' } }, zod: {} });
    expect(runtimeEmbedders(tree, '.', ['pool'])).toEqual([]);
  });

  it('terminates on a dependency cycle', () => {
    const tree = installTree({
      one: { dependencies: { two: '1' } },
      two: { dependencies: { one: '1' } },
    });
    expect(runtimeEmbedders(tree, '.', ['one'])).toEqual([]);
  });
});

// Every limit stated at `findLocalStoreWriters` has a case that goes red when
// its sentence stops being true. All but one are here; the limit about the
// answers it takes on trust is pinned by the cases accepting a command with no
// local mode and the shared argv builder. A red is not a defect to patch: it
// means the code moved and the sentence has to move with it.
describe('the limits it states about itself', () => {
  it('never opens a tracked kind its extension list omits', () => {
    expect(scanTrackedFiles('a.tsx\0a.ts\0')).toEqual(['a.ts']);
  });

  it('reads no program in a binary reached under another name', () => {
    const text = "const bin = resolveWrangler();\nawait execa(bin, ['dev', '--port', '0']);\n";
    expect(findLocalStoreWriters('a.ts', text)).toEqual([]);
  });

  it('reads no module import that reaches the package by a subpath', () => {
    expect(findLocalStoreWriters('a.ts', "import { unstable_dev } from 'wrangler/api';\n")).toEqual(
      []
    );
  });

  it('stops reading where a line continuation stands between program and subcommand', () => {
    const continued = 'wrangler \\\n  r2 object put a --file b\n';
    expect(findLocalStoreWriters('x.sh', continued)).toEqual([]);
    // The same line unbroken is read, which is what says the continuation is
    // the cause rather than anything else on it.
    expect(findLocalStoreWriters('x.sh', 'wrangler r2 object put a --file b\n')).toHaveLength(1);
  });

  it('reads a later command on the same line as this one, which is the silent direction', () => {
    const found = findLocalStoreWriters(
      'x.sh',
      'wrangler r2 object put a; wrangler dev --remote\n'
    );
    expect(found[0]?.command).toBe('r2 object put');
    expect(found[0]?.declares).toBe('remote');
  });

  it('reads a following command on a line its window does not end at', () => {
    const carried = "wrangler r2 object put a --file b\n'wrangler' dev --remote\n";
    expect(findLocalStoreWriters('x.sh', carried)[0]?.declares).toBe('remote');
    // The same second command opening with a bare word ends the window, which
    // is what says the character it opens with is the cause.
    const ended = 'wrangler r2 object put a --file b\nwrangler dev --remote\n';
    expect(findLocalStoreWriters('x.sh', ended)[0]?.declares).toBe('none');
  });

  it('reads one manifest script entry as declaring what the next one carries', () => {
    const manifest = [
      '{',
      '  "scripts": {',
      '    "upload": "wrangler r2 object put a --file b",',
      '    "dev": "wrangler dev --remote"',
      '  }',
      '}',
      '',
    ].join('\n');
    expect(findLocalStoreWriters('package.json', manifest)[0]?.declares).toBe('remote');
    // The next entry naming no flag leaves the first one answering for itself,
    // so what the window carried in is the second entry rather than the file.
    const alone = manifest.replace('wrangler dev --remote', 'eslint .');
    expect(findLocalStoreWriters('package.json', alone)[0]?.declares).toBe('none');
  });

  it('keeps a comment whose line carries an unmatched quote character', () => {
    const kept = 'const m = "it\'s here"; // wrangler dev is what you want\n';
    expect(findLocalStoreWriters('a.ts', kept)).toHaveLength(1);
    // Nothing but the apostrophe separates this from the line above, and the
    // comment is cut here.
    const cut = 'const m = "it is here"; // wrangler dev is what you want\n';
    expect(findLocalStoreWriters('a.ts', cut)).toEqual([]);
  });
});

describe('every writer in this repository the scan can read', () => {
  // What every writer must do is say where its writes land, which is a
  // disjunction rather than a store: a stack-mode store, an explicit remote, a
  // runtime with persistence switched off, one that keeps none by
  // construction, or a command wrangler gives no local mode at all.
  //
  // What a green here is: nothing undeclared among the writers this scan can
  // read, in the tracked files it opens. What it is not: a guarantee that no
  // write lands in the default store. That is held by the default store itself,
  // left behind as a directory nothing can write; how each of the two doors
  // meets it, and which limits this scan is known to have, are stated in
  // ./store-writers.ts.
  it('says where its writes land, whichever of the answers it gives', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard tool wherever this repo is checked out
    const listing = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    // The listing is the index; the scan judges the working tree. A tracked
    // path the tree no longer holds is a deletion in flight, and it invokes
    // nothing.
    const files = scanTrackedFiles(listing)
      .map((file) => ({ file, full: path.join(REPO_ROOT, file) }))
      .filter(({ full }) => existsSync(full))
      .map(({ file, full }) => ({ file, text: readFileSync(full, 'utf8') }))
      .filter(({ file, text }) => !isCorpus(file, text));
    const invocations = files.flatMap(({ file, text }) => findLocalStoreWriters(file, text));

    // A repository that reaches the runtime nowhere would pass the assertion
    // below while proving nothing, so the scan is held to finding the writers
    // it is here to judge.
    expect(invocations.length).toBeGreaterThan(5);
    expect(
      undeclared(invocations).map((one) => `${one.file}:${String(one.line)} ${one.command}`)
    ).toEqual([]);
  });

  it('classifies every dependency that embeds the runtime, so no door goes unseen', () => {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard tool wherever this repo is checked out
    const listing = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '*package.json'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const manifests = listing
      .split('\0')
      .filter((entry) => entry.length > 0 && !entry.includes('node_modules/'));
    expect(manifests.length).toBeGreaterThan(5);

    const embedders = new Set<string>();
    for (const manifest of manifests) {
      const directory = path.dirname(path.join(REPO_ROOT, manifest));
      const declared = readManifest(path.join(REPO_ROOT, manifest));
      const workspaceDeclares = Object.keys({
        ...declared?.dependencies,
        ...(declared as { devDependencies?: Record<string, string> } | undefined)?.devDependencies,
      });
      for (const name of runtimeEmbedders(installedUnder, directory, workspaceDeclares)) {
        embedders.add(name);
      }
    }

    expect(embedders.size).toBeGreaterThan(0);
    expect([...embedders].filter((name) => !RUNTIME_MODULES.has(name))).toEqual([]);
  });

  it('opens the file kinds its extension list names, and a lockfile never', () => {
    expect(scanTrackedFiles('a.ts\0b.md\0c.yml\0pnpm-lock.yaml\0')).toEqual(['a.ts', 'c.yml']);
    expect(SCANNED_EXTENSIONS).toContain('.mjs');
  });

  it('scans a tracked file whose name declares no kind', () => {
    expect(scanTrackedFiles('.husky/pre-commit\0mobile-tests/docker/Dockerfile\0a.md\0')).toEqual([
      '.husky/pre-commit',
      'mobile-tests/docker/Dockerfile',
    ]);
  });

  it('reads its own corpus as specimens rather than as invocations', () => {
    const file = path.relative(REPO_ROOT, import.meta.filename);
    const text = readFileSync(import.meta.filename, 'utf8');
    // The corpus is command lines by construction, so the scan reports it. The
    // exclusion above is what keeps that from being the assertion's own answer,
    // and it is load-bearing only while both halves of this hold.
    expect(undeclared(findLocalStoreWriters(file, text)).length).toBeGreaterThan(0);
    expect(isCorpus(file, text)).toBe(true);
  });

  it("finds nothing to declare in the check's own module", () => {
    const module = path.join(import.meta.dirname, 'store-writers.ts');
    expect(
      findLocalStoreWriters(path.relative(REPO_ROOT, module), readFileSync(module, 'utf8'))
    ).toEqual([]);
  });
});
