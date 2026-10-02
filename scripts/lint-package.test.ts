import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { lintPackageArgs, runLintPackage } from './lint-package.js';

const mockExeca = vi.mocked(execa);

describe('lintPackageArgs', () => {
  it('appends the warning flag behind the passthrough separator', () => {
    // The flag is why this script exists: `turbo lint --filter <pkg>` takes the
    // package name last, so nothing can follow it there.
    expect(lintPackageArgs(['@hushbox/api'])).toEqual([
      'lint',
      '--filter=@hushbox/api',
      '--',
      '--max-warnings=0',
    ]);
  });

  it('filters on every package named', () => {
    expect(lintPackageArgs(['@hushbox/api', '@hushbox/web'])).toEqual([
      'lint',
      '--filter=@hushbox/api',
      '--filter=@hushbox/web',
      '--',
      '--max-warnings=0',
    ]);
  });

  it('keeps a turbo flag ahead of the separator', () => {
    // `--force` is how a caller measures the current tree rather than replaying
    // a cached pass; behind the separator turbo would hand it to ESLint.
    expect(lintPackageArgs(['@hushbox/api', '--force'])).toEqual([
      'lint',
      '--filter=@hushbox/api',
      '--force',
      '--',
      '--max-warnings=0',
    ]);
  });

  it('forwards what follows a separator to the linter', () => {
    // pnpm re-inserts `--` before the caller's arguments, and the documented way
    // to reach ESLint from a scoped run was to append a tail after it. That tail
    // is the linter's, so it lands behind the separator this script writes —
    // reading it as a turbo flag put a stray `--` on the linter's command line.
    expect(lintPackageArgs(['@hushbox/api', '--', '--format', 'json'])).toEqual([
      'lint',
      '--filter=@hushbox/api',
      '--',
      '--max-warnings=0',
      '--format',
      'json',
    ]);
  });

  it('rejects an invocation that names no package', () => {
    expect(() => lintPackageArgs(['--force'])).toThrow(
      'lint:pkg: name a package, as in `pnpm lint:pkg @hushbox/api`'
    );
  });
});

describe('runLintPackage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('spawns turbo with the built arguments', async () => {
    mockExeca.mockResolvedValue({ exitCode: 0 } as never);
    expect(await runLintPackage(['@hushbox/api'])).toBe(0);
    expect(mockExeca).toHaveBeenCalledWith('turbo', lintPackageArgs(['@hushbox/api']), {
      stdio: 'inherit',
      reject: false,
    });
  });

  it('propagates the linter run exit code', async () => {
    mockExeca.mockResolvedValue({ exitCode: 1 } as never);
    expect(await runLintPackage(['@hushbox/api'])).toBe(1);
  });

  it('returns 1 when the child has no numeric exit code', async () => {
    mockExeca.mockResolvedValue({ exitCode: undefined } as never);
    expect(await runLintPackage(['@hushbox/api'])).toBe(1);
  });
});
