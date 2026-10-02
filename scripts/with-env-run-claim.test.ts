import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUN_CLAIM_ENV,
  enumerateClaims,
  readSlotLiveness,
  registerRun,
} from './lib/claims/registry.js';
import { portFor } from './lib/stack/port-plan.js';
import {
  CLONE_DIR_VARIABLE,
  STACK_SLOT_VARIABLE,
  hostPortsForRun,
  runCommand,
  runCommandName,
  withRunClaim,
} from './with-env.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let registryDir: string;
let inheritedRunClaim: string | undefined;

beforeEach(async () => {
  registryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'with-env-claim-'));
  inheritedRunClaim = process.env[RUN_CLAIM_ENV];
  process.env[RUN_CLAIM_ENV] = '';
});

afterEach(async () => {
  // Restored as the empty string rather than removed: every reader treats an
  // empty claim variable as no claim, and a computed key cannot be deleted.
  process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
  await fs.rm(registryDir, { recursive: true, force: true });
});

describe('runCommandName', () => {
  it('names the pnpm script the invocation came from', () => {
    expect(runCommandName({ npm_lifecycle_event: 'dev' }, 'turbo')).toBe('pnpm dev');
  });

  it('falls back to the command word when nothing names a script', () => {
    expect(runCommandName({}, 'turbo')).toBe('turbo');
  });
});

describe('withRunClaim', () => {
  function claimThis<T>(body: () => Promise<T>): Promise<T> {
    return withRunClaim(
      { command: 'turbo', mode: 'development', rootDir: REPO_ROOT, registryDir },
      body
    );
  }

  it('makes the invocation visible to whoever asks who is on this slot', async () => {
    vi.stubEnv('npm_lifecycle_event', 'dev');
    vi.stubEnv(STACK_SLOT_VARIABLE, '3');

    const { claimed: live } = await claimThis(() => readSlotLiveness(3, registryDir));

    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ command: 'pnpm dev', mode: 'development', slot: 3 });
    vi.unstubAllEnvs();
  });

  it('leaves nothing on the slot once the invocation has finished', async () => {
    vi.stubEnv(STACK_SLOT_VARIABLE, '3');

    await claimThis(() => Promise.resolve());

    await expect(readSlotLiveness(3, registryDir)).resolves.toEqual({ claimed: [], unknown: [] });
    await expect(enumerateClaims(registryDir)).resolves.toEqual([]);
    vi.unstubAllEnvs();
  });

  it('attributes the claim to this checkout', async () => {
    const [found] = await claimThis(() => enumerateClaims(registryDir));

    expect(found?.claim.gitCommonDir).toContain('.git');
  });

  it('publishes the very checkout it attributed the claim to', async () => {
    const [published, claims] = await claimThis(
      async () => [process.env[CLONE_DIR_VARIABLE], await enumerateClaims(registryDir)] as const
    );

    expect(published).toBe(claims[0]?.claim.gitCommonDir);
  });

  it('adopts the run it was launched inside rather than registering a second', async () => {
    const claims = await registerRun(
      {
        command: 'pnpm e2e',
        mode: 'e2e',
        slot: 0,
        gitCommonDir: path.join(registryDir, 'checkout', '.git'),
        registryDir,
      },
      () => claimThis(() => enumerateClaims(registryDir))
    );

    expect(claims).toHaveLength(1);
    expect(claims[0]?.claim.command).toBe('pnpm e2e');
  });

  it('runs the command outside a checkout, saying why nothing can own what it creates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'with-env-no-checkout-'));

    const ran = await withRunClaim(
      { command: 'turbo', mode: 'development', rootDir: outside, registryDir },
      () => Promise.resolve('ran')
    );

    expect(ran).toBe('ran');
    expect(await enumerateClaims(registryDir)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a git checkout'));
    warn.mockRestore();
    await fs.rm(outside, { recursive: true, force: true });
  });
});

describe('hostPortsForRun', () => {
  it('claims every host port of the band the run loaded', () => {
    expect(hostPortsForRun(3, 'development')).toContain(
      portFor('vite', { slot: 3, mode: 'development' })
    );
  });

  it('leaves the other mode band to the run that binds it', () => {
    expect(hostPortsForRun(3, 'development')).not.toContain(
      portFor('vite', { slot: 3, mode: 'e2e' })
    );
  });

  it('leaves another slot alone entirely', () => {
    expect(hostPortsForRun(3, 'development')).not.toContain(
      portFor('vite', { slot: 4, mode: 'development' })
    );
  });

  it('leaves a container-published port to the container claim that can free it', () => {
    expect(hostPortsForRun(3, 'development')).not.toContain(
      portFor('postgres', { slot: 3, mode: 'development' })
    );
  });

  it('leaves the idle daemon its sentinel, which outlives every run', () => {
    expect(hostPortsForRun(3, 'development')).not.toContain(
      portFor('idleDaemon', { slot: 3, mode: 'development' })
    );
  });

  it('names each port once', () => {
    const ports = hostPortsForRun(3, 'development');
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe('runCommand', () => {
  it('claims the ports it was given against the run, before the command runs', async () => {
    const ports = hostPortsForRun(3, 'development');

    const claims = await registerRun(
      {
        command: 'pnpm dev',
        mode: 'development',
        slot: 3,
        gitCommonDir: path.join(registryDir, 'checkout', '.git'),
        registryDir,
      },
      async () => {
        await runCommand(process.execPath, ['-e', ''], ports);
        return enumerateClaims(registryDir);
      }
    );

    // Compared as a set: each resource is its own entry file, and nothing
    // orders one entry against another. Ports only, because a run that spawns
    // also claims the socket file it answers its children on, and this case is
    // about the ports it was handed.
    const claimed = claims[0]?.claim.resources ?? [];
    expect(
      new Set(claimed.filter((resource) => resource.kind === 'port').map((resource) => resource.id))
    ).toEqual(new Set(ports.map(String)));
  });
});
