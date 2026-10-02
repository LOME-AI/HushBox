import { describe, it, expect } from 'vitest';
import { packageVitestArgs } from './package-vitest.js';

describe('packageVitestArgs', () => {
  it('runs everything the package config collects when the caller passes nothing', () => {
    expect(packageVitestArgs([])).toEqual([]);
  });

  it('forwards a caller’s arguments in order', () => {
    expect(packageVitestArgs(['src/errors.test.ts', '-t', 'rejects'])).toEqual([
      'src/errors.test.ts',
      '-t',
      'rejects',
    ]);
  });

  it('drops the separator pnpm keeps ahead of a caller’s arguments', () => {
    expect(packageVitestArgs(['--', 'src/errors.test.ts', '-t', 'rejects'])).toEqual([
      'src/errors.test.ts',
      '-t',
      'rejects',
    ]);
  });

  it('drops the separator pnpm keeps behind a script’s own leading arguments', () => {
    // A script that spells its own flags in the manifest has them ahead of the
    // separator pnpm appends, so the separator is never the first slot.
    expect(
      packageVitestArgs(['run', '--config', 'vitest.workers.config.ts', '--', 'src/room.test.ts'])
    ).toEqual(['run', '--config', 'vitest.workers.config.ts', 'src/room.test.ts']);
  });

  it('refuses a separator the caller’s own arguments still carry', () => {
    // vitest swallows a surviving separator and everything behind it without a
    // word, so passing one on would drop arguments silently and widen the run.
    expect(() => packageVitestArgs(['--', 'src', '--', '-t', 'a name'])).toThrow(
      "package-vitest: `--` ends vitest's options, so `-t`, `a name` would have reached neither " +
        'a filter nor a flag and the run would have covered every file the package config ' +
        'collects. Write the same arguments without the `--`.'
    );
  });
});
