import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { execa } from 'execa';
import {
  IMAGE_NAMESPACE,
  MOBILE_IMAGE_CONTEXT,
  computeImageHash,
  computeImageTag,
  localImageExists,
  manifestExists,
  bakeImage,
  runEmulatorContainer,
} from './mobile-image.js';
import { RUN_CLAIM_ENV, registerRun } from '../claims/registry.js';
import { readOwnership, recordOwnedResource } from '../claims/ownership.js';
import { withScratchDirectory } from '../scratch-directory.js';

const mockExeca = vi.mocked(execa);

describe('mobile-image', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('IMAGE_NAMESPACE and MOBILE_IMAGE_CONTEXT', () => {
    it('exposes the GHCR namespace under lome-ai', () => {
      expect(IMAGE_NAMESPACE).toBe('ghcr.io/lome-ai/hushbox-android-emulator');
    });

    it('points to mobile-tests/docker for the build context', () => {
      // Absolute so docker build and hashing work regardless of caller cwd.
      expect(MOBILE_IMAGE_CONTEXT).toMatch(/[/\\]mobile-tests[/\\]docker$/);
      expect(path.isAbsolute(MOBILE_IMAGE_CONTEXT)).toBe(true);
    });
  });

  describe('computeImageHash', () => {
    let temporaryDir: string;

    beforeEach(async () => {
      temporaryDir = await mkdtemp(path.join(tmpdir(), 'mobile-image-hash-'));
    });

    afterEach(async () => {
      await rm(temporaryDir, { recursive: true, force: true });
    });

    it('returns a hex string', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const hash = await computeImageHash(temporaryDir);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });

    it('produces the same hash for identical content', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const first = await computeImageHash(temporaryDir);
      const second = await computeImageHash(temporaryDir);
      expect(first).toBe(second);
    });

    it('produces a different hash when file content changes', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const before = await computeImageHash(temporaryDir);
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM alpine\n');
      const after = await computeImageHash(temporaryDir);
      expect(after).not.toBe(before);
    });

    it('includes all files in the context dir, not just the Dockerfile', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const before = await computeImageHash(temporaryDir);
      await writeFile(path.join(temporaryDir, 'extra.txt'), 'data');
      const after = await computeImageHash(temporaryDir);
      expect(after).not.toBe(before);
    });

    it('hashes files recursively', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const before = await computeImageHash(temporaryDir);
      await mkdir(path.join(temporaryDir, 'sub'));
      await writeFile(path.join(temporaryDir, 'sub', 'nested'), 'x');
      const after = await computeImageHash(temporaryDir);
      expect(after).not.toBe(before);
    });

    it('is order-independent with respect to filesystem listing', async () => {
      // Hash should depend on (path, content) pairs sorted consistently, not on
      // the OS's readdir order. We can't easily simulate alternate orderings,
      // but we can confirm that adding files in different orders yields the
      // same final hash.
      await writeFile(path.join(temporaryDir, 'a'), '1');
      await writeFile(path.join(temporaryDir, 'b'), '2');
      const first = await computeImageHash(temporaryDir);
      await rm(path.join(temporaryDir, 'a'));
      await rm(path.join(temporaryDir, 'b'));
      await writeFile(path.join(temporaryDir, 'b'), '2');
      await writeFile(path.join(temporaryDir, 'a'), '1');
      const second = await computeImageHash(temporaryDir);
      expect(first).toBe(second);
    });

    it('ignores entries that are neither files nor directories', async () => {
      await writeFile(path.join(temporaryDir, 'Dockerfile'), 'FROM scratch\n');
      const before = await computeImageHash(temporaryDir);
      await symlink(path.join(temporaryDir, 'Dockerfile'), path.join(temporaryDir, 'link'));
      const after = await computeImageHash(temporaryDir);
      expect(after).toBe(before);
    });
  });

  describe('runEmulatorContainer', () => {
    const baseOptions = {
      name: 'hushbox-4-emulator-shard-0',
      hostAdbPort: 5555,
      imageTag: 'ghcr.io/lome-ai/hushbox-android-emulator:tag',
      kvmGid: '993',
    };

    it('enables the noVNC viewer only when includeVnc is set', async () => {
      await runEmulatorContainer({ ...baseOptions, includeVnc: true });

      const run = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('run')
      );
      expect(run?.[1]).toContain('WEB_VNC=true');
    });

    it('omits the noVNC env var when includeVnc is false', async () => {
      await runEmulatorContainer({ ...baseOptions, includeVnc: false });

      const run = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('run')
      );
      expect(run).toBeDefined();
      expect(run?.[1]).not.toContain('WEB_VNC=true');
    });

    /**
     * A world in which the shard's container is already there. The stock mock
     * answers every `docker ps` with nothing, which is the free-name case.
     */
    function containerAlreadyPresent(name: string): void {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const argumentList = Array.isArray(args) ? args : [];
        if (cmd === 'docker' && argumentList[0] === 'ps') {
          return Promise.resolve({ exitCode: 0, stdout: name });
        }
        return Promise.resolve({ exitCode: 0, stdout: '' });
      }) as never);
    }

    function inScratchRun<T>(registryDir: string, body: () => Promise<T>): Promise<T> {
      return registerRun(
        {
          command: 'pnpm mobile:test',
          mode: 'development',
          slot: 4,
          gitCommonDir: path.join(path.sep, 'checkout', '.git'),
          registryDir,
        },
        body
      );
    }

    it('records the container against the run claim before it is created', async () => {
      // The invocation running this suite is itself a registered run, and it
      // stamps its run directory into the environment every child inherits.
      // Left in place, `registerRun` below adopts that run instead of
      // registering in the scratch registry, and this case reads the
      // machine-wide registry every other process on this machine is writing.
      vi.stubEnv(RUN_CLAIM_ENV, '');

      await withScratchDirectory('hushbox-emulator-claim-', (registryDir) =>
        inScratchRun(registryDir, async () => {
          await runEmulatorContainer({ ...baseOptions, includeVnc: false, registryDir });

          const ownership = await readOwnership(registryDir);
          expect(ownership.stateOfResource('container', baseOptions.name)).toBe('owned-live');
        })
      );
    });

    it('refuses to start an emulator it could not record against a run claim', async () => {
      vi.stubEnv(RUN_CLAIM_ENV, '');

      await expect(runEmulatorContainer({ ...baseOptions, includeVnc: false })).rejects.toThrow(
        'holds no run claim'
      );

      const run = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('run')
      );
      expect(run).toBeUndefined();
    });

    it('removes no leftover when nothing carries the name', async () => {
      await runEmulatorContainer({ ...baseOptions, includeVnc: false });

      const removal = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args[0] === 'rm'
      );
      expect(removal).toBeUndefined();
    });

    it('removes a leftover whose owning run is gone, then starts', async () => {
      vi.stubEnv(RUN_CLAIM_ENV, '');
      containerAlreadyPresent(baseOptions.name);

      await withScratchDirectory('hushbox-emulator-expired-', async (registryDir) => {
        await expect(
          inScratchRun(registryDir, async () => {
            await recordOwnedResource('container', baseOptions.name);
            throw new Error('killed');
          })
        ).rejects.toThrow('killed');

        // A run of its own: starting an emulator needs a claim to record the
        // container against, exactly as the run that died held one.
        await inScratchRun(registryDir, () =>
          runEmulatorContainer({ ...baseOptions, includeVnc: false, registryDir })
        );
      });

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', baseOptions.name],
        expect.objectContaining({ stdio: 'inherit' })
      );
      const run = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('run')
      );
      expect(run).toBeDefined();
    });

    it('refuses to remove or start over a container another live run holds', async () => {
      vi.stubEnv(RUN_CLAIM_ENV, '');
      containerAlreadyPresent(baseOptions.name);

      await withScratchDirectory('hushbox-emulator-held-', (registryDir) =>
        inScratchRun(registryDir, async () => {
          await recordOwnedResource('container', baseOptions.name);
          vi.stubEnv(RUN_CLAIM_ENV, '');
          await inScratchRun(registryDir, async () => {
            await expect(
              runEmulatorContainer({ ...baseOptions, includeVnc: false, registryDir })
            ).rejects.toThrow(baseOptions.name);
          });
        })
      );

      const removal = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args[0] === 'rm'
      );
      expect(removal).toBeUndefined();
      const run = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args.includes('run')
      );
      expect(run).toBeUndefined();
    });

    it('refuses while a live run’s record cannot be read', async () => {
      vi.stubEnv(RUN_CLAIM_ENV, '');
      containerAlreadyPresent(baseOptions.name);

      await withScratchDirectory('hushbox-emulator-unread-', async (registryDir) => {
        await expect(
          inScratchRun(registryDir, async () => {
            await recordOwnedResource('container', baseOptions.name);
            throw new Error('killed');
          })
        ).rejects.toThrow('killed');

        await inScratchRun(registryDir, async () => {
          const record = path.join(process.env[RUN_CLAIM_ENV] ?? '', 'run.json');
          const written: unknown = JSON.parse(await readFile(record, 'utf8'));
          await writeFile(
            record,
            JSON.stringify({
              ...(written as object),
              mode: 'a-mode-this-checkout-has-never-heard-of',
            })
          );
          vi.stubEnv(RUN_CLAIM_ENV, '');
          await inScratchRun(registryDir, async () => {
            await expect(
              runEmulatorContainer({ ...baseOptions, includeVnc: false, registryDir })
            ).rejects.toThrow('could not be read');
          });
        });
      });

      const removal = mockExeca.mock.calls.find(
        ([, args]) => Array.isArray(args) && args[0] === 'rm'
      );
      expect(removal).toBeUndefined();
    });
  });

  describe('computeImageTag', () => {
    it('returns a tag in the IMAGE_NAMESPACE with a hex hash', async () => {
      const tag = await computeImageTag();
      expect(tag).toMatch(new RegExp(`^${IMAGE_NAMESPACE}:[0-9a-f]+$`));
    });

    it('is deterministic across calls', async () => {
      const a = await computeImageTag();
      const b = await computeImageTag();
      expect(a).toBe(b);
    });
  });

  describe('localImageExists', () => {
    it('returns true when docker images outputs a non-empty id', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'sha256:abc123', exitCode: 0 } as never);
      expect(await localImageExists('test:tag')).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith('docker', ['images', '-q', 'test:tag']);
    });

    it('returns false when docker images outputs an empty string', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '', exitCode: 0 } as never);
      expect(await localImageExists('test:tag')).toBe(false);
    });

    it('returns false when docker images outputs only whitespace', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '\n  \n', exitCode: 0 } as never);
      expect(await localImageExists('test:tag')).toBe(false);
    });

    it('returns false when docker images throws (daemon offline, etc)', async () => {
      mockExeca.mockRejectedValueOnce(new Error('daemon not running'));
      expect(await localImageExists('test:tag')).toBe(false);
    });
  });

  describe('manifestExists', () => {
    it('returns true when docker manifest inspect exits 0', async () => {
      mockExeca.mockResolvedValueOnce({ exitCode: 0 } as never);
      expect(await manifestExists('test:tag')).toBe(true);
      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['manifest', 'inspect', 'test:tag'],
        expect.objectContaining({ stdio: 'ignore' })
      );
    });

    it('returns false when docker manifest inspect rejects', async () => {
      mockExeca.mockRejectedValueOnce(new Error('manifest unknown'));
      expect(await manifestExists('test:tag')).toBe(false);
    });
  });

  describe('bakeImage', () => {
    function dockerImagesResponse(options: { localHit?: boolean }): Promise<unknown> {
      return Promise.resolve({ stdout: options.localHit ? 'sha256:cached' : '' });
    }

    function manifestResponse(options: { remoteHit?: boolean }): Promise<unknown> {
      return options.remoteHit
        ? Promise.resolve({ exitCode: 0 })
        : Promise.reject(new Error('manifest unknown'));
    }

    function dispatchBakeCall(
      cmd: string,
      args: readonly string[],
      options: { localHit?: boolean; remoteHit?: boolean }
    ): Promise<unknown> {
      if (cmd === 'docker' && args[0] === 'images' && args[1] === '-q') {
        return dockerImagesResponse(options);
      }
      if (cmd === 'docker' && args[0] === 'manifest' && args[1] === 'inspect') {
        return manifestResponse(options);
      }
      return Promise.resolve({ exitCode: 0, stdout: '' });
    }

    function setupBakePath(options: { localHit?: boolean; remoteHit?: boolean }): void {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        dispatchBakeCall(cmd, Array.isArray(args) ? args : [], options)) as never);
    }

    it('returns the tag and skips work when the image is in the local cache', async () => {
      setupBakePath({ localHit: true });

      const tag = await bakeImage({ push: false });

      expect(tag).toMatch(new RegExp(`^${IMAGE_NAMESPACE}:[0-9a-f]+$`));
      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.includes('build'))).toBe(false);
      expect(calls.some((c) => c.includes('commit'))).toBe(false);
      expect(calls.some((c) => c.includes('push'))).toBe(false);
      expect(calls.some((c) => c.startsWith('docker pull'))).toBe(false);
    });

    it('pulls from the registry on local miss but manifest hit', async () => {
      setupBakePath({ localHit: false, remoteHit: true });

      const tag = await bakeImage({ push: false });

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['pull', tag],
        expect.objectContaining({ stdio: 'inherit' })
      );
      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.includes('build'))).toBe(false);
    });

    it('builds the content-hashed image (cold-boot, no snapshot) when local and remote miss', async () => {
      setupBakePath({ localHit: false, remoteHit: false });

      const tag = await bakeImage({ push: false });

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['build', '-t', tag, MOBILE_IMAGE_CONTEXT]),
        expect.anything()
      );
      // Cold-boot model: the bake builds the image only — no emulator run,
      // snapshot save, or commit (those produced an unbootable committed image).
      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.includes('run -d') || c.includes('--privileged'))).toBe(false);
      expect(calls.some((c) => c.includes('snapshot'))).toBe(false);
      expect(calls.some((c) => c.includes('commit'))).toBe(false);
    });

    it('pushes when push=true', async () => {
      setupBakePath({ localHit: false, remoteHit: false });

      const tag = await bakeImage({ push: true });

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['push', tag],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('does not push when push=false', async () => {
      setupBakePath({ localHit: false, remoteHit: false });

      await bakeImage({ push: false });

      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.startsWith('docker push'))).toBe(false);
    });

    it('does not push on cache hit even when push=true (already in registry)', async () => {
      setupBakePath({ localHit: false, remoteHit: true });

      await bakeImage({ push: true });

      const calls = mockExeca.mock.calls.map(
        (c) => `${String(c[0])} ${(c[1] as string[]).join(' ')}`
      );
      expect(calls.some((c) => c.startsWith('docker push'))).toBe(false);
    });

    it('does not run/commit a container during the build (cold-boot model)', async () => {
      setupBakePath({ localHit: false, remoteHit: false });

      await bakeImage({ push: false });

      const ranContainer = mockExeca.mock.calls.some(
        (c) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'run'
      );
      const committed = mockExeca.mock.calls.some(
        (c) => c[0] === 'docker' && Array.isArray(c[1]) && (c[1] as string[])[0] === 'commit'
      );
      expect(ranContainer).toBe(false);
      expect(committed).toBe(false);
    });
  });
});
