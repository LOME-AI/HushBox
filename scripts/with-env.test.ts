import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import path from 'node:path';

vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('execa', () => ({ execa: vi.fn() }));

import { config as dotenvConfig } from 'dotenv';
import { execa } from 'execa';
import { createEnvUtilities, type EnvMode } from '@hushbox/shared';
import { RUN_CLAIM_ENV } from './lib/claims/registry.js';
import { closeProcessLifeline } from './lib/spawn/long-lived.js';
import {
  applyDatabaseOverride,
  envFilesFor,
  ENV_MODE_FLAG,
  NODE_OPTION_FLAG,
  ENV_MODE_VARIABLE,
  appendNodeOption,
  loadEnvironment,
  parseEnvModeSelection,
  runCommand,
  stackModeFrom,
} from './with-env.js';

const mockDotenvConfig = vi.mocked(dotenvConfig);
const mockExeca = vi.mocked(execa);

const repoRoot = path.join(path.sep, 'repo');

/**
 * The socket this worker answers its children on goes when the file that made
 * it is done, rather than staying until the runner signals the worker — which
 * reaches no handler and would leave the file behind.
 */
afterAll(async () => {
  await closeProcessLifeline();
});

describe('with-env', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    // A test process inherits its pnpm invocation's run claim, and this file
    // spawns through the real spawner over a mocked execa: without this the
    // fixture's stand-in pid is recorded against the machine-wide claim of the
    // run executing these tests, where a reclaimer would later signal it.
    vi.stubEnv(RUN_CLAIM_ENV, '');
  });

  describe('ENV_MODE_VARIABLE', () => {
    it('names the variable the generator writes the stack into', () => {
      expect(ENV_MODE_VARIABLE).toBe('HB_ENV_MODE');
    });
  });

  describe('stackModeFrom', () => {
    it('falls back to the development stack when the variable is unset', () => {
      expect(stackModeFrom({})).toBe('development');
    });

    it('falls back to the development stack when the variable is empty', () => {
      expect(stackModeFrom({ [ENV_MODE_VARIABLE]: '' })).toBe('development');
    });

    it('returns the e2e stack when the variable names it', () => {
      expect(stackModeFrom({ [ENV_MODE_VARIABLE]: 'e2e' })).toBe('e2e');
    });

    it('fails fast naming the variable when the value names no mode', () => {
      expect(() => stackModeFrom({ [ENV_MODE_VARIABLE]: 'staging' })).toThrow(
        'with-env: HB_ENV_MODE="staging" names no mode. Valid: development, test, ciVitest, e2e, ciE2E, production.'
      );
    });
  });

  describe('envFilesFor', () => {
    it('loads the unsuffixed triple for the development stack, backend first', () => {
      expect(envFilesFor('development')).toEqual([
        path.join('apps', 'api', '.dev.vars'),
        '.env.development',
        '.env.scripts',
      ]);
    });

    it('loads the e2e triple for the e2e stack', () => {
      expect(envFilesFor('e2e')).toEqual([
        path.join('apps', 'api', '.dev.vars.e2e'),
        '.env.e2e',
        '.env.scripts.e2e',
      ]);
    });
  });

  describe('ENV_MODE_FLAG', () => {
    it('spells the flag the way ensure-stack already spells it', () => {
      expect(ENV_MODE_FLAG).toBe('--env-mode');
    });
  });

  describe('parseEnvModeSelection', () => {
    it('names no mode and keeps every argument when the flag is absent', () => {
      expect(parseEnvModeSelection(['tsx', 'scripts/e2e-run.ts'])).toEqual({
        envMode: undefined,
        rest: ['tsx', 'scripts/e2e-run.ts'],
      });
    });

    it('selects the e2e mode and drops the flag pair when it leads', () => {
      expect(parseEnvModeSelection(['--env-mode', 'e2e', 'tsx', 'scripts/e2e-run.ts'])).toEqual({
        envMode: 'e2e',
        rest: ['tsx', 'scripts/e2e-run.ts'],
      });
    });

    it('keeps a CI mode as itself rather than the stack it stands in for', () => {
      expect(parseEnvModeSelection(['--env-mode', 'ciE2E', 'turbo', 'build']).envMode).toBe(
        'ciE2E'
      );
    });

    it('keeps the mode that runs no stack, which no stack could spell', () => {
      expect(parseEnvModeSelection(['--env-mode', 'production', 'turbo', 'build']).envMode).toBe(
        'production'
      );
    });

    it('leaves a flag of the same name to the child command', () => {
      expect(parseEnvModeSelection(['tsx', 'seed.ts', '--env-mode', 'e2e'])).toEqual({
        envMode: undefined,
        rest: ['tsx', 'seed.ts', '--env-mode', 'e2e'],
      });
    });

    it('fails fast naming the flag when the value names no mode', () => {
      expect(() => parseEnvModeSelection(['--env-mode', 'staging', 'turbo', 'dev'])).toThrow(
        'with-env: --env-mode="staging" names no mode. Valid: development, test, ciVitest, e2e, ciE2E, production.'
      );
    });

    it('fails fast naming the flag when no value follows it', () => {
      expect(() => parseEnvModeSelection(['--env-mode'])).toThrow(
        'with-env: --env-mode needs a mode. Valid: development, test, ciVitest, e2e, ciE2E, production.'
      );
    });
  });

  describe('NODE_OPTION_FLAG', () => {
    it('disables Node 25 experimental webstorage to keep jsdom Storage globals', () => {
      expect(NODE_OPTION_FLAG).toBe('--no-experimental-webstorage');
    });
  });

  describe('loadEnvironment', () => {
    /**
     * Makes the mocked file loader behave like one generated file set: the
     * scripts file declares the mode the generation ran under, as
     * `generate-env` writes it, and the backend file carries `values`.
     *
     * Nothing reaches the environment until the loader is called, which is what
     * lets these tests tell a clearing that ran after the load from one that ran
     * before it — the files are mocked, so an ambient stub alone could not.
     */
    function filesGeneratedUnder(
      generatingMode: EnvMode,
      values: Record<string, string> = {}
    ): void {
      mockDotenvConfig.mockImplementation((options) => {
        const file = String(options?.path ?? '');
        if (file.includes('.env.scripts')) {
          vi.stubEnv(ENV_MODE_VARIABLE, generatingMode);
        } else if (file.includes('.dev.vars')) {
          for (const [name, value] of Object.entries(values)) vi.stubEnv(name, value);
        }
        return {};
      });
    }

    beforeEach(() => {
      // Every generated set declares its mode, and the loader refuses one that
      // does not; the tests that care which mode name it themselves.
      filesGeneratedUnder('development');
    });

    it('calls dotenv for each env file with override and resolved root paths', () => {
      loadEnvironment(repoRoot, 'development');
      expect(mockDotenvConfig).toHaveBeenCalledTimes(3);
      expect(mockDotenvConfig).toHaveBeenNthCalledWith(1, {
        path: path.join(repoRoot, 'apps', 'api', '.dev.vars'),
        override: true,
        quiet: true,
      });
      expect(mockDotenvConfig).toHaveBeenNthCalledWith(2, {
        path: path.join(repoRoot, '.env.development'),
        override: true,
        quiet: true,
      });
      expect(mockDotenvConfig).toHaveBeenNthCalledWith(3, {
        path: path.join(repoRoot, '.env.scripts'),
        override: true,
        quiet: true,
      });
    });

    it('loads the e2e triple when asked for the e2e stack', () => {
      filesGeneratedUnder('e2e');
      loadEnvironment(repoRoot, 'e2e');
      expect(mockDotenvConfig.mock.calls.map(([options]) => options?.path)).toEqual([
        path.join(repoRoot, 'apps', 'api', '.dev.vars.e2e'),
        path.join(repoRoot, '.env.e2e'),
        path.join(repoRoot, '.env.scripts.e2e'),
      ]);
    });

    it('resolves the stack from the environment when the caller names none', () => {
      filesGeneratedUnder('e2e');
      vi.stubEnv(ENV_MODE_VARIABLE, 'e2e');
      loadEnvironment(repoRoot);
      expect(mockDotenvConfig.mock.calls.map(([options]) => options?.path)).toEqual([
        path.join(repoRoot, 'apps', 'api', '.dev.vars.e2e'),
        path.join(repoRoot, '.env.e2e'),
        path.join(repoRoot, '.env.scripts.e2e'),
      ]);
    });

    it('loads the default stack triple when nothing names a mode', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- vi.stubEnv requires a value; undefined unsets the var
      vi.stubEnv(ENV_MODE_VARIABLE, undefined);
      loadEnvironment(repoRoot);
      expect(mockDotenvConfig.mock.calls.map(([options]) => options?.path)).toEqual([
        path.join(repoRoot, 'apps', 'api', '.dev.vars'),
        path.join(repoRoot, '.env.development'),
        path.join(repoRoot, '.env.scripts'),
      ]);
    });

    it('loads the triple of the stack a runner mode stands in for', () => {
      filesGeneratedUnder('ciE2E');
      loadEnvironment(repoRoot, 'ciE2E');
      expect(mockDotenvConfig.mock.calls.map(([options]) => options?.path)).toEqual([
        path.join(repoRoot, 'apps', 'api', '.dev.vars.e2e'),
        path.join(repoRoot, '.env.e2e'),
        path.join(repoRoot, '.env.scripts.e2e'),
      ]);
    });

    it('keeps the CI a runner generation stated, though the suite loads its stack by another name', () => {
      filesGeneratedUnder('ciVitest', { NODE_ENV: 'development', CI: 'true' });
      loadEnvironment(repoRoot, 'test');
      expect(process.env['CI']).toBe('true');
      expect(createEnvUtilities(process.env).isCI).toBe(true);
    });

    it('keeps both flags a runner end-to-end generation stated, loaded by the local name', () => {
      filesGeneratedUnder('ciE2E', { NODE_ENV: 'development', CI: 'true', E2E: 'true' });
      loadEnvironment(repoRoot, 'e2e');
      expect(process.env['CI']).toBe('true');
      expect(process.env['E2E']).toBe('true');
      const utilities = createEnvUtilities(process.env);
      expect(utilities.isCI).toBe(true);
      expect(utilities.isE2E).toBe(true);
    });

    it('refuses a loaded file set that declares no mode, rather than falling back to the flag', () => {
      mockDotenvConfig.mockImplementation(() => ({}));
      // eslint-disable-next-line unicorn/no-useless-undefined -- vi.stubEnv requires a value; undefined unsets the var
      vi.stubEnv(ENV_MODE_VARIABLE, undefined);
      expect(() => {
        loadEnvironment(repoRoot, 'test');
      }).toThrow(ENV_MODE_VARIABLE);
    });

    it('clears a classification variable the generating mode states nothing about', () => {
      filesGeneratedUnder('test');
      vi.stubEnv('CI', 'true');
      loadEnvironment(repoRoot, 'test');
      expect(process.env['CI']).toBeUndefined();
    });

    it('clears a line the loaded files themselves carry, so it runs after the load', () => {
      filesGeneratedUnder('test', { CI: 'true' });
      loadEnvironment(repoRoot, 'test');
      expect(process.env['CI']).toBeUndefined();
    });

    it('leaves a classification variable the generating mode states exactly as loaded', () => {
      filesGeneratedUnder('ciVitest');
      vi.stubEnv('CI', 'true');
      loadEnvironment(repoRoot, 'ciVitest');
      expect(process.env['CI']).toBe('true');
    });

    it('clears every classification variable the mode states nothing about, not only the first', () => {
      filesGeneratedUnder('test');
      vi.stubEnv('E2E', 'true');
      loadEnvironment(repoRoot, 'test');
      expect(process.env['E2E']).toBeUndefined();
    });

    it('leaves the end-to-end flag alone under the mode that states it', () => {
      filesGeneratedUnder('e2e');
      vi.stubEnv('E2E', 'true');
      loadEnvironment(repoRoot, 'e2e');
      expect(process.env['E2E']).toBe('true');
    });

    it('classifies a runner as local under a mode that states no CI', () => {
      filesGeneratedUnder('test');
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('CI', 'true');
      loadEnvironment(repoRoot, 'test');
      const utilities = createEnvUtilities(process.env);
      expect(utilities.isCI).toBe(false);
      expect(utilities.isLocalDev).toBe(true);
      expect(utilities.requiresRealServices).toBe(false);
    });

    it('classifies the same runner as CI under the mode that states it', () => {
      filesGeneratedUnder('ciVitest');
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('CI', 'true');
      loadEnvironment(repoRoot, 'ciVitest');
      const utilities = createEnvUtilities(process.env);
      expect(utilities.isCI).toBe(true);
      expect(utilities.isLocalDev).toBe(false);
      expect(utilities.requiresRealServices).toBe(true);
    });

    it('leaves a credential a workflow step injected where the mode states none', () => {
      filesGeneratedUnder('test');
      vi.stubEnv('RESEND_API_KEY', 'injected-by-the-workflow');
      loadEnvironment(repoRoot, 'test');
      expect(process.env['RESEND_API_KEY']).toBe('injected-by-the-workflow');
    });

    it('loads no file at all for a mode that runs no stack', () => {
      loadEnvironment(repoRoot, 'production');
      expect(mockDotenvConfig).not.toHaveBeenCalled();
    });

    it('leaves the machine own CI alone under a mode that runs no stack', () => {
      vi.stubEnv('CI', 'true');
      loadEnvironment(repoRoot, 'production');
      expect(process.env['CI']).toBe('true');
    });

    it('loads no file when the environment itself names that mode', () => {
      vi.stubEnv(ENV_MODE_VARIABLE, 'production');
      loadEnvironment(repoRoot);
      expect(mockDotenvConfig).not.toHaveBeenCalled();
    });
  });

  describe('appendNodeOption', () => {
    it('returns the flag alone when existing is undefined', () => {
      expect(appendNodeOption(undefined, '--foo')).toBe('--foo');
    });

    it('returns the flag alone when existing is empty', () => {
      expect(appendNodeOption('', '--foo')).toBe('--foo');
    });

    it('appends with a single space when existing is non-empty', () => {
      expect(appendNodeOption('--bar', '--foo')).toBe('--bar --foo');
    });

    it('preserves multi-flag existing values', () => {
      expect(appendNodeOption('--bar --baz', '--foo')).toBe('--bar --baz --foo');
    });
  });

  describe('runCommand', () => {
    /**
     * What `spawnLongLived` reads off a subprocess: a pid, and — under the
     * runtime process the library wraps, which is the only place the library
     * carries it — the status it already holds and the exit it announces. A
     * child that has not ended carries neither a code nor a signal, and the
     * exit is an event rather than the resolution of the subprocess itself,
     * because that resolution is an answer about the streams as much as about
     * the process.
     */
    function fakeChild(exitCode?: number): ReturnType<typeof execa> {
      return Object.assign(Promise.resolve({ exitCode }), {
        pid: 4321,
        stdio: [null, null, null],
        nodeChildProcess: {
          exitCode: null,
          signalCode: null,
          on: (event: string, handler: (code: number | null) => void): void => {
            if (event !== 'exit') return;
            setImmediate(() => {
              handler(exitCode ?? null);
            });
          },
        },
      }) as unknown as ReturnType<typeof execa>;
    }

    it('spawns the command in its own process group, inheriting stdio', async () => {
      mockExeca.mockReturnValue(fakeChild(0));

      const exitCode = await runCommand('pnpm', ['build'], []);

      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['build'],
        expect.objectContaining({
          stdio: ['inherit', 'inherit', 'inherit'],
          detached: true,
          reject: false,
        })
      );
      expect(exitCode).toBe(0);
    });

    it('propagates a non-zero exit code from the child', async () => {
      mockExeca.mockReturnValue(fakeChild(42));
      await expect(runCommand('pnpm', ['test'], [])).resolves.toBe(42);
    });

    it('returns 1 when the child exits with no numeric exit code', async () => {
      mockExeca.mockReturnValue(fakeChild());
      await expect(runCommand('pnpm', ['test'], [])).resolves.toBe(1);
    });

    it('throws a clear error when no command is provided', async () => {
      await expect(runCommand(undefined, [], [])).rejects.toThrow(
        'with-env: missing command. Usage: tsx scripts/with-env.ts <command> [...args]'
      );
    });
  });
});

describe('applyDatabaseOverride', () => {
  it('retargets every postgres URL at the requested database', () => {
    const env: NodeJS.ProcessEnv = {
      HB_TEST_DB: 'hb_tpl',
      DATABASE_URL: 'postgres://postgres:postgres@localhost:4444/hushbox',
      MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/hushbox',
    };

    applyDatabaseOverride(env);

    expect(env['DATABASE_URL']).toBe('postgres://postgres:postgres@localhost:4444/hb_tpl');
    expect(env['MIGRATION_DATABASE_URL']).toBe(
      'postgresql://postgres:postgres@localhost:5432/hb_tpl'
    );
  });

  it('leaves the environment untouched when no override is requested', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: 'postgres://postgres:postgres@localhost:4444/hushbox',
    };

    applyDatabaseOverride(env);

    expect(env['DATABASE_URL']).toBe('postgres://postgres:postgres@localhost:4444/hushbox');
  });
});
