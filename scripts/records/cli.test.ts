import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRepositories } from '../configure-git-clone.js';
import { COMMAND_LINE, SUBCOMMAND_LINES, main, recordsRemote } from './cli.js';
import { git, overlayDirectory, overlayGit } from './overlay.js';

const SHIPPED_GITIGNORE = readFileSync(
  path.join(import.meta.dirname, '..', '..', '.gitignore'),
  'utf8'
);

let sandbox: string;
let checkout: string;
let remote: string;
let printed: string[];

const log = (line: string): void => {
  printed.push(line);
};

function write(root: string, relative: string, content = `${relative}\n`): void {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

async function createCheckout(name: string): Promise<string> {
  const root = path.join(sandbox, name);
  mkdirSync(root);
  await git(root, ['init', '--quiet', '--initial-branch=main']);
  write(root, '.gitignore', SHIPPED_GITIGNORE);
  await git(root, ['add', '.gitignore']);
  await git(root, ['commit', '--quiet', '--message', 'base']);
  return root;
}

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'records-cli-'));
  writeFileSync(
    path.join(sandbox, 'gitconfig'),
    '[user]\n\tname = Records Test\n\temail = records-test@hushbox.ai\n'
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(sandbox, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  printed = [];
  remote = path.join(sandbox, 'remote.git');
  await git(sandbox, ['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  checkout = await createCheckout('checkout');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('recordsRemote', () => {
  it('is the GitHub https URL of the records repository', () => {
    expect(
      recordsRemote({
        publicRepo: 'Example-Org/Example',
        stagingRepo: 'Example-Org/Example-staging',
        recordsRepo: 'Example-Org/Example-records',
      })
    ).toBe('https://github.com/Example-Org/Example-records.git');
  });
});

describe('main', () => {
  it('prints the usage when asked', async () => {
    await main(['--help'], log, checkout);

    expect(printed.join('\n')).toContain(COMMAND_LINE.command);
  });

  it('prints a subcommand usage when asked', async () => {
    await main(['save', '--help'], log, checkout);

    expect(printed.join('\n')).toContain(SUBCOMMAND_LINES['save']?.command);
  });

  it('refuses a line with no command', async () => {
    await expect(main([], log, checkout)).rejects.toThrow(/Missing command/u);
  });

  it('refuses a command it does not know', async () => {
    await expect(main(['frob'], log, checkout)).rejects.toThrow(/Unknown command: frob/u);
  });

  it('refuses a flag a subcommand does not take', async () => {
    await expect(main(['save', '--remote', remote], log, checkout)).rejects.toThrow(/--remote/u);
  });

  it('creates the overlay at the top level when run from a subdirectory', async () => {
    const subdirectory = path.join(checkout, 'docs');
    mkdirSync(subdirectory);

    await main(['init', '--remote', remote], log, subdirectory);

    expect(existsSync(overlayDirectory(checkout))).toBe(true);
  });

  it('saves through the overlay', async () => {
    await main(['init', '--remote', remote], log, checkout);
    write(checkout, 'docs/runs/run-a/plan.md');

    await main(['save'], log, checkout);

    expect(await overlayGit(checkout, ['ls-files'])).toBe('docs/runs/run-a/plan.md');
  });

  it('reports through the overlay', async () => {
    await main(['init', '--remote', remote], log, checkout);
    write(checkout, 'docs/runs/run-a/plan.md');
    printed = [];

    await main(['status'], log, checkout);

    expect(printed).toEqual([
      'added docs/runs/run-a/plan.md',
      'records: main is not ahead of origin/main',
    ]);
  });

  it('restores from the remote it is given', async () => {
    write(checkout, 'docs/runs/run-a/plan.md');
    await main(['init', '--remote', remote], log, checkout);
    const second = await createCheckout('second');

    await main(['restore', '--remote', remote], log, second);

    expect(readFileSync(path.join(second, 'docs', 'runs', 'run-a', 'plan.md'), 'utf8')).toBe(
      'docs/runs/run-a/plan.md\n'
    );
  });

  it('names the records repository as origin when no remote is given', async () => {
    await main(['init'], log, checkout);

    expect(await overlayGit(checkout, ['remote', 'get-url', 'origin'])).toBe(
      recordsRemote(await readRepositories())
    );
  });

  it('refuses a restore with no remote given before it reaches the records repository', async () => {
    await main(['init', '--remote', remote], log, checkout);

    await expect(main(['restore'], log, checkout)).rejects.toThrow(/already exists/u);
  });
});
