import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineAdminOpContract } from '@hushbox/shared';
import { LOCAL_NEON_DEV_CONFIG, createDb, idempotencyKeys } from '@hushbox/db';
import { ok } from '../../../lib/result/index.js';
import { createAdminStores } from '../adapters/stores.js';
import { createAdminOpEngine } from './engine.js';
import { createAdminFixtureRegistry } from './fixture-ops.js';
import { createAdminOpRegistry, defineAdminOp } from './registry.js';
import { withUndoReason } from './undo-round-trip.js';
import { createJobWakeCollector, grantJobWakes } from '../../../lib/jobs/index.js';
import type { DbTransaction } from '../../../lib/idempotency/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { AdminFixtureDeps, AdminFixturePostDeps, AdminFixtureScratch } from './fixture-ops.js';
import type { AdminOpEngine, AdminOpExecutedNotice } from './engine.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin engine notification integration tests');
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const stores = createAdminStores();
const scratchRoutes: string[] = [];

afterAll(async () => {
  for (const route of scratchRoutes) {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.route, route));
  }
  await db.$client.end();
});

function createScratch(route: string): AdminFixtureScratch {
  return {
    async markWithinTx(tx, targetId): Promise<'marked' | 'already-marked'> {
      const writer = tx as DbTransaction;
      const existing = await writer
        .select({ id: idempotencyKeys.id })
        .from(idempotencyKeys)
        .where(and(eq(idempotencyKeys.route, route), eq(idempotencyKeys.key, targetId)));
      if (existing.length > 0) return 'already-marked';
      await writer.insert(idempotencyKeys).values({
        userId: targetId,
        route,
        key: targetId,
        kind: 'request',
        bodyHash: 'fixture',
        claimedBy: 'fixture',
      });
      return 'marked';
    },
    async unmarkWithinTx(tx, targetId): Promise<void> {
      const writer = tx as DbTransaction;
      await writer
        .delete(idempotencyKeys)
        .where(and(eq(idempotencyKeys.route, route), eq(idempotencyKeys.key, targetId)));
    },
  };
}

interface NotifyHarness {
  readonly engine: AdminOpEngine;
  readonly actor: string;
  readonly notices: AdminOpExecutedNotice[];
  readonly capturedCodes: string[];
  armNotifierFailure(kind?: 'error' | 'string'): void;
}

function createHarness(): NotifyHarness {
  const route = `/admin-notify-fixture/${crypto.randomUUID()}`;
  scratchRoutes.push(route);
  const actor = `admin-notify-test-${crypto.randomUUID()}@hushbox.ai`;
  const notices: AdminOpExecutedNotice[] = [];
  const capturedCodes: string[] = [];
  const failure: { armed: false | 'error' | 'string' } = { armed: false };
  const deps: AdminFixtureDeps = { scratch: createScratch(route) };
  const postDeps: AdminFixturePostDeps = {
    ephemeralLog: [],
    ephemeralFailure: { armed: false },
  };
  const noop = (): void => undefined;
  const telemetry: Telemetry = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    captureError: (_error, errorCode) => {
      capturedCodes.push(errorCode);
    },
  };
  const engine = createAdminOpEngine({
    db,
    registry: createAdminFixtureRegistry(),
    stores,
    telemetry,
    opDeps: deps,
    postDeps,
    executorId: `admin-notify-test-${crypto.randomUUID()}`,
    onExecuted: (notice): Promise<void> => {
      if (failure.armed === 'error') return Promise.reject(new Error('notifier armed to fail'));
      if (failure.armed === 'string') {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- exercises the engine's non-Error capture path
        return Promise.reject('notifier armed to fail (string)');
      }
      notices.push(notice);
      return Promise.resolve();
    },
  });
  return {
    engine,
    actor,
    notices,
    capturedCodes,
    armNotifierFailure: (kind = 'error') => {
      failure.armed = kind;
    },
  };
}

function markInput(targetId: string): Record<string, unknown> {
  return { targetId, amountNanoUsd: '1000', reason: 'notification wiring test' };
}

describe('admin engine execute notification', () => {
  it('sends exactly one notice per committed execute, carrying the run facts', async () => {
    const harness = createHarness();
    const targetId = crypto.randomUUID();
    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: markInput(targetId),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.isOk()).toBe(true);
    expect(harness.notices).toHaveLength(1);
    const notice = harness.notices[0];
    expect(notice).toMatchObject({
      opName: 'fixture.mark',
      actor: harness.actor,
      reason: 'notification wiring test',
      isUndo: false,
      target: { type: 'fixture', id: targetId },
    });
    expect(notice?.auditId).toBe(result._unsafeUnwrap().auditId);
  });

  it('marks an undo run as isUndo', async () => {
    const harness = createHarness();
    const targetId = crypto.randomUUID();
    const marked = await harness.engine.run({
      name: 'fixture.mark',
      input: markInput(targetId),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    const executed = marked._unsafeUnwrap();
    const undone = await harness.engine.run({
      name: 'fixture.unmark',
      input: withUndoReason(executed.inverseInput ?? {}, 'reverting: wrong account marked'),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: executed.auditId,
    });
    expect(undone.isOk()).toBe(true);
    expect(harness.notices).toHaveLength(2);
    expect(harness.notices[1]?.isUndo).toBe(true);
  });

  it('does not fail the committed op when the notifier throws, and captures the failure', async () => {
    const harness = createHarness();
    harness.armNotifierFailure();
    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: markInput(crypto.randomUUID()),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.isOk()).toBe(true);
    expect(harness.notices).toHaveLength(0);
    expect(harness.capturedCodes).toContain('admin_op_notification_failed');
  });

  it('sends nothing on preview', async () => {
    const harness = createHarness();
    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: markInput(crypto.randomUUID()),
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(result.isOk()).toBe(true);
    expect(harness.notices).toHaveLength(0);
  });

  it('sends nothing on an idempotent replay of the same execute', async () => {
    const harness = createHarness();
    const targetId = crypto.randomUUID();
    const key = crypto.randomUUID();
    const params = {
      name: 'fixture.mark',
      input: markInput(targetId),
      actor: harness.actor,
      mode: 'execute' as const,
      role: 'operator' as const,
      idempotencyKey: key,
    };
    const first = await harness.engine.run(params);
    const replay = await harness.engine.run(params);
    expect(first.isOk()).toBe(true);
    expect(replay.isOk()).toBe(true);
    expect(harness.notices).toHaveLength(1);
  });

  it('sends a targetless notice for an op that names no target', async () => {
    const targetlessContract = defineAdminOpContract({
      name: 'fixture.notifyOnly',
      title: 'Targetless fixture op',
      kind: 'mutation',
      input: z.object({ reason: z.string().trim().min(1) }),
      inverse: null,
      effectClass: 'ephemeral',
      target: null,
      allowedRoles: ['operator'],
    });
    const targetless = defineAdminOp<Record<string, never>, typeof targetlessContract.input>(
      targetlessContract,
      { execute: () => Promise.resolve(ok({ effects: [] })) }
    );
    const notices: AdminOpExecutedNotice[] = [];
    const noop = (): void => undefined;
    const engine = createAdminOpEngine({
      db,
      registry: createAdminOpRegistry([targetless]),
      stores,
      telemetry: {
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        captureError: noop,
      },
      opDeps: {},
      postDeps: {},
      executorId: `admin-notify-test-${crypto.randomUUID()}`,
      onExecuted: (notice): Promise<void> => {
        notices.push(notice);
        return Promise.resolve();
      },
    });
    const result = await engine.run({
      name: 'fixture.notifyOnly',
      input: { reason: 'targetless notice test' },
      actor: `admin-notify-test-${crypto.randomUUID()}@hushbox.ai`,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.isOk()).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.target).toBeUndefined();
  });

  it('captures a notifier that rejects with a non-Error value', async () => {
    const harness = createHarness();
    harness.armNotifierFailure('string');
    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: markInput(crypto.randomUUID()),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(result.isOk()).toBe(true);
    expect(harness.capturedCodes).toContain('admin_op_notification_failed');
  });

  it('sends nothing when the op body fails', async () => {
    const harness = createHarness();
    const targetId = crypto.randomUUID();
    const marked = await harness.engine.run({
      name: 'fixture.mark',
      input: markInput(targetId),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(marked.isOk()).toBe(true);
    harness.notices.length = 0;
    const failed = await harness.engine.run({
      name: 'fixture.mark',
      input: markInput(targetId),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(failed.isErr()).toBe(true);
    expect(harness.notices).toHaveLength(0);
  });
});
