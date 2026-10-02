import { describe, it, expect, vi } from 'vitest';
import { CHECKOUT_DIRECTORY } from '../../compose.js';
import {
  createDockerPostgresAuthDeps,
  type ComposeCommandResult,
  type ComposeRunner,
} from './postgres-auth-method-docker.js';

const ROLE = 'hushbox_app';
const HBA_FILE = '/pgdata/pg_hba.conf';

function ok(stdout: string): ComposeCommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

/**
 * Answers each command by what it asks for, so a test drives the pair the way
 * the repair does rather than by call index.
 */
function runner(
  answers: { rules?: string; hbaFile?: string } = {}
): ReturnType<typeof vi.fn<ComposeRunner>> {
  return vi.fn<ComposeRunner>((args) => {
    const last = args.at(-1) ?? '';
    if (last.includes('pg_hba_file_rules')) return Promise.resolve(ok(answers.rules ?? ''));
    if (last.includes('hba_file')) return Promise.resolve(ok(answers.hbaFile ?? HBA_FILE));
    return Promise.resolve(ok(''));
  });
}

function deps(
  run: ComposeRunner,
  report: (message: string) => void = vi.fn()
): ReturnType<typeof createDockerPostgresAuthDeps> {
  return createDockerPostgresAuthDeps(run, { role: ROLE, report });
}

describe('createDockerPostgresAuthDeps — reading the rules', () => {
  it('parses a line number and method out of each row', async () => {
    const run = runner({ rules: '119|trust\n128|scram-sha-256\n' });

    await expect(deps(run).readHostRules()).resolves.toEqual([
      { lineNumber: 119, authMethod: 'trust' },
      { lineNumber: 128, authMethod: 'scram-sha-256' },
    ]);
  });

  it('reports a rule the view gave no method for as having none', async () => {
    const run = runner({ rules: '12|\n' });

    await expect(deps(run).readHostRules()).resolves.toEqual([{ lineNumber: 12, authMethod: '' }]);
  });

  it('reads every host-family rule in one command against the running service', async () => {
    const run = runner({ rules: '128|password\n' });

    await deps(run).readHostRules();

    expect(run).toHaveBeenCalledTimes(1);
    const args = run.mock.calls[0]![0];
    expect(args.slice(0, 6)).toEqual([
      'compose',
      '--project-directory',
      CHECKOUT_DIRECTORY,
      'exec',
      '-T',
      'postgres',
    ]);
    expect(args).toContain('psql');
    expect(args).toContain(ROLE);
    expect(args.at(-1)).toContain("type LIKE 'host%'");
  });

  it('fails loud with the exit code and stderr when the read command fails', async () => {
    const run: ComposeRunner = vi.fn(() =>
      Promise.resolve({ exitCode: 2, stdout: '', stderr: 'no such container' })
    );

    await expect(deps(run).readHostRules()).rejects.toThrow('no such container');
  });

  it('refuses a row it cannot read a line number out of', async () => {
    const run = runner({ rules: 'not-a-row\n' });

    await expect(deps(run).readHostRules()).rejects.toThrow('not-a-row');
  });
});

describe('createDockerPostgresAuthDeps — rewriting the rules', () => {
  const BLOCKING = [{ lineNumber: 128, authMethod: 'scram-sha-256' }];

  it('replaces the method on the named line of the file the server names', async () => {
    const run = runner();

    await deps(run).acceptPasswordOn(BLOCKING);

    const script = run.mock.calls
      .map((call) => call[0].at(-1) ?? '')
      .find((last) => last.includes('sed'));
    expect(script).toContain(`128s/scram-sha-256/password/`);
    expect(script).toContain(HBA_FILE);
  });

  it('reloads the server after the rewrite, in that order', async () => {
    const run = runner();

    await deps(run).acceptPasswordOn(BLOCKING);

    const lasts = run.mock.calls.map((call) => call[0].at(-1) ?? '');
    const rewrote = lasts.findIndex((last) => last.includes('sed'));
    const reloaded = lasts.findIndex((last) => last.includes('pg_reload_conf'));
    expect(rewrote).toBeGreaterThanOrEqual(0);
    expect(reloaded).toBeGreaterThan(rewrote);
  });

  it('rewrites every blocking line in one pass', async () => {
    const run = runner();

    await deps(run).acceptPasswordOn([
      { lineNumber: 12, authMethod: 'md5' },
      { lineNumber: 128, authMethod: 'scram-sha-256' },
    ]);

    const script = run.mock.calls
      .map((call) => call[0].at(-1) ?? '')
      .find((last) => last.includes('sed'));
    expect(script).toContain('12s/md5/password/');
    expect(script).toContain('128s/scram-sha-256/password/');
  });

  it('asks docker for nothing but an exec into the running postgres service', async () => {
    const run = runner();

    await deps(run).acceptPasswordOn(BLOCKING);

    expect(run.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of run.mock.calls) {
      expect(args.slice(0, 6)).toEqual([
        'compose',
        '--project-directory',
        CHECKOUT_DIRECTORY,
        'exec',
        '-T',
        'postgres',
      ]);
    }
  });

  it('writes through the existing file rather than replacing it', async () => {
    const run = runner();

    await deps(run).acceptPasswordOn(BLOCKING);

    const script = run.mock.calls
      .map((call) => call[0].at(-1) ?? '')
      .find((last) => last.includes('sed'));
    expect(script).toContain(`cat `);
    expect(script).not.toContain('mv ');
  });

  it('fails loud when the rewrite command fails', async () => {
    const run = vi.fn<ComposeRunner>((args) => {
      const last = args.at(-1) ?? '';
      if (last.includes('hba_file')) return Promise.resolve(ok(HBA_FILE));
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'sed: permission denied' });
    });

    await expect(deps(run).acceptPasswordOn(BLOCKING)).rejects.toThrow('sed: permission denied');
  });

  it('refuses a method it cannot put in a substitution unedited', async () => {
    const run = runner();

    await expect(
      deps(run).acceptPasswordOn([{ lineNumber: 1, authMethod: 'ldap/x' }])
    ).rejects.toThrow('ldap/x');
  });

  it('refuses a configuration path it cannot quote', async () => {
    const run = runner({ hbaFile: "/pgdata/it's.conf" });

    await expect(deps(run).acceptPasswordOn(BLOCKING)).rejects.toThrow("it's.conf");
  });

  it('refuses when the server names no configuration file', async () => {
    const run = runner({ hbaFile: '' });

    await expect(deps(run).acceptPasswordOn(BLOCKING)).rejects.toThrow('names no');
  });
});

describe('createDockerPostgresAuthDeps — narration', () => {
  it('carries the report through to the caller that supplied it', () => {
    const report = vi.fn();

    deps(runner(), report).report('something happened');

    expect(report).toHaveBeenCalledWith('something happened');
  });
});
