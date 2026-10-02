/**
 * The listing's law, stated over generated checkouts rather than a chosen few,
 * because the arrangements that break it are the awkward ones: a rule in the
 * exclude file naming a record root, a nested file re-including what a root
 * rule excludes, a directory-only pattern above a file-level one, case folding.
 *
 * **The listing is the plan's set.** For any checkout, the record files are
 * exactly the files under a record root that the same checkout, with the
 * records block deleted from its `.gitignore`, does not ignore. The reference
 * is that checkout, built as a second repository, and asked with git's own
 * untracked-file listing; membership of a record root is read off the path.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git } from './overlay.js';
import { listRecordFiles } from './record-files.js';

type Rng = () => number;

/** Deterministic seeded generator (mulberry32), so a failure reproduces exactly. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d_2b_79_f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function intBetween(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[intBetween(rng, 0, items.length - 1)] as T;
}

function some<T>(rng: Rng, items: readonly T[], most: number): T[] {
  return Array.from({ length: intBetween(rng, 0, most) }, () => pick(rng, items));
}

const BLOCK = [
  '# BEGIN records overlay',
  'docs/runs/',
  'docs/history/',
  'docs/audits/*/',
  '/.records.git/',
  '# END records overlay',
];

/** Rules of every shape git distinguishes: negation, anchoring, directory-only, `**`, classes. */
const RULES = [
  '*',
  '!*/',
  '*.log',
  '*.LOG',
  '!keep.log',
  'keep.log',
  '!F.LOG',
  '*.md',
  '!*.md',
  'plan.md',
  '!plan.md',
  '[Pp]lan.md',
  'notes*',
  '!notes1.md',
  '*.local*',
  '*.md.lock',
  '2026-01/',
  '!2026-01/',
  '**/2026-*/',
  '/r1/',
  'r1/',
  '**/sub',
  'sub/**',
  'a/',
  '!a/',
  'x',
  'history/',
  'docs/history/',
  '!docs/history/',
  'docs/audits/2026-02/',
  '/docs/runs/r1/keep.log',
] as const;

const BASES = ['docs/runs', 'docs/history', 'docs/audits', 'docs', '', 'other'] as const;

const SEGMENTS = ['r1', '2026-01', '2026-02', 'x.local', 'a', 'B', 'sub'] as const;

const NAMES = [
  'plan.md',
  'PLAN.MD',
  'keep.log',
  'f.log',
  'F.LOG',
  'notes1.md',
  'notes[0-9].md',
  'n.md.lock',
  'a.local.md',
  'CLAUDE.md',
  'x',
] as const;

const IGNORE_DIRECTORIES = [
  'docs',
  'docs/runs',
  'docs/audits',
  'docs/history',
  'docs/runs/r1',
  'docs/runs/a',
  'docs/runs/r1/sub',
  'docs/audits/2026-01',
] as const;

interface Checkout {
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly nested: ReadonlyMap<string, readonly string[]>;
  readonly exclude: readonly string[];
  readonly userExcludes: readonly string[] | undefined;
  readonly ignoreCase: boolean;
  readonly files: readonly string[];
}

/** A file path. Segments and names are disjoint, so no file sits where another needs a directory. */
function generatePath(rng: Rng): string {
  return [pick(rng, BASES), ...some(rng, SEGMENTS, 3), pick(rng, NAMES)]
    .filter((part) => part !== '')
    .join('/');
}

/** One checkout: its ignore rules at every level git reads them, its config, and its files. */
function generateCheckout(rng: Rng): Checkout {
  const nested = new Map<string, readonly string[]>();
  for (const directory of some(rng, IGNORE_DIRECTORIES, 3))
    nested.set(directory, some(rng, RULES, 3));
  const files = new Set(Array.from({ length: intBetween(rng, 0, 14) }, () => generatePath(rng)));
  return {
    before: some(rng, RULES, 2),
    after: some(rng, RULES, 2),
    nested,
    exclude: some(rng, RULES, 2),
    userExcludes: rng() < 0.3 ? some(rng, RULES, 2) : undefined,
    ignoreCase: rng() < 0.3,
    files: [...files],
  };
}

function lines(rules: readonly string[]): string {
  return rules.map((rule) => `${rule}\n`).join('');
}

function write(root: string, relative: string, content: string): void {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function createRepository(
  root: string,
  checkout: Checkout,
  gitignore: string
): Promise<void> {
  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'core.ignoreCase', String(checkout.ignoreCase)]);
  if (checkout.userExcludes !== undefined) {
    await git(root, ['config', 'core.excludesFile', path.join(root, '..', 'user-excludes')]);
  }
  write(root, '.git/info/exclude', lines(checkout.exclude));
  write(root, '.gitignore', gitignore);
}

/** Under a record root, read off the path alone. */
function underRecordRoot(file: string): boolean {
  return /^docs\/(?:runs|history)\/|^docs\/audits\/[^/]+\//u.test(file);
}

/** The plan's set, asked of a copy of the checkout whose `.gitignore` has no records block. */
async function referenceSet(main: string, checkout: Checkout): Promise<string[]> {
  const reference = path.join(main, '..', 'reference');
  cpSync(main, reference, {
    recursive: true,
    filter: (source) => path.basename(source) !== '.git',
  });
  await createRepository(reference, checkout, lines([...checkout.before, ...checkout.after]));
  const listing = await git(reference, ['ls-files', '-z', '--others', '--exclude-standard']);
  return listing
    .split('\0')
    .filter((file) => file !== '' && underRecordRoot(file))
    .toSorted((a, b) => a.localeCompare(b));
}

/** Checkouts to sweep. Each one runs about a dozen git processes, so the sweep's cost grows linearly with this count. */
const CHECKOUTS = 150;

const SEED = 0x7e_c0_4d_51;

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'records-property-'));
  writeFileSync(path.join(sandbox, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(sandbox, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('XDG_CONFIG_HOME', path.join(sandbox, 'xdg'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('listRecordFiles over generated checkouts', () => {
  it('lists exactly the files under a record root that the checkout without the block does not ignore', async () => {
    const rng = mulberry32(SEED);
    for (let index = 0; index < CHECKOUTS; index += 1) {
      const checkout = generateCheckout(rng);
      const directory = mkdtempSync(path.join(sandbox, 'checkout-'));
      writeFileSync(path.join(directory, 'user-excludes'), lines(checkout.userExcludes ?? []));
      const main = path.join(directory, 'main');
      for (const file of checkout.files) write(main, file, `${file}\n`);
      for (const [folder, rules] of checkout.nested)
        write(main, `${folder}/.gitignore`, lines(rules));
      mkdirSync(main, { recursive: true });
      await createRepository(
        main,
        checkout,
        lines([...checkout.before, ...BLOCK, ...checkout.after])
      );
      const empty = path.join(directory, 'empty.git');
      await git(directory, ['init', '--bare', '--quiet', empty]);

      const files = await listRecordFiles(main, empty);
      const listed = files.toSorted((a, b) => a.localeCompare(b));

      expect({ index, checkout, listed }).toEqual({
        index,
        checkout,
        listed: await referenceSet(main, checkout),
      });
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
