import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RUN_CLAIM_ENV, registerRun } from './lib/claims/registry.js';
import { withScratchDirectory } from './lib/scratch-directory.js';
import { assertCleanIsSafe, requireGitCommonDir, OVERRIDE_FLAG } from './clean.js';

const THIS_CHECKOUT = '/checkout-under-test/.git';
const ANOTHER_CHECKOUT = '/another-checkout/.git';

describe('the live-claim guard on clean', () => {
  beforeEach(() => {
    // The invocation running this suite is itself a registered run, and it
    // stamps its run directory into the environment every child inherits. Left
    // in place, `registerRun` below adopts that run instead of registering in
    // the scratch registry, and these cases read the machine-wide registry
    // every other process on this machine is writing.
    vi.stubEnv(RUN_CLAIM_ENV, '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function withRegistry<T>(body: (registryDir: string) => Promise<T>): Promise<T> {
    return withScratchDirectory('hushbox-clean-claims-', body);
  }

  function request(
    registryDir: string,
    overrides: { ignoreLiveClaims?: boolean; gitCommonDir?: string } = {}
  ): { ignoreLiveClaims: boolean; gitCommonDir: string; registryDir: string } {
    return {
      ignoreLiveClaims: overrides.ignoreLiveClaims ?? false,
      gitCommonDir: overrides.gitCommonDir ?? THIS_CHECKOUT,
      registryDir,
    };
  }

  function run<T>(
    registryDir: string,
    command: string,
    gitCommonDir: string,
    body: () => Promise<T>
  ): Promise<T> {
    return registerRun({ command, mode: 'development', slot: 3, gitCommonDir, registryDir }, body);
  }

  it('proceeds when the registry holds no claim at all', async () => {
    await withRegistry(async (registryDir) => {
      await expect(assertCleanIsSafe(request(registryDir))).resolves.toBeUndefined();
    });
  });

  it('refuses while a run of this checkout holds its claim', async () => {
    await withRegistry(async (registryDir) => {
      await run(registryDir, 'pnpm dev', THIS_CHECKOUT, async () => {
        await expect(assertCleanIsSafe(request(registryDir))).rejects.toThrow('pnpm dev');
      });
    });
  });

  it('names the override flag in the refusal', async () => {
    await withRegistry(async (registryDir) => {
      await run(registryDir, 'pnpm dev', THIS_CHECKOUT, async () => {
        await expect(assertCleanIsSafe(request(registryDir))).rejects.toThrow(OVERRIDE_FLAG);
      });
    });
  });

  it('ignores a live run of another checkout', async () => {
    await withRegistry(async (registryDir) => {
      await run(registryDir, 'pnpm dev', ANOTHER_CHECKOUT, async () => {
        await expect(assertCleanIsSafe(request(registryDir))).resolves.toBeUndefined();
      });
    });
  });

  it('proceeds once the claim is released', async () => {
    await withRegistry(async (registryDir) => {
      await run(registryDir, 'pnpm dev', THIS_CHECKOUT, () => Promise.resolve());

      await expect(assertCleanIsSafe(request(registryDir))).resolves.toBeUndefined();
    });
  });

  it('proceeds past a claim whose run died, since nothing alive holds it', async () => {
    await withRegistry(async (registryDir) => {
      // A body that throws leaves the record behind for reclamation while the
      // lock is released, which is exactly the owned-expired state.
      await expect(
        run(registryDir, 'pnpm dev', THIS_CHECKOUT, () => Promise.reject(new Error('killed')))
      ).rejects.toThrow('killed');

      await expect(assertCleanIsSafe(request(registryDir))).resolves.toBeUndefined();
    });
  });

  it('proceeds under the override rather than refusing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await withRegistry(async (registryDir) => {
      await run(registryDir, 'pnpm dev', THIS_CHECKOUT, async () => {
        await expect(
          assertCleanIsSafe(request(registryDir, { ignoreLiveClaims: true }))
        ).resolves.toBeUndefined();
      });
    });
  });

  it('prints what the override is overriding rather than passing silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await withRegistry(async (registryDir) => {
      await run(registryDir, 'pnpm dev', THIS_CHECKOUT, async () => {
        await assertCleanIsSafe(request(registryDir, { ignoreLiveClaims: true }));
      });
    });

    const printed = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(printed).toContain(OVERRIDE_FLAG);
    expect(printed).toContain('pnpm dev');
  });
});

describe('requireGitCommonDir', () => {
  it('resolves the common directory of a checkout', async () => {
    await expect(requireGitCommonDir(process.cwd())).resolves.toContain('.git');
  });

  it('refuses a directory that is not a checkout, rather than cleaning blind', async () => {
    await withScratchDirectory('hushbox-not-a-checkout-', async (outside) => {
      await expect(requireGitCommonDir(outside)).rejects.toThrow('not a git checkout');
    });
  });
});
