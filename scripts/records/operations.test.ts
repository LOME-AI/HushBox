import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOUR_MS, TEST_DAY_START, freezeClock, isoAt, secondsAt } from '@hushbox/shared/test-time';
import { init, restore, save, status } from './operations.js';
import { git, overlayDirectory, overlayGit } from './overlay.js';

/** The repository's own `.gitignore`, so every rule the checkout ships is in force. */
const SHIPPED_GITIGNORE = readFileSync(
  path.join(import.meta.dirname, '..', '..', '.gitignore'),
  'utf8'
);

/** The repository's own `.gitattributes`, whose line-ending rules a checkout applies. */
const SHIPPED_GITATTRIBUTES = readFileSync(
  path.join(import.meta.dirname, '..', '..', '.gitattributes'),
  'utf8'
);

/** Mid-afternoon of the reference day, so a commit stamped with the time of day would differ. */
const NOW = TEST_DAY_START + 15 * HOUR_MS + 7;

const DAY = isoAt(TEST_DAY_START).slice(0, 10);

const RECORDS = {
  'docs/runs/run-a/plan.md': 'the plan\n',
  'docs/history/OLD-PLAN.md': 'an old plan\n',
  'docs/audits/audit-a/findings/F-1.md': 'a finding\n',
} as const;

let sandbox: string;
let checkout: string;
let remote: string;
let printed: string[];
let servers: Server[];

const log = (line: string): void => {
  printed.push(line);
};

function write(root: string, relative: string, content = `${relative}\n`): void {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function read(root: string, relative: string): string {
  return readFileSync(path.join(root, ...relative.split('/')), 'utf8');
}

/** Every entry under `root` but the main repository's `.git`, with each file's bytes. */
function workingTree(root: string): Record<string, string> {
  const tree: Record<string, string> = {};
  const walk = (relative: string): void => {
    for (const name of readdirSync(path.join(root, relative))) {
      const entry = relative === '' ? name : `${relative}/${name}`;
      if (entry === '.git') continue;
      const full = path.join(root, entry);
      if (lstatSync(full).isDirectory()) {
        tree[`${entry}/`] = 'directory';
        walk(entry);
      } else {
        tree[entry] = readFileSync(full).toString('base64');
      }
    }
  };
  walk('');
  return tree;
}

function writeRecords(root: string): void {
  for (const [relative, content] of Object.entries(RECORDS)) write(root, relative, content);
}

/** A main repository with one commit holding the shipped `.gitignore` and the audits guide. */
async function createCheckout(name: string): Promise<string> {
  const root = path.join(sandbox, name);
  mkdirSync(root);
  await git(root, ['init', '--quiet', '--initial-branch=main']);
  write(root, '.gitignore', SHIPPED_GITIGNORE);
  write(root, 'docs/audits/CLAUDE.md', 'how to work a finding\n');
  await git(root, ['add', '.gitignore', 'docs/audits/CLAUDE.md']);
  await git(root, ['commit', '--quiet', '--message', 'base']);
  return root;
}

/** Makes every later commit fail: signing is required and the signing program does not exist. */
function refuseCommits(): void {
  appendFileSync(
    path.join(sandbox, 'gitconfig'),
    `[commit]\n\tgpgSign = true\n[gpg]\n\tprogram = ${path.join(sandbox, 'no-such-signer')}\n`
  );
}

/** A remote on this machine that answers every request by asking for credentials. */
async function remoteAskingForCredentials(): Promise<string> {
  // An askpass program would answer before git reaches its own prompt.
  vi.stubEnv('GIT_ASKPASS', '');
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="records"' });
    response.end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port to reach');
  return `http://127.0.0.1:${String(address.port)}/records.git`;
}

async function remoteFiles(): Promise<string[]> {
  const listing = await git(sandbox, [
    `--git-dir=${remote}`,
    'ls-tree',
    '-r',
    '--name-only',
    'main',
  ]);
  return listing.split('\n').filter((line) => line !== '');
}

async function overlayCommits(root: string): Promise<number> {
  return Number(await overlayGit(root, ['rev-list', '--count', 'main']));
}

interface MainState {
  readonly status: string;
  readonly head: string;
  readonly headCommit: string;
  readonly index: string;
  readonly config: string;
}

/** What the main repository holds that no subcommand may change. */
async function mainState(root: string): Promise<MainState> {
  return {
    status: await git(root, ['--no-optional-locks', 'status', '--porcelain']),
    head: read(root, '.git/HEAD'),
    headCommit: await git(root, ['rev-parse', 'HEAD']),
    index: readFileSync(path.join(root, '.git', 'index')).toString('base64'),
    config: read(root, '.git/config'),
  };
}

async function expectMainUntouched(root: string, action: () => Promise<unknown>): Promise<void> {
  const before = await mainState(root);
  await action();
  expect(await mainState(root)).toEqual(before);
}

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'records-operations-'));
  writeFileSync(
    path.join(sandbox, 'gitconfig'),
    '[user]\n\tname = Records Test\n\temail = records-test@hushbox.ai\n'
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(sandbox, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  freezeClock(NOW, { toFake: ['Date'] });
  printed = [];
  servers = [];
  remote = path.join(sandbox, 'remote.git');
  await git(sandbox, ['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  checkout = await createCheckout('checkout');
});

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        })
    )
  );
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('init', () => {
  it('creates a bare overlay whose HEAD names main', async () => {
    await init({ root: checkout, log, remote });

    expect({
      bare: await overlayGit(checkout, ['config', 'core.bare']),
      head: await overlayGit(checkout, ['symbolic-ref', 'HEAD']),
    }).toEqual({ bare: 'true', head: 'refs/heads/main' });
  });

  it('hides untracked files from the overlay status', async () => {
    await init({ root: checkout, log, remote });

    expect(await overlayGit(checkout, ['config', 'status.showUntrackedFiles'])).toBe('no');
  });

  it('names the remote origin', async () => {
    await init({ root: checkout, log, remote });

    expect(await overlayGit(checkout, ['remote', 'get-url', 'origin'])).toBe(remote);
  });

  it('saves the record files to the remote', async () => {
    writeRecords(checkout);

    await init({ root: checkout, log, remote });

    expect(await remoteFiles()).toEqual(
      Object.keys(RECORDS).toSorted((a, b) => a.localeCompare(b))
    );
  });

  it('refuses a checkout that already has an overlay', async () => {
    await init({ root: checkout, log, remote });

    await expect(init({ root: checkout, log, remote })).rejects.toThrow(/already exists/u);
  });

  it('pushes nothing when there is no record to save', async () => {
    await init({ root: checkout, log, remote });

    expect({
      printed,
      remoteMain: (await git(sandbox, [`--git-dir=${remote}`, 'branch', '--list', 'main'])) === '',
    }).toEqual({ printed: ['records: nothing to save'], remoteMain: true });
  });

  it('leaves the main repository untouched', async () => {
    writeRecords(checkout);

    await expectMainUntouched(checkout, () => init({ root: checkout, log, remote }));
  });
});

describe('save', () => {
  beforeEach(async () => {
    await init({ root: checkout, log, remote });
    printed = [];
  });

  it('commits and pushes a new record file', async () => {
    write(checkout, 'docs/runs/run-a/plan.md');

    await save({ root: checkout, log });

    expect(await remoteFiles()).toEqual(['docs/runs/run-a/plan.md']);
  });

  it('never adds a lock, log or local file under a record root', async () => {
    write(checkout, 'docs/runs/run-a/plan.md');
    write(checkout, 'docs/audits/audit-a/findings/F-1.md.lock');
    write(checkout, 'docs/runs/run-a/agent.log');
    write(checkout, 'docs/runs/run-a/scratch.local/notes.md');

    await save({ root: checkout, log });

    expect(await remoteFiles()).toEqual(['docs/runs/run-a/plan.md']);
  });

  it('adds a record file whose name reads as a pattern, and only that file', async () => {
    write(checkout, 'docs/runs/run-a/.gitignore', 'notes1.md\n');
    write(checkout, 'docs/runs/run-a/notes[0-9].md');
    write(checkout, 'docs/runs/run-a/notes1.md');

    await save({ root: checkout, log });

    expect(await remoteFiles()).toEqual([
      'docs/runs/run-a/.gitignore',
      'docs/runs/run-a/notes[0-9].md',
    ]);
  });

  it('never adds the audits guide', async () => {
    write(checkout, 'docs/audits/CLAUDE.md', 'changed guide\n');
    write(checkout, 'docs/runs/run-a/plan.md');

    await save({ root: checkout, log });

    expect(await remoteFiles()).toEqual(['docs/runs/run-a/plan.md']);
  });

  it('commits a changed record file', async () => {
    write(checkout, 'docs/runs/run-a/plan.md', 'first\n');
    await save({ root: checkout, log });
    write(checkout, 'docs/runs/run-a/plan.md', 'second\n');

    await save({ root: checkout, log });

    expect(
      await git(sandbox, [`--git-dir=${remote}`, 'show', 'main:docs/runs/run-a/plan.md'])
    ).toBe('second');
  });

  it('removes a deleted record file', async () => {
    writeRecords(checkout);
    await save({ root: checkout, log });
    rmSync(path.join(checkout, 'docs', 'history'), { recursive: true });

    await save({ root: checkout, log });

    expect(await remoteFiles()).not.toContain('docs/history/OLD-PLAN.md');
  });

  it('makes no commit when nothing changed', async () => {
    writeRecords(checkout);
    await save({ root: checkout, log });
    printed = [];

    await save({ root: checkout, log });

    expect({ commits: await overlayCommits(checkout), printed }).toEqual({
      commits: 1,
      printed: ['records: nothing to save'],
    });
  });

  it('stamps author and committer with the start of the UTC day', async () => {
    writeRecords(checkout);

    await save({ root: checkout, log });

    expect(await overlayGit(checkout, ['log', '-1', '--format=%ad|%cd', '--date=raw'])).toBe(
      `${String(secondsAt(TEST_DAY_START))} +0000|${String(secondsAt(TEST_DAY_START))} +0000`
    );
  });

  it('names the commit after the UTC day', async () => {
    writeRecords(checkout);

    await save({ root: checkout, log });

    expect(await overlayGit(checkout, ['log', '-1', '--format=%s'])).toBe(`Records ${DAY}`);
  });

  it('names the commit step when the commit fails', async () => {
    refuseCommits();
    writeRecords(checkout);

    await expect(save({ root: checkout, log })).rejects.toThrow(/^records: commit failed/u);
  });

  it('names the push step when the push fails', async () => {
    await overlayGit(checkout, ['remote', 'set-url', 'origin', path.join(sandbox, 'absent.git')]);
    writeRecords(checkout);

    await expect(save({ root: checkout, log })).rejects.toThrow(/^records: push failed/u);
  });

  it('names the push step when the remote asks for credentials', async () => {
    await overlayGit(checkout, ['remote', 'set-url', 'origin', await remoteAskingForCredentials()]);
    writeRecords(checkout);

    await expect(save({ root: checkout, log })).rejects.toThrow(
      /^records: push failed: .*terminal prompts disabled/su
    );
  });

  it('saves a file under a record root spelled in another case when the main repository folds case', async () => {
    await git(checkout, ['config', 'core.ignoreCase', 'true']);
    write(checkout, 'Docs/Runs/r/upper.md');

    await save({ root: checkout, log });

    expect(await remoteFiles()).toEqual(['Docs/Runs/r/upper.md']);
  });

  it('pushes a commit an earlier push left behind even when nothing is new', async () => {
    await overlayGit(checkout, ['remote', 'set-url', 'origin', path.join(sandbox, 'absent.git')]);
    writeRecords(checkout);
    await save({ root: checkout, log }).catch(() => undefined);
    await overlayGit(checkout, ['remote', 'set-url', 'origin', remote]);

    await save({ root: checkout, log });

    expect(await remoteFiles()).toEqual(
      Object.keys(RECORDS).toSorted((a, b) => a.localeCompare(b))
    );
  });

  it('refuses a checkout with no overlay, naming both ways to make one', async () => {
    const bare = await createCheckout('no-overlay');

    await expect(save({ root: bare, log })).rejects.toThrow(
      /pnpm records init.*pnpm records restore/u
    );
  });

  it('leaves the main repository untouched', async () => {
    writeRecords(checkout);

    await expectMainUntouched(checkout, () => save({ root: checkout, log }));
  });

  it('works on the overlay when the environment points git at the main repository', async () => {
    vi.stubEnv('GIT_DIR', path.join(checkout, '.git'));
    vi.stubEnv('GIT_WORK_TREE', checkout);
    vi.stubEnv('GIT_INDEX_FILE', path.join(checkout, '.git', 'index'));
    writeRecords(checkout);

    await save({ root: checkout, log });

    expect(await remoteFiles()).toEqual(
      Object.keys(RECORDS).toSorted((a, b) => a.localeCompare(b))
    );
  });

  it('leaves the main repository untouched when the environment points git at it', async () => {
    writeRecords(checkout);

    await expectMainUntouched(checkout, async () => {
      vi.stubEnv('GIT_DIR', path.join(checkout, '.git'));
      vi.stubEnv('GIT_WORK_TREE', checkout);
      vi.stubEnv('GIT_INDEX_FILE', path.join(checkout, '.git', 'index'));
      await save({ root: checkout, log });
    });
  });
});

describe('status', () => {
  beforeEach(async () => {
    write(checkout, 'docs/runs/run-a/plan.md', 'first\n');
    write(checkout, 'docs/history/OLD-PLAN.md');
    await init({ root: checkout, log, remote });
    printed = [];
  });

  it('names each record file save would add, change or delete', async () => {
    write(checkout, 'docs/runs/run-a/plan.md', 'second\n');
    rmSync(path.join(checkout, 'docs', 'history'), { recursive: true });
    write(checkout, 'docs/audits/audit-a/findings/F-1.md');

    await status({ root: checkout, log });

    expect(printed.slice(0, -1)).toEqual([
      'added docs/audits/audit-a/findings/F-1.md',
      'deleted docs/history/OLD-PLAN.md',
      'modified docs/runs/run-a/plan.md',
    ]);
  });

  it('names a record file staged by a commit that failed as added', async () => {
    refuseCommits();
    write(checkout, 'docs/audits/audit-a/findings/F-1.md');
    await save({ root: checkout, log }).catch(() => undefined);
    printed = [];

    await status({ root: checkout, log });

    expect(printed.slice(0, -1)).toEqual(['added docs/audits/audit-a/findings/F-1.md']);
  });

  it('says main is not ahead once it is pushed', async () => {
    await status({ root: checkout, log });

    expect(printed).toEqual(['records: main is not ahead of origin/main']);
  });

  it('counts the commits main holds that origin does not', async () => {
    await overlayGit(checkout, ['remote', 'set-url', 'origin', path.join(sandbox, 'absent.git')]);
    write(checkout, 'docs/runs/run-a/plan.md', 'second\n');
    await save({ root: checkout, log }).catch(() => undefined);
    printed = [];

    await status({ root: checkout, log });

    expect(printed).toEqual(['records: main is 1 commit(s) ahead of origin/main']);
  });

  it('says an overlay with no commit is not ahead', async () => {
    const empty = await createCheckout('empty');
    await init({ root: empty, log, remote: path.join(sandbox, 'absent.git') });
    printed = [];

    await status({ root: empty, log });

    expect(printed).toEqual(['records: main is not ahead of origin/main']);
  });

  it('refuses a checkout with no overlay', async () => {
    const bare = await createCheckout('no-overlay');

    await expect(status({ root: bare, log })).rejects.toThrow(/pnpm records init/u);
  });

  it('leaves the main repository untouched', async () => {
    write(checkout, 'docs/runs/run-a/plan.md', 'second\n');

    await expectMainUntouched(checkout, () => status({ root: checkout, log }));
  });
});

describe('restore', () => {
  let second: string;

  beforeEach(async () => {
    writeRecords(checkout);
    await init({ root: checkout, log, remote });
    second = await createCheckout('second');
    printed = [];
  });

  it('reproduces the record files of the checkout that saved them', async () => {
    await restore({ root: second, log, remote });

    expect(
      Object.fromEntries(Object.keys(RECORDS).map((file) => [file, read(second, file)]))
    ).toEqual(RECORDS);
  });

  it('hides untracked files from the overlay status', async () => {
    await restore({ root: second, log, remote });

    expect(await overlayGit(second, ['config', 'status.showUntrackedFiles'])).toBe('no');
  });

  it('leaves the restored overlay level with origin', async () => {
    await restore({ root: second, log, remote });
    printed = [];

    await status({ root: second, log });

    expect(printed).toEqual(['records: main is not ahead of origin/main']);
  });

  it('saves to the remote it restored from', async () => {
    await restore({ root: second, log, remote });
    write(second, 'docs/runs/run-b/plan.md');

    await save({ root: second, log });

    expect(await remoteFiles()).toContain('docs/runs/run-b/plan.md');
  });

  it('refuses a checkout that already has an overlay', async () => {
    await expect(restore({ root: checkout, log, remote })).rejects.toThrow(/already exists/u);
  });

  it('refuses a checkout holding one record file', async () => {
    write(second, 'docs/history/OLD-PLAN.md', 'local only\n');

    await expect(restore({ root: second, log, remote })).rejects.toThrow(/record file/u);
  });

  it('leaves the local record file and creates no overlay when it refuses', async () => {
    write(second, 'docs/history/OLD-PLAN.md', 'local only\n');

    await restore({ root: second, log, remote }).catch(() => undefined);

    expect({
      record: read(second, 'docs/history/OLD-PLAN.md'),
      overlay: existsSync(overlayDirectory(second)),
    }).toEqual({ record: 'local only\n', overlay: false });
  });

  it('restores over files that are not records', async () => {
    write(second, 'docs/runs/run-a/agent.log', 'a log\n');

    await restore({ root: second, log, remote });

    expect(read(second, 'docs/runs/run-a/plan.md')).toBe(RECORDS['docs/runs/run-a/plan.md']);
  });

  /** Local files that are not records, each at a path where the remote holds something. */
  const COLLISIONS = [
    {
      what: 'a file the remote also holds',
      exclude: 'docs/runs/run-a/plan.md',
      local: 'docs/runs/run-a/plan.md',
      occupied: 'docs/runs/run-a/plan.md',
    },
    {
      what: 'a file where the remote holds a folder',
      exclude: '/docs/runs/run-a',
      local: 'docs/runs/run-a',
      occupied: 'docs/runs/run-a',
    },
    {
      what: 'a folder where the remote holds a file',
      exclude: '/docs/history/OLD-PLAN.md/',
      local: 'docs/history/OLD-PLAN.md/inner.md',
      occupied: 'docs/history/OLD-PLAN.md',
    },
  ] as const;

  function collide(collision: (typeof COLLISIONS)[number]): void {
    write(second, '.git/info/exclude', `${collision.exclude}\n`);
    write(second, collision.local, 'local only\n');
  }

  it.each(COLLISIONS)('refuses a checkout holding $what', async (collision) => {
    collide(collision);

    await expect(restore({ root: second, log, remote })).rejects.toThrow(
      `records: restore refused: ${collision.occupied} already exists`
    );
  });

  it.each(COLLISIONS)(
    'leaves the working tree and its parent as they were when it refuses $what',
    async (collision) => {
      collide(collision);
      const before = { tree: workingTree(second), beside: readdirSync(sandbox) };

      await restore({ root: second, log, remote }).catch(() => undefined);

      expect({ tree: workingTree(second), beside: readdirSync(sandbox) }).toEqual(before);
    }
  );

  it('refuses a checkout holding a log file the remote also holds', async () => {
    write(checkout, 'docs/runs/run-a/agent.log', 'the saved log\n');
    await overlayGit(checkout, ['add', '--force', '--', 'docs/runs/run-a/agent.log']);
    await save({ root: checkout, log });
    write(second, 'docs/runs/run-a/agent.log', 'local log\n');

    await restore({ root: second, log, remote }).catch(() => undefined);

    expect(read(second, 'docs/runs/run-a/agent.log')).toBe('local log\n');
  });

  it('leaves nothing beside the checkout when the clone fails', async () => {
    const before = readdirSync(sandbox);

    await restore({ root: second, log, remote: path.join(sandbox, 'absent.git') }).catch(
      () => undefined
    );

    expect(readdirSync(sandbox)).toEqual(before);
  });

  /** Runs `action` while the checkout root refuses new entries, so the overlay cannot move in. */
  async function withRootLocked(action: () => Promise<unknown>): Promise<void> {
    chmodSync(second, 0o555);
    try {
      await action();
    } finally {
      chmodSync(second, 0o755);
    }
  }

  /** The working tree, the main repository's git directory and the checkout's parent. */
  function surroundings(): Record<string, unknown> {
    return {
      tree: workingTree(second),
      gitDirectory: readdirSync(path.join(second, '.git')),
      beside: readdirSync(sandbox),
      overlay: existsSync(overlayDirectory(second)),
    };
  }

  it('names the step that fails when the overlay cannot be moved into place', async () => {
    await withRootLocked(() =>
      expect(restore({ root: second, log, remote })).rejects.toThrow(
        /^records: move the overlay into place failed: /u
      )
    );
  });

  it('leaves everything as it was when the overlay cannot be moved into place', async () => {
    const before = surroundings();

    await withRootLocked(() => restore({ root: second, log, remote }).catch(() => undefined));

    expect(surroundings()).toEqual(before);
  });

  /** Makes every checkout fail once it has written the files. */
  function failAfterCheckout(): void {
    const hooks = path.join(sandbox, 'hooks');
    write(hooks, 'post-checkout', '#!/bin/sh\nexit 1\n');
    chmodSync(path.join(hooks, 'post-checkout'), 0o755);
    appendFileSync(path.join(sandbox, 'gitconfig'), `[core]\n\thooksPath = ${hooks}\n`);
  }

  it('leaves everything as it was when the checkout fails after writing the records', async () => {
    failAfterCheckout();
    const before = surroundings();

    await restore({ root: second, log, remote }).catch(() => undefined);

    expect(surroundings()).toEqual(before);
  });

  it('leaves everything as it was when a failed checkout wrote a record stored with CRLF line endings', async () => {
    write(checkout, 'docs/runs/run-a/windows.md', 'one\r\ntwo\r\n');
    await save({ root: checkout, log });
    write(second, '.gitattributes', SHIPPED_GITATTRIBUTES);
    failAfterCheckout();
    const before = surroundings();

    await restore({ root: second, log, remote }).catch(() => undefined);

    expect(surroundings()).toEqual(before);
  });

  it('removes a directory left at its staging place by an earlier restore', async () => {
    write(second, '.git/records-restore/leftover', 'from a restore that died\n');

    await restore({ root: second, log, remote });

    expect(existsSync(path.join(second, '.git', 'records-restore'))).toBe(false);
  });

  it('restores over a directory left at its staging place by an earlier restore', async () => {
    write(second, '.git/records-restore/leftover', 'from a restore that died\n');

    await restore({ root: second, log, remote });

    expect(read(second, 'docs/runs/run-a/plan.md')).toBe(RECORDS['docs/runs/run-a/plan.md']);
  });

  it('refuses a checkout holding an empty folder where the remote holds a file', async () => {
    mkdirSync(path.join(second, 'docs', 'history', 'OLD-PLAN.md'), { recursive: true });

    await expect(restore({ root: second, log, remote })).rejects.toThrow(
      /^records: restore refused: docs\/history\/OLD-PLAN\.md /u
    );
  });

  it('leaves an empty folder where the remote holds a file as it was', async () => {
    mkdirSync(path.join(second, 'docs', 'history', 'OLD-PLAN.md'), { recursive: true });
    const before = surroundings();

    await restore({ root: second, log, remote }).catch(() => undefined);

    expect(surroundings()).toEqual(before);
  });

  /** Puts a `git` first on the path that writes `file` into the checkout as the checkout starts. */
  function writeDuringCheckout(file: string, content: string): void {
    const realGit = (process.env['PATH'] ?? '')
      .split(path.delimiter)
      .map((directory) => path.join(directory, 'git'))
      .find((candidate) => existsSync(candidate));
    const target = path.join(second, ...file.split('/'));
    const wrapper = path.join(sandbox, 'wrapper');
    write(
      wrapper,
      'git',
      [
        '#!/bin/sh',
        'for argument in "$@"; do',
        '  if [ "$argument" = checkout ]; then',
        `    mkdir -p '${path.dirname(target)}'`,
        `    printf '${content}' > '${target}'`,
        '  fi',
        'done',
        `exec '${realGit ?? 'git'}' "$@"`,
        '',
      ].join('\n')
    );
    chmodSync(path.join(wrapper, 'git'), 0o755);
    vi.stubEnv('PATH', `${wrapper}${path.delimiter}${process.env['PATH'] ?? ''}`);
  }

  it('keeps a file written at a remote path after its check and before the checkout', async () => {
    writeDuringCheckout('docs/runs/run-a/plan.md', 'written during the restore\n');

    await restore({ root: second, log, remote }).catch(() => undefined);

    expect(read(second, 'docs/runs/run-a/plan.md')).toBe('written during the restore\n');
  });

  it('names the record-file scan when the checkout has no .gitignore', async () => {
    rmSync(path.join(second, '.gitignore'));

    await expect(restore({ root: second, log, remote })).rejects.toThrow(
      /^records: scan the record files failed: /u
    );
  });

  it('names the record-file scan when the .gitignore has no records block', async () => {
    write(second, '.gitignore', 'node_modules/\n');

    await expect(restore({ root: second, log, remote })).rejects.toThrow(
      /^records: scan the record files failed: /u
    );
  });

  it('names the record-file scan when it cannot make its scratch directory', async () => {
    vi.stubEnv('TMPDIR', path.join(sandbox, 'absent'));

    await expect(restore({ root: second, log, remote })).rejects.toThrow(
      /^records: scan the record files failed: /u
    );
  });

  it('names the clone step when the remote cannot be read', async () => {
    await expect(
      restore({ root: second, log, remote: path.join(sandbox, 'absent.git') })
    ).rejects.toThrow(/^records: clone failed/u);
  });

  it('names the clone step when the remote asks for credentials', async () => {
    await expect(
      restore({ root: second, log, remote: await remoteAskingForCredentials() })
    ).rejects.toThrow(/^records: clone failed: .*terminal prompts disabled/su);
  });

  it('leaves the main repository untouched', async () => {
    await expectMainUntouched(second, () => restore({ root: second, log, remote }));
  });
});
