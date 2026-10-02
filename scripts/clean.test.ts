import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({ rm: vi.fn() }));
vi.mock('execa', () => ({ execa: vi.fn() }));
// The shared unread-run predicate stays real and is watched: the refusal below
// has to be its answer rather than a second filter spelled here.
vi.mock('./lib/claims/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/claims/registry.js')>();
  return { ...actual, enumerateRegistry: vi.fn(), unreadLiveRuns: vi.fn(actual.unreadLiveRuns) };
});

import { rm } from 'node:fs/promises';
import { execa } from 'execa';
import { enumerateRegistry, unreadLiveRuns } from './lib/claims/registry.js';
import { parseCommandLine } from './lib/cli/command-line.js';
import { removeDirectory, runTurboClean, runClean, COMMAND_LINE, OVERRIDE_FLAG } from './clean.js';

const mockRm = vi.mocked(rm);
const mockExeca = vi.mocked(execa);
const mockRegistry = vi.mocked(enumerateRegistry);
const mockUnreadLiveRuns = vi.mocked(unreadLiveRuns);

const CHECKOUT = '/checkout-under-test/.git';

type RegistryReading = Awaited<ReturnType<typeof enumerateRegistry>>;
type EnumeratedClaim = RegistryReading['claims'][number];

/** A claim as the registry reading reports one. */
function liveClaim(command: string, gitCommonDir = CHECKOUT): EnumeratedClaim {
  return {
    state: 'owned-live',
    claim: {
      runId: 'run-id',
      command,
      mode: 'development',
      slot: 3,
      pid: 4242,
      gitCommonDir,
      spawned: [],
      resources: [],
    },
  };
}

const UNREAD_RUN_ID = 'a-run-whose-record-went-unread';

/**
 * A run directory the pass could not make sense of. It names no checkout,
 * which is the whole reason it cannot be ruled out of this one.
 */
function unreadable(state: 'owned-live' | 'owned-expired'): RegistryReading['unreadable'][number] {
  return { runId: UNREAD_RUN_ID, state, reason: 'it is not JSON' };
}

/** One reading of the registry, in the two halves a case here ever varies. */
function reading(overrides: Partial<RegistryReading> = {}): RegistryReading {
  return { claims: [], unreadable: [], endedRuns: [], ...overrides };
}

function request(ignoreLiveClaims = false): { ignoreLiveClaims: boolean; gitCommonDir: string } {
  return { ignoreLiveClaims, gitCommonDir: CHECKOUT };
}

describe('clean', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry.mockResolvedValue(reading());
  });

  describe('command line', () => {
    it('reads the override off the command line', () => {
      const parsed = parseCommandLine(COMMAND_LINE, [OVERRIDE_FLAG]);
      expect(parsed.kind === 'run' && parsed.flags[OVERRIDE_FLAG]).toBe(true);
    });

    it('defaults to refusing', () => {
      const parsed = parseCommandLine(COMMAND_LINE, []);
      expect(parsed.kind === 'run' && parsed.flags[OVERRIDE_FLAG]).toBe(false);
    });

    it('refuses an argument it does not recognise', () => {
      expect(() => parseCommandLine(COMMAND_LINE, ['--purge'])).toThrow(/--purge/);
    });
  });

  describe('removeDirectory', () => {
    it('calls fs.rm with recursive and force', async () => {
      mockRm.mockResolvedValue();
      await removeDirectory('node_modules');
      expect(mockRm).toHaveBeenCalledWith('node_modules', { recursive: true, force: true });
    });

    it('propagates fs.rm errors', async () => {
      mockRm.mockRejectedValue(new Error('EACCES'));
      await expect(removeDirectory('node_modules')).rejects.toThrow('EACCES');
    });
  });

  describe('runTurboClean', () => {
    it('spawns turbo clean with inherited stdio', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      await runTurboClean();
      expect(mockExeca).toHaveBeenCalledWith('turbo', ['clean'], { stdio: 'inherit' });
    });
  });

  describe('runClean', () => {
    it('runs turbo clean then removes node_modules', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      mockRm.mockResolvedValue();
      await runClean(request());
      expect(mockExeca).toHaveBeenCalledWith('turbo', ['clean'], { stdio: 'inherit' });
      expect(mockRm).toHaveBeenCalledWith('node_modules', { recursive: true, force: true });
    });

    it('does not remove node_modules if turbo clean throws', async () => {
      mockExeca.mockRejectedValue(new Error('turbo failed'));
      await expect(runClean(request())).rejects.toThrow('turbo failed');
      expect(mockRm).not.toHaveBeenCalled();
    });

    it('refuses while a run of this checkout is alive', async () => {
      mockRegistry.mockResolvedValue(reading({ claims: [liveClaim('pnpm dev')] }));

      await expect(runClean(request())).rejects.toThrow('pnpm dev');
    });

    it('runs neither turbo clean nor the node_modules removal when it refuses', async () => {
      mockRegistry.mockResolvedValue(reading({ claims: [liveClaim('pnpm dev')] }));

      await expect(runClean(request())).rejects.toThrow('pnpm dev');
      expect(mockExeca).not.toHaveBeenCalled();
      expect(mockRm).not.toHaveBeenCalled();
    });

    it('runs both destructive steps once the override is given', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockRegistry.mockResolvedValue(reading({ claims: [liveClaim('pnpm dev')] }));
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      mockRm.mockResolvedValue();

      await runClean(request(true));

      expect(mockExeca).toHaveBeenCalledWith('turbo', ['clean'], { stdio: 'inherit' });
      expect(mockRm).toHaveBeenCalledWith('node_modules', { recursive: true, force: true });
    });
  });

  describe('a live run whose record could not be read', () => {
    it('refuses, because the checkout it belongs to is exactly what went unread', async () => {
      mockRegistry.mockResolvedValue(reading({ unreadable: [unreadable('owned-live')] }));

      await expect(runClean(request())).rejects.toThrow(UNREAD_RUN_ID);
    });

    it('runs neither destructive step when it refuses on one', async () => {
      mockRegistry.mockResolvedValue(reading({ unreadable: [unreadable('owned-live')] }));

      await expect(runClean(request())).rejects.toThrow(UNREAD_RUN_ID);
      expect(mockExeca).not.toHaveBeenCalled();
      expect(mockRm).not.toHaveBeenCalled();
    });

    it('cleans anyway once the override is given, saying what it is cleaning over', async () => {
      const warnings: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((line: string) => {
        warnings.push(line);
      });
      mockRegistry.mockResolvedValue(reading({ unreadable: [unreadable('owned-live')] }));
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      mockRm.mockResolvedValue();

      await runClean(request(true));

      expect(mockExeca).toHaveBeenCalledWith('turbo', ['clean'], { stdio: 'inherit' });
      expect(warnings.join('\n')).toContain(UNREAD_RUN_ID);
    });

    it('is named by the shared predicate rather than by a filter spelled here', async () => {
      mockRegistry.mockResolvedValue(reading({ unreadable: [unreadable('owned-expired')] }));
      mockUnreadLiveRuns.mockReturnValueOnce([unreadable('owned-live')]);

      await expect(runClean(request())).rejects.toThrow(UNREAD_RUN_ID);
    });

    it('is no obstacle once its run has gone, the lock being the whole predicate', async () => {
      mockRegistry.mockResolvedValue(reading({ unreadable: [unreadable('owned-expired')] }));
      mockExeca.mockResolvedValue({ exitCode: 0 } as never);
      mockRm.mockResolvedValue();

      await expect(runClean(request())).resolves.toBeUndefined();
    });
  });
});
