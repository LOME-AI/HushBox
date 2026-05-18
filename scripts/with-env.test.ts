import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

vi.mock('dotenv', () => ({ config: vi.fn() }));
vi.mock('execa', () => ({ execa: vi.fn() }));

import { config as dotenvConfig } from 'dotenv';
import { execa } from 'execa';
import {
  ENV_FILES,
  NODE_OPTION_FLAG,
  appendNodeOption,
  loadEnvironment,
  runCommand,
} from './with-env.js';

const mockDotenvConfig = vi.mocked(dotenvConfig);
const mockExeca = vi.mocked(execa);

describe('with-env', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ENV_FILES', () => {
    it('loads .dev.vars, .env.development, .env.scripts in that order', () => {
      expect(ENV_FILES).toEqual(['apps/api/.dev.vars', '.env.development', '.env.scripts']);
    });
  });

  describe('NODE_OPTION_FLAG', () => {
    it('disables Node 25 experimental webstorage to keep jsdom Storage globals', () => {
      expect(NODE_OPTION_FLAG).toBe('--no-experimental-webstorage');
    });
  });

  describe('loadEnvironment', () => {
    it('calls dotenv for each env file with override and resolved root paths', () => {
      loadEnvironment('/repo');
      expect(mockDotenvConfig).toHaveBeenCalledTimes(3);
      expect(mockDotenvConfig).toHaveBeenNthCalledWith(1, {
        path: path.join('/repo', 'apps/api/.dev.vars'),
        override: true,
        quiet: true,
      });
      expect(mockDotenvConfig).toHaveBeenNthCalledWith(2, {
        path: path.join('/repo', '.env.development'),
        override: true,
        quiet: true,
      });
      expect(mockDotenvConfig).toHaveBeenNthCalledWith(3, {
        path: path.join('/repo', '.env.scripts'),
        override: true,
        quiet: true,
      });
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
    it('spawns the command with execa, inheriting stdio', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      const exitCode = await runCommand('pnpm', ['build']);
      expect(mockExeca).toHaveBeenCalledWith('pnpm', ['build'], {
        stdio: 'inherit',
        reject: false,
      });
      expect(exitCode).toBe(0);
    });

    it('propagates a non-zero exit code from the child', async () => {
      mockExeca.mockResolvedValue({ exitCode: 42 } as never);
      const exitCode = await runCommand('pnpm', ['test']);
      expect(exitCode).toBe(42);
    });

    it('returns 1 when the child exits with no numeric exit code', async () => {
      mockExeca.mockResolvedValue({ exitCode: undefined } as never);
      const exitCode = await runCommand('pnpm', ['test']);
      expect(exitCode).toBe(1);
    });

    it('throws a clear error when no command is provided', async () => {
      await expect(runCommand(undefined, [])).rejects.toThrow(
        'with-env: missing command. Usage: tsx scripts/with-env.ts <command> [...args]'
      );
    });
  });
});
