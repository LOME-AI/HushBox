// Liveness for the three curated exemption lists whose dead entry changes
// behaviour: a duplication-scanner ignore glob re-ignores its subject the day
// that subject returns, an unused-code entry or ignore glob silently moves what
// the scan reaches, and a mutation `mutate` glob silently shrinks the mutated
// scope. Each case asserts a property of the tree — this glob still names
// something — never the list's contents, so adding or retiring a live entry
// changes nothing here.
//
// A glob is live when it matches a path git tracks, or when it names a path a
// `.gitignore` rule covers: build output, a cache, a generated bundle. That
// second clause reads the ignore rules rather than the working tree, so a fresh
// checkout holding none of that output still passes, while a glob whose subject
// has left both lists fails. `node_modules` is outside matching by
// construction: the tracked pool comes from git, which lists nothing under it,
// and an ignored subject is represented by the rule that covers it rather than
// by a dependency's files.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readJsonc } from '../../scripts/lib/jsonc.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * A read-only git query's output lines. `check-ignore` exits 1 when no path
 * matched, which is an answer rather than a failure, so the caller states which
 * statuses are answers.
 *
 * git is the instrument because the questions are its own: what the repository
 * tracks, and what its ignore rules cover. A filesystem walk answers a weaker
 * question — it cannot tell a tracked file from a stray one — and no module here
 * publishes a tracked-path listing to import instead.
 *
 * @param {string[]} args
 * @param {{ input?: string, answerStatuses?: number[] }} [options]
 * @returns {string[]}
 */
function gitLines(args, options = {}) {
  const { input, answerStatuses = [0] } = options;
  // The arguments are a list and no shell parses them; what remains of the rule's
  // concern is path resolution of a binary every checkout of this repo requires.
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a prerequisite of the checkout this test reads
  const { error, status, stdout, stderr } = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (error) throw error;
  if (!answerStatuses.includes(status)) {
    throw new Error(`git ${args[0]} exited with ${status}: ${stderr.trim()}`);
  }
  return stdout.split('\n').filter(Boolean);
}

const trackedPaths = gitLines(['ls-files']);

const IGNORE_FILE = /(?:^|\/)\.gitignore$/;
const WILDCARD = /\*+/g;

/**
 * The paths one ignore file's rules name, as paths rather than patterns: the
 * rule's own path and a child of it, so a glob requiring a segment under its
 * subject has something to match. A re-inclusion names no ignored path, so it
 * contributes none.
 *
 * @param {string} ignoreFile
 * @returns {string[]}
 */
function candidatePathsIn(ignoreFile) {
  const directory = path.posix.dirname(ignoreFile);
  const prefix = directory === '.' ? '' : `${directory}/`;
  const lines = readFileSync(path.join(repoRoot, ignoreFile), 'utf8').split('\n');
  return lines.flatMap((line) => {
    const rule = line.trim();
    if (rule === '' || rule.startsWith('#') || rule.startsWith('!')) return [];
    const named = rule
      .replace(/^\*\*\//, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replaceAll(WILDCARD, 'any');
    return named === '' ? [] : [`${prefix}${named}`, `${prefix}${named}/any`];
  });
}

/**
 * Every candidate path the repository's own ignore rules cover, confirmed by
 * git rather than by re-implementing its matching.
 */
const ignoredPaths = gitLines(['check-ignore', '--no-index', '--stdin'], {
  input: trackedPaths
    .filter((file) => IGNORE_FILE.test(file))
    .flatMap((file) => candidatePathsIn(file))
    .join('\n'),
  answerStatuses: [0, 1],
});

/**
 * The paths a glob declared for `workspace` is matched against, relative to it
 * the way the scanner reads it.
 *
 * @param {string} workspace
 * @returns {string[]}
 */
function poolFor(workspace) {
  const prefix = workspace === '.' ? '' : `${workspace}/`;
  return [...trackedPaths, ...ignoredPaths]
    .filter((candidate) => candidate.startsWith(prefix))
    .map((candidate) => candidate.slice(prefix.length));
}

/**
 * The first path a glob names, or `undefined` once its subject is gone. A
 * leading `!` marks an exclusion, whose subject is the pattern after it.
 *
 * @param {string} glob
 * @param {string[]} pool
 * @returns {string | undefined}
 */
function firstMatch(glob, pool) {
  const pattern = glob.startsWith('!') ? glob.slice(1) : glob;
  return pool.find((candidate) => path.posix.matchesGlob(candidate, pattern));
}

const duplicationConfig = /** @type {{ ignore: string[] }} */ (readJsonc('.jscpd.json'));
const mutationConfig = /** @type {{ mutate: string[] }} */ (readJsonc('stryker.config.json'));
const unusedCodeConfig =
  /** @type {{ ignore?: string[], workspaces: Record<string, { entry?: string[], ignore?: string[] }> }} */ (
    readJsonc('knip.jsonc')
  );

const rootPool = poolFor('.');

describe('.jscpd.json ignore globs', () => {
  for (const glob of duplicationConfig.ignore) {
    it(`${glob} still names a path in the tree`, () => {
      expect(firstMatch(glob, rootPool)).not.toBeUndefined();
    });
  }
});

describe('stryker.config.json mutate globs', () => {
  // A negated entry carves out of the positive scope rather than declaring one,
  // so the mutated scope is what the positive globs name.
  const mutated = mutationConfig.mutate.filter((glob) => !glob.startsWith('!'));
  for (const glob of mutated) {
    it(`${glob} still names a path in the tree`, () => {
      expect(firstMatch(glob, rootPool)).not.toBeUndefined();
    });
  }
});

describe('knip.jsonc workspace globs', () => {
  for (const [workspace, block] of Object.entries(unusedCodeConfig.workspaces)) {
    const pool = poolFor(workspace);
    for (const key of /** @type {const} */ (['entry', 'ignore'])) {
      for (const glob of block[key] ?? []) {
        it(`${workspace} ${key} ${glob} still names a path in the tree`, () => {
          expect(firstMatch(glob, pool)).not.toBeUndefined();
        });
      }
    }
  }
});

describe('knip.jsonc top-level ignore globs', () => {
  for (const glob of unusedCodeConfig.ignore ?? []) {
    it(`${glob} still names a path in the tree`, () => {
      expect(firstMatch(glob, rootPool)).not.toBeUndefined();
    });
  }
});
