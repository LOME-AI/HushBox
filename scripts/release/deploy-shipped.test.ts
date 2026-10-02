import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { main } from './deploy-shipped.js';
import { claimRef } from '../lib/release-references.js';

let sandbox: string;
let fixtureCount = 0;
let outputFile: string;
let stdoutSpy: MockInstance;

async function run(directory: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execa('git', [...args], { cwd: directory });
  return stdout.trim();
}

async function cloneOf(remote: string): Promise<string> {
  fixtureCount += 1;
  const clone = path.join(sandbox, `clone-${String(fixtureCount)}`);
  await run(sandbox, ['clone', '-q', remote, clone]);
  await run(clone, ['config', 'user.name', 'Test Person']);
  await run(clone, ['config', 'user.email', 'test@example.invalid']);
  return clone;
}

/** Commits a change and answers the new commit. */
async function commit(clone: string, message: string): Promise<string> {
  await fs.writeFile(path.join(clone, 'change.txt'), message);
  await run(clone, ['add', '.']);
  await run(clone, ['commit', '-q', '-m', message]);
  return run(clone, ['rev-parse', 'HEAD']);
}

/** A bare remote and one working clone of it, carrying one commit on `main`. */
async function initRemote(): Promise<{ remote: string; clone: string; first: string }> {
  fixtureCount += 1;
  const remote = path.join(sandbox, `remote-${String(fixtureCount)}.git`);
  await run(sandbox, ['init', '-q', '--bare', '-b', 'main', remote]);
  const clone = await cloneOf(remote);
  const first = await commit(clone, 'first');
  await run(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  return { remote, clone, first };
}

/** Tags `commitId` on the remote alone, so only a fetch can bring the tag into `clone`. */
async function tagOnRemote(remote: string, commitId: string, tag: string): Promise<void> {
  const other = await cloneOf(remote);
  await run(other, ['tag', tag, commitId]);
  await run(other, ['push', '-q', 'origin', `refs/tags/${tag}`]);
}

/** Pushes `clone`'s HEAD to the remote's `main`, so another clone can reach the commit. */
async function publish(clone: string): Promise<void> {
  await run(clone, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
}

function deploying(event: string, sha: string): void {
  vi.stubEnv('GITHUB_EVENT_NAME', event);
  vi.stubEnv('GITHUB_SHA', sha);
  vi.stubEnv('GITHUB_OUTPUT', outputFile);
}

async function writtenOutput(): Promise<string> {
  return fs.readFile(outputFile, 'utf8');
}

function printed(): string {
  return stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'deploy-shipped-'));
  const globalConfig = path.join(sandbox, 'gitconfig');
  await fs.writeFile(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  outputFile = path.join(sandbox, 'github-output');
  await fs.writeFile(outputFile, '');
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('main on a push', () => {
  it('answers shipped when a release tag sits on the commit', async () => {
    const { remote, clone, first } = await initRemote();
    await tagOnRemote(remote, first, 'v1.0.0');
    deploying('push', first);

    await main({ repositoryRoot: clone });

    expect(await writtenOutput()).toBe('shipped=true\n');
  });

  it('answers shipped when a release tag sits on a descendant of the commit', async () => {
    const { remote, clone, first } = await initRemote();
    const descendant = await commit(clone, 'second');
    await publish(clone);
    await tagOnRemote(remote, descendant, 'v1.0.0');
    deploying('push', first);

    await main({ repositoryRoot: clone });

    expect(await writtenOutput()).toBe('shipped=true\n');
  });

  it('names the release tag it found', async () => {
    const { remote, clone, first } = await initRemote();
    await tagOnRemote(remote, first, 'v1.4.2');
    deploying('push', first);

    await main({ repositoryRoot: clone });

    expect(printed()).toContain('v1.4.2');
  });

  it('answers not shipped when a release tag sits only on an ancestor of the commit', async () => {
    const { remote, clone, first } = await initRemote();
    await tagOnRemote(remote, first, 'v1.0.0');
    const head = await commit(clone, 'second');
    deploying('push', head);

    await main({ repositoryRoot: clone });

    expect(await writtenOutput()).toBe('shipped=false\n');
  });

  it('answers not shipped when only a claim sits on the commit', async () => {
    const { clone, first } = await initRemote();
    await run(clone, ['push', '-q', 'origin', `${first}:${claimRef('1.0.0')}`]);
    await run(clone, ['update-ref', claimRef('1.0.0'), first]);
    deploying('push', first);

    await main({ repositoryRoot: clone });

    expect(await writtenOutput()).toBe('shipped=false\n');
  });

  it('answers not shipped when no tag at all reaches the commit', async () => {
    const { clone, first } = await initRemote();
    deploying('push', first);

    await main({ repositoryRoot: clone });

    expect(await writtenOutput()).toBe('shipped=false\n');
  });

  it('fails without writing an answer when origin cannot be read', async () => {
    const { clone, first } = await initRemote();
    await run(clone, ['remote', 'set-url', 'origin', path.join(sandbox, 'absent.git')]);
    deploying('push', first);

    await expect(main({ repositoryRoot: clone })).rejects.toThrow('git fetch failed');
    expect(await writtenOutput()).toBe('');
  });
});

describe('main on a dispatch', () => {
  it('answers not shipped even when a release tag sits on the commit', async () => {
    const { remote, clone, first } = await initRemote();
    await tagOnRemote(remote, first, 'v1.0.0');
    deploying('workflow_dispatch', first);

    await main({ repositoryRoot: clone });

    expect(await writtenOutput()).toBe('shipped=false\n');
  });

  it('says that a dispatch always deploys', async () => {
    const { clone, first } = await initRemote();
    deploying('workflow_dispatch', first);

    await main({ repositoryRoot: clone });

    expect(printed()).toContain('dispatch always deploys');
  });
});

describe('main on any other event', () => {
  it('refuses an event it was not written to judge, naming it', async () => {
    const { clone, first } = await initRemote();
    deploying('pull_request', first);

    await expect(main({ repositoryRoot: clone })).rejects.toThrow('pull_request');
  });
});

describe('main without its variables', () => {
  it.each(['GITHUB_EVENT_NAME', 'GITHUB_SHA', 'GITHUB_OUTPUT'])(
    'refuses, naming %s, when it is empty',
    async (variable) => {
      const { clone, first } = await initRemote();
      deploying('push', first);
      vi.stubEnv(variable, '');

      await expect(main({ repositoryRoot: clone })).rejects.toThrow(variable);
    }
  );

  it.each(['GITHUB_EVENT_NAME', 'GITHUB_SHA', 'GITHUB_OUTPUT'])(
    'refuses, naming %s, when it is unset',
    async (variable) => {
      const { clone, first } = await initRemote();
      deploying('push', first);
      // The stub recorded the variable's original value, so unstubbing restores it.
      Reflect.deleteProperty(process.env, variable);

      await expect(main({ repositoryRoot: clone })).rejects.toThrow(variable);
    }
  );
});

describe('the command', () => {
  const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'deploy-shipped.ts');
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

  it('exits 1, naming the variable, when one it reads is unset', async () => {
    const { clone, first } = await initRemote();
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      GITHUB_SHA: first,
      GITHUB_OUTPUT: outputFile,
    };

    const result = await execa(process.execPath, ['--import', tsxLoader, entry], {
      cwd: clone,
      env,
      extendEnv: false,
      all: true,
      reject: false,
    });

    expect({
      exitCode: result.exitCode,
      namesVariable: result.all.includes('GITHUB_EVENT_NAME'),
    }).toEqual({ exitCode: 1, namesVariable: true });
  });
});
