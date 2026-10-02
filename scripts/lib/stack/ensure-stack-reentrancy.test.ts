import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ensureStack } from './ensure-stack.js';
import type { EnsureStackDeps, EnsureStackOptions } from './ensure-stack.js';

const SLOT = 13;

/**
 * How long a nested call is given to come back before the test calls it stuck.
 * A call that re-enters the section runs its steps against stubs and answers in
 * microseconds; one that queues behind the lock its own process holds answers
 * only after the outer call has let go, which cannot happen until the outer
 * call returns from here.
 */
const NESTED_BUDGET_MS = 500;

let root = '';
let registryDir = '';

function makeDeps(overrides: Partial<EnsureStackDeps> = {}): EnsureStackDeps {
  return {
    generateEnvFiles: vi.fn(),
    generateComposeFiles: vi.fn(() => []),
    installDeps: vi.fn(async () => {}),
    cleanupOrphans: vi.fn(async () => {}),
    ensureContainersHealthy: vi.fn(async () => {}),
    ensurePostgresAcceptsPassword: vi.fn(async () => {}),
    ensureDatabase: vi.fn(async () => {}),
    runMigrations: vi.fn(async () => {}),
    installDevTracking: vi.fn(async () => {}),
    provisionAdminSqlPanelRole: vi.fn(async () => {}),
    readMeta: vi.fn().mockResolvedValue({ seedHash: '', seededAt: null, dirty: true }),
    markClean: vi.fn(async () => {}),
    composeDown: vi.fn(async () => {}),
    ensureDaemonRunning: vi.fn(async () => {}),
    readDepsHash: vi.fn().mockResolvedValue(null),
    writeDepsHash: vi.fn(async () => {}),
    computeDepsFingerprint: vi.fn().mockResolvedValue('deps-fp'),
    computeMigrationFingerprint: vi.fn().mockResolvedValue('mig-fp'),
    ensureTestTemplate: vi.fn(async () => {}),
    assertNoSchemaDrift: vi.fn(async () => {}),
    reportProgress: vi.fn(),
    auditStackWorld: vi.fn(async () => {}),
    sqlExecutor: { exec: vi.fn(), query: vi.fn() },
    ...overrides,
  };
}

function makeOptions(repoRoot: string): EnsureStackOptions {
  return {
    repoRoot,
    slot: SLOT,
    daemonScriptPath: path.join(repoRoot, 'daemon.ts'),
    idleDaemonPort: 7713,
    // Never the machine-wide registry: a test asking who is live on this slot
    // would otherwise read the runs of whoever is using the machine.
    registryDir,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hb-reentrancy-'));
  registryDir = mkdtempSync(path.join(tmpdir(), 'hb-reentrancy-claims-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(registryDir, { recursive: true, force: true });
});

describe('a nested ensure-stack naming this checkout through a symlink', () => {
  it('runs inside the section this process already holds', async () => {
    const real = path.join(root, 'checkout');
    mkdirSync(real, { recursive: true });
    const linked = path.join(root, 'link');
    symlinkSync(real, linked, 'dir');

    let nested: Promise<void> | undefined;
    let answeredInsideSection = false;

    const outer = makeDeps({
      installDeps: async () => {
        nested = ensureStack(makeOptions(linked), makeDeps());
        answeredInsideSection = await Promise.race([
          nested.then(() => true),
          delay(NESTED_BUDGET_MS).then(() => false),
        ]);
      },
    });

    await ensureStack(makeOptions(real), outer);
    // Drains the nested call whichever way it went: one that queued acquires
    // the section the moment the outer call above releases it.
    await nested;

    expect(answeredInsideSection).toBe(true);
  });
});
