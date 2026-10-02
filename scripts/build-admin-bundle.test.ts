import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { Mode } from '@hushbox/shared';
import { buildAdminBundle, type BuildAdminBundleDeps } from './build-admin-bundle.js';
import { ENV_MODE_VARIABLE } from './lib/stack/stack-mode.js';

describe('build-admin-bundle', () => {
  const makeDeps = (): {
    generateEnv: Mock<BuildAdminBundleDeps['generateEnv']>;
    exec: Mock<BuildAdminBundleDeps['exec']>;
  } => ({
    generateEnv: vi.fn<BuildAdminBundleDeps['generateEnv']>(),
    exec: vi.fn<BuildAdminBundleDeps['exec']>(),
  });
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  // createEnvUtilities fail-fasts on a missing NODE_ENV, so every env context
  // here carries one explicitly — mirroring the real invocation, which inherits
  // NODE_ENV from with-env's loaded .dev.vars.
  it('regenerates frontend-only env for the E2E mode before building (local)', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development' }, deps);
    expect(deps.generateEnv).toHaveBeenCalledWith('/repo', Mode.E2E, { skipBackend: true });
  });

  it('regenerates env for CiE2E mode when in CI', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development', CI: 'true' }, deps);
    expect(deps.generateEnv).toHaveBeenCalledWith('/repo', Mode.CiE2E, { skipBackend: true });
  });

  it('builds admin through turbo in the stack mode whose env file it generated', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development' }, deps);
    expect(deps.exec).toHaveBeenCalledWith(
      'turbo',
      ['build', '--filter=@hushbox/admin'],
      expect.anything()
    );
  });

  it('builds in that same stack mode in CI, where the env mode is the CI variant', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development', CI: 'true' }, deps);
    expect(deps.exec).toHaveBeenCalledWith(
      'turbo',
      ['build', '--filter=@hushbox/admin'],
      expect.anything()
    );
  });

  // The flag above reaches the task named in the request and nothing else, so
  // the tasks that build ahead of it resolve their own stack from the
  // environment. Naming it here is what makes every task in the graph load the
  // files this run just generated.
  it('names that stack in the environment the build runs under', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development' }, deps);
    expect(deps.exec).toHaveBeenCalledWith('turbo', expect.anything(), {
      [ENV_MODE_VARIABLE]: Mode.E2E,
    });
  });

  it('names the CI mode itself there too', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development', CI: 'true' }, deps);
    expect(deps.exec).toHaveBeenCalledWith('turbo', expect.anything(), {
      [ENV_MODE_VARIABLE]: Mode.CiE2E,
    });
  });

  it('runs only the turbo build — no marketing merge (admin CSP `_headers` come from its own Vite build)', async () => {
    await buildAdminBundle('/repo', { NODE_ENV: 'development' }, deps);
    expect(deps.exec).toHaveBeenCalledTimes(1);
  });

  it('generates env before invoking the build', async () => {
    const order: string[] = [];
    deps.generateEnv.mockImplementation(() => {
      order.push('generateEnv');
    });
    deps.exec.mockImplementation(() => {
      order.push('exec');
      return Promise.resolve();
    });
    await buildAdminBundle('/repo', { NODE_ENV: 'development' }, deps);
    expect(order).toEqual(['generateEnv', 'exec']);
  });
});
