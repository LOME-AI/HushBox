import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

import { Mode } from '@hushbox/shared';
import {
  COMMAND_LINE,
  assertE2eTarget,
  selectE2eEnvMode,
  buildWebBundle,
  type BuildWebBundleDeps,
} from './build-web-bundle.js';
import { parseCommandLine } from './lib/cli/command-line.js';
import { ENV_MODE_VARIABLE } from './lib/stack/stack-mode.js';

describe('build-web-bundle', () => {
  describe('assertE2eTarget', () => {
    it('accepts the one target it builds', () => {
      expect(assertE2eTarget('e2e')).toBe('e2e');
    });

    it('throws for a target it does not build', () => {
      expect(() => assertE2eTarget('prod')).toThrow(/--target/);
    });

    it('throws when no target was named', () => {
      const unnamed = parseCommandLine(COMMAND_LINE, []);
      expect(() =>
        assertE2eTarget(unnamed.kind === 'run' ? unnamed.flags['--target'] : 'e2e')
      ).toThrow(/--target/);
    });
  });

  describe('the command line', () => {
    it('reads a help request as a request for usage, so the entry can answer it', () => {
      expect(parseCommandLine(COMMAND_LINE, ['--help']).kind).toBe('help');
    });

    it('refuses a flag it does not recognise', () => {
      expect(() => parseCommandLine(COMMAND_LINE, ['--target=e2e', '--verbose'])).toThrow(
        /--verbose/
      );
    });
  });

  describe('selectE2eEnvMode', () => {
    // createEnvUtilities fail-fasts on a missing NODE_ENV, so every env
    // context here carries one explicitly — mirroring the real invocation,
    // which inherits NODE_ENV from with-env's loaded .dev.vars.
    it('maps to E2E when not in CI', () => {
      expect(selectE2eEnvMode({ NODE_ENV: 'development' })).toBe(Mode.E2E);
    });

    it('maps to CiE2E when in CI', () => {
      expect(selectE2eEnvMode({ NODE_ENV: 'development', CI: 'true' })).toBe(Mode.CiE2E);
    });
  });

  describe('buildWebBundle', () => {
    const makeDeps = (): {
      generateEnv: Mock<BuildWebBundleDeps['generateEnv']>;
      exec: Mock<BuildWebBundleDeps['exec']>;
      merge: Mock<BuildWebBundleDeps['merge']>;
      verify: Mock<BuildWebBundleDeps['verify']>;
    } => ({
      generateEnv: vi.fn<BuildWebBundleDeps['generateEnv']>(),
      exec: vi.fn<BuildWebBundleDeps['exec']>(),
      merge: vi.fn<BuildWebBundleDeps['merge']>(),
      verify: vi.fn<BuildWebBundleDeps['verify']>(),
    });
    let deps: ReturnType<typeof makeDeps>;

    beforeEach(() => {
      deps = makeDeps();
    });

    it('regenerates frontend-only env for the selected mode before building', async () => {
      await buildWebBundle('/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.generateEnv).toHaveBeenCalledWith('/repo', Mode.E2E, { skipBackend: true });
    });

    it('builds web+marketing through turbo in the stack mode whose env file it generated', async () => {
      await buildWebBundle('/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.exec).toHaveBeenNthCalledWith(
        1,
        'turbo',
        ['build', '--filter=@hushbox/web', '--filter=@hushbox/marketing'],
        { [ENV_MODE_VARIABLE]: Mode.E2E }
      );
    });

    it('names the CI mode itself, so the build resolves the mode that generated its file', async () => {
      await buildWebBundle('/repo', { NODE_ENV: 'development', CI: 'true' }, deps);
      expect(deps.exec).toHaveBeenNthCalledWith(
        1,
        'turbo',
        ['build', '--filter=@hushbox/web', '--filter=@hushbox/marketing'],
        { [ENV_MODE_VARIABLE]: Mode.CiE2E }
      );
    });

    it('names no mode on the command line, so the bundlers derive it', async () => {
      await buildWebBundle('/repo', { NODE_ENV: 'development' }, deps);
      const [, args] = deps.exec.mock.calls[0] ?? [];
      // Both `--mode production` and `--mode=production` set it, so the flag is
      // matched rather than the whole token.
      expect(args?.filter((argument) => argument.startsWith('--mode'))).toEqual([]);
    });

    it('merges marketing into web after the build', async () => {
      await buildWebBundle('/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.merge).toHaveBeenCalledWith({ repoRoot: '/repo' });
    });

    it('generates headers (under with-env) after merging', async () => {
      await buildWebBundle('/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.exec).toHaveBeenNthCalledWith(
        2,
        'tsx',
        ['scripts/with-env.ts', 'tsx', 'scripts/generate-headers.ts'],
        { [ENV_MODE_VARIABLE]: Mode.E2E }
      );
    });

    // The mode goes with the dist: everything above it derives one answer from
    // this one mode, and the verification is what holds the bundle to it.
    it('verifies the merged web dist against the stack it built for', async () => {
      await buildWebBundle('/repo', { NODE_ENV: 'development' }, deps);
      expect(deps.verify).toHaveBeenCalledWith({
        distributionDir: '/repo/apps/web/dist',
        shipsTts: true,
        stackEnvFile: '/repo/.env.e2e',
      });
    });

    it('generates headers before verifying, so verification sees the file', async () => {
      const order: string[] = [];
      deps.exec.mockImplementation((file) => {
        order.push(file === 'tsx' ? 'headers' : 'build');
        return Promise.resolve();
      });
      deps.verify.mockImplementation(() => {
        order.push('verify');
        return Promise.resolve();
      });

      await buildWebBundle('/repo', { NODE_ENV: 'development' }, deps);

      expect(order).toEqual(['build', 'headers', 'verify']);
    });

    it('does not verify the bundle when header generation fails', async () => {
      deps.exec
        .mockImplementationOnce(() => Promise.resolve())
        .mockRejectedValueOnce(new Error('headers failed'));
      await expect(buildWebBundle('/repo', { NODE_ENV: 'development' }, deps)).rejects.toThrow(
        'headers failed'
      );
      expect(deps.verify).not.toHaveBeenCalled();
    });

    it('does not merge or generate headers when the build fails', async () => {
      deps.exec.mockRejectedValueOnce(new Error('build failed'));
      await expect(buildWebBundle('/repo', { NODE_ENV: 'development' }, deps)).rejects.toThrow(
        'build failed'
      );
      expect(deps.merge).not.toHaveBeenCalled();
      expect(deps.exec).toHaveBeenCalledTimes(1);
    });
  });
});
