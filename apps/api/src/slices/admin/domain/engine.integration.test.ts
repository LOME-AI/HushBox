import { and, eq, like } from 'drizzle-orm';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb, idempotencyKeys } from '@hushbox/db';
import { err, errAsync, ok, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { createAdminStores } from '../adapters/stores.js';
import { createAdminOpEngine, resolveClaimForExecute } from './engine.js';
import { describeAdminOp } from './describe-admin-op.js';
import {
  FIXTURE_AMOUNT_CAP_NANO_USD,
  createAdminFixtureRegistry,
  fixtureLookContract,
  fixtureMarkContract,
  fixturePingContract,
  fixtureUnmarkContract,
} from './fixture-ops.js';
import { READ_AUDIT_ACTIONS } from './read-audit.js';
import { createAdminOpRegistry, defineAdminReadOp } from './registry.js';
import { withUndoReason } from './undo-round-trip.js';
import { createJobWakeCollector, grantJobWakes, jobWakesOf } from '../../../lib/jobs/index.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import type { AdminOpContract } from '@hushbox/shared';
import type { DbTransaction } from '../../../lib/idempotency/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { AdminOpEngineHooks } from './engine.js';
import type {
  AdminOpHarnessInstance,
  AdminOpInterleavingAction,
  AdminOpInterleavingConfig,
  SeededRng,
} from './describe-admin-op.js';
import type { AdminFixtureDeps, AdminFixturePostDeps, AdminFixtureScratch } from './fixture-ops.js';
import type { AdminMutationOpImplementation } from './registry.js';
import type { JobShard } from '../../../lib/jobs/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin engine integration tests');
}

/** Stands in for the request boundary's collector: what an op must merge into. */
const boundaryWakes = createJobWakeCollector();
const db = grantJobWakes(createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }), boundaryWakes);
// A second client (its own connection) for the fence-steal rival: the main
// client's connection is held by the in-flight settlement transaction.
const rival = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const stores = createAdminStores();

interface RecordingTelemetry {
  readonly telemetry: Telemetry;
  readonly capturedCodes: string[];
}

function createRecordingTelemetry(): RecordingTelemetry {
  const capturedCodes: string[] = [];
  const noop = (): void => undefined;
  return {
    capturedCodes,
    telemetry: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      captureError: (_error, errorCode) => {
        capturedCodes.push(errorCode);
      },
    },
  };
}

const fixtureRoutes: string[] = [];

/** Durable scratch effect: one idempotency_keys row per marked target under
 * a per-harness route (the same scratch-row trick the idempotency wrapper's
 * own integration tests use — no FKs, trivially observable). */
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

interface FixtureHarness extends AdminOpHarnessInstance {
  readonly deps: AdminFixtureDeps;
  readonly postDeps: AdminFixturePostDeps;
  readonly recording: RecordingTelemetry;
  readonly route: string;
}

function createFixtureHarness(options: { hooks?: AdminOpEngineHooks } = {}): FixtureHarness {
  const route = `/admin-fixture/${crypto.randomUUID()}`;
  fixtureRoutes.push(route);
  const actor = `admin-engine-test-${crypto.randomUUID()}@hushbox.ai`;
  const deps: AdminFixtureDeps = { scratch: createScratch(route) };
  const postDeps: AdminFixturePostDeps = {
    ephemeralLog: [],
    ephemeralFailure: { armed: false },
  };
  const recording = createRecordingTelemetry();
  const engine = createAdminOpEngine({
    db,
    registry: createAdminFixtureRegistry(),
    stores,
    telemetry: recording.telemetry,
    opDeps: deps,
    postDeps,
    executorId: `admin-engine-test-${crypto.randomUUID()}`,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  });
  return {
    engine,
    actor,
    deps,
    postDeps,
    recording,
    route,
    projection: async (): Promise<readonly string[]> => {
      const rows = await db
        .select({ key: idempotencyKeys.key })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.route, route));
      return rows.map((row) => row.key).toSorted((a, b) => a.localeCompare(b));
    },
    auditCount: async (): Promise<number> => {
      const rows = await db
        .select({ id: adminAudit.id })
        .from(adminAudit)
        .where(eq(adminAudit.actor, actor));
      return rows.length;
    },
    ephemeral: {
      log: () => postDeps.ephemeralLog,
      armFailure: () => {
        postDeps.ephemeralFailure.armed = true;
      },
    },
  };
}

afterAll(async () => {
  // admin_audit is append-only by trigger — audit rows stay (actor-isolated);
  // the scratch and engine-claim key rows are removed.
  for (const route of fixtureRoutes) {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.route, route));
  }
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/fixture.%'));
});

function validMarkInput(): Record<string, unknown> {
  return {
    targetId: crypto.randomUUID(),
    amountNanoUsd: '1000',
    reason: 'engine integration test',
  };
}

/** The scratch write the op body makes, made here directly: a seeded action
 * stands for a user or system act, never a second admin op, so it goes to the
 * same row without the engine, the audit row or the claim. */
async function markDirectly(route: string, targetId: string): Promise<void> {
  await db.insert(idempotencyKeys).values({
    userId: targetId,
    route,
    key: targetId,
    kind: 'request',
    bodyHash: 'fixture',
    claimedBy: 'fixture',
  });
}

async function unmarkDirectly(route: string, targetId: string): Promise<void> {
  await db
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.route, route), eq(idempotencyKeys.key, targetId)));
}

function routeOf(harness: AdminOpHarnessInstance): string {
  return (harness as FixtureHarness).route;
}

/**
 * Every seeded action's target starts with this block and neither battery's own
 * target does, so an interleaved action can never mark or unmark the row under
 * test — which is what lets the op run and the control run reach the same
 * projection.
 */
const NOISE_TARGET_BLOCK = '0000000a';

/** Hex drawn only from the seeded stream, so both runs derive the same targets. */
function seededHex(rng: SeededRng, digits: number): string {
  let hex = '';
  while (hex.length < digits) {
    hex += Math.floor(rng() * 65_536)
      .toString(16)
      .padStart(4, '0');
  }
  return hex.slice(0, digits);
}

/** A v4-shaped uuid the fixture input schema accepts, drawn entirely from the seed. */
function seededNoiseTarget(rng: SeededRng): string {
  return [
    NOISE_TARGET_BLOCK,
    seededHex(rng, 4),
    `4${seededHex(rng, 3)}`,
    `8${seededHex(rng, 3)}`,
    seededHex(rng, 12),
  ].join('-');
}

/** The marked noise rows, in the projection's own order — identical in the op
 * and control runs, because the op's target carries no noise block. */
async function markedNoiseTargets(harness: AdminOpHarnessInstance): Promise<readonly string[]> {
  const projected = (await harness.projection()) as readonly string[];
  return projected.filter((key) => key.startsWith(NOISE_TARGET_BLOCK));
}

const fixtureInterleavingActions: readonly AdminOpInterleavingAction[] = [
  {
    name: 'user-marks-another-target',
    run: (harness, rng) => markDirectly(routeOf(harness), seededNoiseTarget(rng)),
  },
  {
    name: 'user-unmarks-a-marked-target',
    run: async (harness, rng) => {
      const marked = await markedNoiseTargets(harness);
      // One draw either way, so an empty set never slips the two runs' streams.
      const chosen = marked[Math.floor(rng() * marked.length)];
      if (chosen !== undefined) {
        await unmarkDirectly(routeOf(harness), chosen);
      }
    },
  },
];

/** The battery's own Iron Law run. Shallower than a registered op's: the fixture
 * pair proves the machinery, and the ops carry the deeper seeded coverage. */
function fixtureInterleaving(targetId: string): AdminOpInterleavingConfig {
  return {
    // Both seeds mark, unmark, and leave marked noise standing, so the
    // post-undo equality compares a non-empty projection.
    seeds: [5, 7],
    stepsPerSeed: 4,
    opInput: () => ({ targetId, amountNanoUsd: '1000', reason: 'interleaved fixture run' }),
    actions: fixtureInterleavingActions,
  };
}

/** Fixed, so the op run and the control run project the same rows. */
const MARK_INTERLEAVING_TARGET = '11111111-1111-4111-8111-111111111111';

// The reusable battery, proven against the durable fixture pair…
describeAdminOp({
  contract: fixtureMarkContract,
  createHarness: (options) => Promise.resolve(createFixtureHarness(options)),
  validInput: validMarkInput,
  invalidInput: { targetId: 'not-a-uuid', amountNanoUsd: '1000', reason: 'x' },
  overGuardrailInput: () => ({
    targetId: crypto.randomUUID(),
    amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
    reason: 'over the cap',
  }),
  hasEphemeralEffects: true,
  interleaving: fixtureInterleaving(MARK_INTERLEAVING_TARGET),
});

// …and against the ephemeral fixture op (no inverse, post-commit effect only).
describeAdminOp({
  contract: fixturePingContract,
  createHarness: (options) => Promise.resolve(createFixtureHarness(options)),
  validInput: () => ({ targetId: crypto.randomUUID(), reason: 'ping test' }),
  invalidInput: { targetId: 'not-a-uuid', reason: 'x' },
  hasEphemeralEffects: true,
});

// …and against the inverse direction (unmark), whose harness pre-marks the
// target so undo (re-mark) nets the projection back to the marked baseline. The
// pre-marked target is fixed rather than minted per harness because it lands in
// the projection, which the Iron Law case compares across two fresh harnesses;
// each harness owns a distinct route, so the scratch row stays isolated.
const UNMARK_TARGET = '22222222-2222-4222-8222-222222222222';
describeAdminOp({
  contract: fixtureUnmarkContract,
  createHarness: async (options) => {
    const harness = createFixtureHarness(options);
    await markDirectly(harness.route, UNMARK_TARGET);
    return harness;
  },
  validInput: () => ({
    targetId: UNMARK_TARGET,
    amountNanoUsd: '1000',
    reason: 'unmark test',
  }),
  invalidInput: { targetId: 'not-a-uuid', amountNanoUsd: '1000', reason: 'x' },
  overGuardrailInput: () => ({
    targetId: UNMARK_TARGET,
    amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
    reason: 'over the cap',
  }),
  interleaving: fixtureInterleaving(UNMARK_TARGET),
});

describe('createAdminOpEngine.run', () => {
  it('refuses an unregistered op name', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.unknown',
      input: {},
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('not_found');
  });

  it('requires an idempotency key in execute mode', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
    });

    expect(result.isErr() && result.error.code).toBe('validation');
  });

  it('passes an op-body domain refusal through and commits nothing', async () => {
    const harness = createFixtureHarness();
    const input = validMarkInput();
    const first = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(first.isOk()).toBe(true);

    // Same target, fresh key: the op body itself refuses (already marked).
    const second = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(second.isErr() && second.error.code).toBe('conflict');
    expect(await harness.auditCount()).toBe(1);
    expect(await harness.projection()).toEqual([input['targetId']]);
  });

  it('refuses a reused key with a different body', async () => {
    const harness = createFixtureHarness();
    const key = crypto.randomUUID();
    const first = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: key,
    });
    expect(first.isOk()).toBe(true);

    const second = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: key,
    });

    expect(second.isErr() && second.error.code).toBe('conflict');
  });

  it('audits the guardrail refusal with the violated field', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: {
        targetId: crypto.randomUUID(),
        amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
        reason: 'over the cap',
      },
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
    const rows = await db.select().from(adminAudit).where(eq(adminAudit.actor, harness.actor));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toMatchObject({ refusal: 'amountNanoUsd exceeds maxAmountNanoUsd' });
  });

  it('records one refusal row however often the refused request is retried', async () => {
    const harness = createFixtureHarness();
    const input = {
      targetId: crypto.randomUUID(),
      amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
      reason: 'over the cap',
    };
    const idempotencyKey = crypto.randomUUID();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await harness.engine.run({
        name: 'fixture.mark',
        input,
        actor: harness.actor,
        mode: 'execute',
        role: 'operator',
        idempotencyKey,
      });
      expect(result.isErr() && result.error.code).toBe('forbidden');
    }

    expect(await harness.auditCount()).toBe(1);
  });

  it('captures a failed ephemeral effect without failing the op', async () => {
    const harness = createFixtureHarness();
    harness.postDeps.ephemeralFailure.armed = true;

    const result = await harness.engine.run({
      name: 'fixture.ping',
      input: { targetId: crypto.randomUUID(), reason: 'ping' },
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isOk()).toBe(true);
    expect(harness.recording.capturedCodes).toEqual(['admin_ephemeral_effect_failed']);
  });

  it('rejects a read-kind contract wired to a mutation body at registry construction', () => {
    const readContract: AdminOpContract = {
      name: 'fixture.read',
      title: 'Fixture read',
      kind: 'read',
      input: z.object({}),
      inverse: null,
      effectClass: 'ephemeral',
      target: null,
      allowedRoles: ['operator'],
    };
    const implementation: AdminMutationOpImplementation<Record<string, never>> = {
      contract: readContract,
      execute: () => Promise.resolve(ok({ effects: [] })),
    };

    expect(() => createAdminOpRegistry([implementation])).toThrow(/registers no read body/);
  });

  it('rejects a durable op returning no inverseInput as a defect (Iron Law)', async () => {
    const engine = craftedDurableEngine(() => Promise.resolve(ok({ effects: [{ label: 'x' }] })));

    await expect(
      engine.run({
        name: 'fixture.lawless',
        input: { targetId: crypto.randomUUID(), reason: 'x' },
        actor: 'defect@hushbox.ai',
        mode: 'preview',
        role: 'operator',
      })
    ).rejects.toThrow(/inverseInput/);
  });

  it('rejects an op that authors a reason inside its inverseInput as a defect', async () => {
    const engine = craftedDurableEngine(() =>
      Promise.resolve(ok({ effects: [{ label: 'x' }], inverseInput: { reason: 'undo of x' } }))
    );

    await expect(
      engine.run({
        name: 'fixture.lawless',
        input: { targetId: crypto.randomUUID(), reason: 'x' },
        actor: 'defect@hushbox.ai',
        mode: 'preview',
        role: 'operator',
      })
    ).rejects.toThrow(/authored a reason/);
  });

  it('commits nothing when an executed op authors a reason inside its inverseInput', async () => {
    const actor = `admin-authored-reason-${crypto.randomUUID()}@hushbox.ai`;
    const engine = craftedDurableEngine(() =>
      Promise.resolve(ok({ effects: [{ label: 'x' }], inverseInput: { reason: 'undo of x' } }))
    );

    await expect(
      engine.run({
        name: 'fixture.lawless',
        input: { targetId: crypto.randomUUID(), reason: 'x' },
        actor,
        mode: 'execute',
        role: 'operator',
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/authored a reason/);

    const rows = await db
      .select({ id: adminAudit.id })
      .from(adminAudit)
      .where(eq(adminAudit.actor, actor));
    expect(rows).toHaveLength(0);
  });

  it('rejects non-JSON audit details as a defect', async () => {
    const engine = craftedDurableEngine(() =>
      Promise.resolve(
        ok({
          effects: [{ label: 'x' }],
          inverseInput: { amount: 5n as unknown as string },
        })
      )
    );

    await expect(
      engine.run({
        name: 'fixture.lawless',
        input: { targetId: crypto.randomUUID(), reason: 'x' },
        actor: 'defect@hushbox.ai',
        mode: 'preview',
        role: 'operator',
      })
    ).rejects.toThrow(/non-JSON audit details/);
  });

  it('previews a crafted op with no declared target (nullable audit target)', async () => {
    const engine = craftedDurableEngine(() =>
      Promise.resolve(ok({ effects: [{ label: 'targetless' }], inverseInput: {} }))
    );

    const result = await engine.run({
      name: 'fixture.lawless',
      input: { targetId: crypto.randomUUID(), reason: 'x' },
      actor: 'defect@hushbox.ai',
      mode: 'preview',
      role: 'operator',
    });

    expect(result.isOk() && result.value.effects).toEqual([{ label: 'targetless' }]);
  });

  it('answers in-progress when a rival steals the completion fence mid-run', async () => {
    const key = crypto.randomUUID();
    const scopeRoute = 'admin/ops/fixture.mark';
    const harness = createFixtureHarness({
      hooks: {
        // Runs inside the settlement transaction, before the key-row flip:
        // a rival re-claim bumps `claims`, so the fence write finds 0 rows.
        afterAudit: async () => {
          await rival
            .update(idempotencyKeys)
            .set({ claims: 2, claimedBy: 'rival' })
            .where(and(eq(idempotencyKeys.route, scopeRoute), eq(idempotencyKeys.key, key)));
        },
      },
    });
    const before = await harness.projection();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: key,
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    expect(await harness.projection()).toEqual(before);
    expect(await harness.auditCount()).toBe(0);
  });

  it('surfaces an op-body preview refusal as the body’s own error code', async () => {
    const engine = craftedDurableEngine(() =>
      Promise.resolve(err({ code: 'forbidden', message: 'refused by the op body' }))
    );

    const result = await engine.run({
      name: 'fixture.lawless',
      input: { targetId: crypto.randomUUID(), reason: 'x' },
      actor: 'defect@hushbox.ai',
      mode: 'preview',
      role: 'operator',
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
  });
});

describe('undo target validation', () => {
  async function executedMark(harness: FixtureHarness): Promise<{
    auditId: string;
    input: Record<string, unknown>;
    inverseInput: Record<string, unknown>;
  }> {
    const input = validMarkInput();
    const result = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    const value = result._unsafeUnwrap();
    if (value.inverseInput === null) throw new Error('expected a recorded inverse input');
    return { auditId: value.auditId, input, inverseInput: value.inverseInput };
  }

  it('refuses an undo whose op is not the registered inverse of the target action', async () => {
    const harness = createFixtureHarness();
    const { auditId } = await executedMark(harness);

    // fixture.mark's registered inverse is fixture.unmark — running mark
    // itself as the undo is a wrong-op target.
    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: auditId,
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
    expect(await harness.auditCount()).toBe(1);
  });

  it('refuses an undo targeting a guardrail-refusal audit row', async () => {
    const harness = createFixtureHarness();
    const refused = await harness.engine.run({
      name: 'fixture.mark',
      input: {
        targetId: crypto.randomUUID(),
        amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
        reason: 'over the cap',
      },
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(refused.isErr()).toBe(true);
    const rows = await db
      .select({ id: adminAudit.id })
      .from(adminAudit)
      .where(eq(adminAudit.actor, harness.actor));
    const refusalAuditId = rows[0]?.id;
    if (refusalAuditId === undefined) throw new Error('expected a refusal audit row');

    // fixture.unmark IS fixture.mark's registered inverse — only the target
    // row's shape (a refusal, no executed effect) makes this undo invalid.
    const result = await harness.engine.run({
      name: 'fixture.unmark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: refusalAuditId,
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
    expect(await harness.auditCount()).toBe(1);
  });

  it('refuses an undo of a nonexistent audit id with the typed not-found error', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.unmark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('not_found');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses a malformed undo target id as validation, never a database defect', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.unmark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: 'not-a-uuid',
    });

    expect(result.isErr() && result.error.code).toBe('validation');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses an undo whose input differs from the recorded inverse input', async () => {
    const harness = createFixtureHarness();
    const { auditId, input, inverseInput } = await executedMark(harness);

    const result = await harness.engine.run({
      name: 'fixture.unmark',
      // One retyped field is enough: the operator re-aims the inverse at a
      // different target while the audit row still reads "undo of that row".
      input: withUndoReason(
        { ...inverseInput, targetId: crypto.randomUUID() },
        'reverting: this mark was never approved'
      ),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: auditId,
    });

    expect(result.isErr() && result.error.code).toBe('conflict');
    // Nothing ran: the mark still stands and no second audit row exists.
    expect(await harness.projection()).toEqual([input['targetId']]);
    expect(await harness.auditCount()).toBe(1);
  });

  it('permits an undo whose input matches the recorded inverse input', async () => {
    const harness = createFixtureHarness();
    const { auditId, inverseInput } = await executedMark(harness);

    const result = await harness.engine.run({
      name: 'fixture.unmark',
      input: withUndoReason(inverseInput, 'reverting: the mark was premature'),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: auditId,
    });

    expect(result.isOk()).toBe(true);
    expect(await harness.projection()).toEqual([]);
  });

  it('permits an undo whose input differs from the recorded inverse input only in reason', async () => {
    const harness = createFixtureHarness();
    const { auditId, inverseInput } = await executedMark(harness);
    const operatorReason = 'reverting: the mark went on the wrong account';

    const result = await harness.engine.run({
      name: 'fixture.unmark',
      input: { ...inverseInput, reason: operatorReason },
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: auditId,
    });

    expect(result.isOk()).toBe(true);
    const rows = await db.select().from(adminAudit).where(eq(adminAudit.undoes, auditId));
    expect(rows[0]?.details).toMatchObject({ input: { reason: operatorReason } });
  });

  it('permits an undo of a row whose recorded inverse input carries a reason', async () => {
    const harness = createFixtureHarness();
    const targetId = crypto.randomUUID();
    await db.insert(idempotencyKeys).values({
      userId: targetId,
      route: harness.route,
      key: targetId,
      kind: 'request',
      bodyHash: 'fixture',
      claimedBy: 'fixture',
    });
    // The shape of every executed row written while op bodies still authored
    // an undo reason: the recorded value must be ignored, never matched.
    const { id: auditId } = await stores.insertAudit(db, {
      actor: harness.actor,
      role: 'operator' as const,
      action: 'fixture.mark',
      details: {
        effects: [],
        inverseInput: {
          targetId,
          amountNanoUsd: '1000',
          reason: `undo of fixture.mark on ${targetId}`,
        },
      },
    });

    const result = await harness.engine.run({
      name: 'fixture.unmark',
      input: { targetId, amountNanoUsd: '1000', reason: 'reverting: duplicate mark' },
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: auditId,
    });

    expect(result.isOk()).toBe(true);
    expect(await harness.projection()).toEqual([]);
  });

  it('permits undoing an undo row — redo via the inverse chain', async () => {
    const harness = createFixtureHarness();
    const { auditId, input, inverseInput } = await executedMark(harness);
    const undone = await harness.engine.run({
      name: 'fixture.unmark',
      input: withUndoReason(inverseInput, 'reverting: marked the wrong target'),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: auditId,
    });
    const undoResult = undone._unsafeUnwrap();
    const undoAuditId = undoResult.auditId;

    const redone = await harness.engine.run({
      name: 'fixture.mark',
      input: withUndoReason(undoResult.inverseInput ?? {}, 'my reversal was the mistake'),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
      undoes: undoAuditId,
    });

    expect(redone.isOk()).toBe(true);
    expect(await harness.projection()).toEqual([input['targetId']]);
    expect(await harness.auditCount()).toBe(3);
  });
});

describe('undo target in the op context', () => {
  /** Runs a crafted forward op to completion, then its registered inverse as
   * an undo of that row, collecting the `ctx.undoes` each body saw. */
  async function craftedUndoRun(
    mode: 'preview' | 'execute'
  ): Promise<{ seen: readonly (string | undefined)[]; auditId: string }> {
    const seen: (string | undefined)[] = [];
    const targetId = crypto.randomUUID();
    const engine = craftedDurableEngine(
      (ctx) => {
        seen.push(ctx.undoes);
        return Promise.resolve(ok({ effects: [{ label: 'crafted' }], inverseInput: { targetId } }));
      },
      (ctx) => {
        seen.push(ctx.undoes);
        return Promise.resolve(ok({ effects: [{ label: 'inverse' }], inverseInput: {} }));
      }
    );
    const forward = await engine.run({
      name: 'fixture.lawless',
      input: { targetId, reason: 'forward run' },
      actor: 'defect@hushbox.ai',
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    const { auditId } = forward._unsafeUnwrap();
    const undone = await engine.run({
      name: 'fixture.lawless-inverse',
      input: { targetId, reason: 'operator undo words' },
      actor: 'defect@hushbox.ai',
      mode,
      role: 'operator',
      ...(mode === 'execute' ? { idempotencyKey: crypto.randomUUID() } : {}),
      undoes: auditId,
    });
    undone._unsafeUnwrap();
    return { seen, auditId };
  }

  it('leaves the op body no undo target on a forward run', async () => {
    const { seen } = await craftedUndoRun('execute');

    expect(seen[0]).toBeUndefined();
  });

  it('gives the op body the undo target id when executing an undo', async () => {
    const { seen, auditId } = await craftedUndoRun('execute');

    expect(seen[1]).toBe(auditId);
  });

  it('gives the op body the undo target id when previewing an undo', async () => {
    const { seen, auditId } = await craftedUndoRun('preview');

    expect(seen[1]).toBe(auditId);
  });
});

describe('audit details input shape', () => {
  it('stores only the contract schema’s known input keys in the executed audit row', async () => {
    const harness = createFixtureHarness();
    const base = validMarkInput();
    const input = { ...base, sneaky: 'unvalidated payload' };

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isOk()).toBe(true);
    const rows = await db
      .select({ details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.actor, harness.actor));
    const details = rows[0]?.details as { input: Record<string, unknown> };
    expect(details.input).not.toHaveProperty('sneaky');
    expect(details.input).toMatchObject({
      targetId: base['targetId'],
      amountNanoUsd: '1000',
      reason: 'engine integration test',
    });
  });

  it('stores only known input keys in a guardrail-refusal audit row', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: {
        targetId: crypto.randomUUID(),
        amountNanoUsd: (FIXTURE_AMOUNT_CAP_NANO_USD + 1n).toString(),
        reason: 'over the cap',
        sneaky: 'unvalidated payload',
      },
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr()).toBe(true);
    const rows = await db
      .select({ details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.actor, harness.actor));
    const details = rows[0]?.details as { input: Record<string, unknown> };
    expect(details.input).not.toHaveProperty('sneaky');
    expect(details.input).toHaveProperty('reason', 'over the cap');
  });
});

describe('resolveClaimForExecute', () => {
  it('throws on an attach outcome (request-kind claims never attach)', () => {
    const row = { id: crypto.randomUUID(), claims: 1 } as never;

    expect(() => resolveClaimForExecute({ outcome: 'attach', row }, 'executor')).toThrow(/attach/);
  });
});

/** A durable pair whose primary body is crafted per test (defect probes).
 * `target` is crafted too: these contracts are raw literals that bypass
 * `defineAdminOpContract`, which is what lets a probe declare one the input
 * cannot satisfy. */
function craftedDurableEngine(
  execute: AdminMutationOpImplementation<Record<string, never>>['execute'],
  inverseExecute: AdminMutationOpImplementation<Record<string, never>>['execute'] = () =>
    Promise.resolve(ok({ effects: [{ label: 'inverse' }], inverseInput: {} })),
  target: AdminOpContract['target'] = null
): ReturnType<typeof createAdminOpEngine<Record<string, never>>> {
  const reason = z.string().trim().min(1);
  const input = z.object({ targetId: z.uuid(), reason });
  const lawless: AdminOpContract = {
    name: 'fixture.lawless',
    title: 'Crafted durable op',
    kind: 'mutation',
    input,
    inverse: 'fixture.lawless-inverse',
    effectClass: 'durable',
    target,
    allowedRoles: ['operator'],
  };
  const inverse: AdminOpContract = {
    name: 'fixture.lawless-inverse',
    title: 'Crafted inverse',
    kind: 'mutation',
    input,
    inverse: 'fixture.lawless',
    effectClass: 'durable',
    target: null,
    allowedRoles: ['operator'],
  };
  return createAdminOpEngine({
    db,
    registry: createAdminOpRegistry<Record<string, never>>([
      { contract: lawless, execute },
      { contract: inverse, execute: inverseExecute },
    ]),
    stores,
    telemetry: createRecordingTelemetry().telemetry,
    opDeps: {},
    postDeps: {},
    executorId: 'crafted-test',
  });
}

interface AuditedAction {
  readonly action: string;
  readonly details: unknown;
}

async function auditedActions(actor: string): Promise<AuditedAction[]> {
  return db
    .select({ action: adminAudit.action, details: adminAudit.details })
    .from(adminAudit)
    .where(eq(adminAudit.actor, actor));
}

async function auditedTargets(
  actor: string
): Promise<{ targetType: string | null; targetId: string | null }[]> {
  return db
    .select({ targetType: adminAudit.targetType, targetId: adminAudit.targetId })
    .from(adminAudit)
    .where(eq(adminAudit.actor, actor));
}

describe('a preview leaves a read-audit record', () => {
  it('records the preview even though the op body and its audit row roll back', async () => {
    const harness = createFixtureHarness();
    const before = await harness.projection();

    const previewed = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(previewed.isOk()).toBe(true);

    // The op's own action is absent — the settlement transaction rolled back,
    // which is what makes preview safe — and the surviving row is the
    // read-audit one, written on the request connection outside it.
    expect(await auditedActions(harness.actor)).toEqual([
      { action: READ_AUDIT_ACTIONS.opPreview, details: expect.anything() },
    ]);
    expect(await harness.projection()).toEqual(before);
  });

  it('names the previewed op and its wire input on that row', async () => {
    const harness = createFixtureHarness();
    const input = validMarkInput();

    const previewed = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(previewed.isOk()).toBe(true);

    const [row] = await auditedActions(harness.actor);
    expect(row?.details).toEqual({ op: 'fixture.mark', input });
  });

  it('records a preview whose op body refused, so a refused read is still on the record', async () => {
    const engine = craftedDurableEngine(() =>
      Promise.resolve(err({ code: 'forbidden', message: 'refused by the op body' }))
    );
    const actor = `admin-engine-preview-refused-${crypto.randomUUID()}@hushbox.ai`;

    const refused = await engine.run({
      name: 'fixture.lawless',
      input: { targetId: crypto.randomUUID(), reason: 'x' },
      actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(refused.isErr()).toBe(true);

    const audited = await auditedActions(actor);
    expect(audited.map((row) => row.action)).toEqual([READ_AUDIT_ACTIONS.opPreview]);
  });

  it('leaves an execute writing only the op’s own audit row', async () => {
    const harness = createFixtureHarness();

    const executed = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'operator',
      idempotencyKey: crypto.randomUUID(),
    });
    expect(executed.isOk()).toBe(true);

    const audited = await auditedActions(harness.actor);
    expect(audited.map((row) => row.action)).toEqual(['fixture.mark']);
  });

  it('records the target the operator supplied, read at the field the contract names', async () => {
    const harness = createFixtureHarness();
    const input = validMarkInput();

    const previewed = await harness.engine.run({
      name: 'fixture.mark',
      input,
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(previewed.isOk()).toBe(true);

    expect(await auditedTargets(harness.actor)).toEqual([
      { targetType: 'fixture', targetId: input['targetId'] },
    ]);
  });

  it('leaves both target columns null for an op that declares no target', async () => {
    const actor = `admin-engine-preview-targetless-${crypto.randomUUID()}@hushbox.ai`;
    const engine = craftedDurableEngine(() =>
      Promise.resolve(ok({ effects: [{ label: 'targetless' }], inverseInput: {} }))
    );

    const previewed = await engine.run({
      name: 'fixture.lawless',
      input: { targetId: crypto.randomUUID(), reason: 'x' },
      actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(previewed.isOk()).toBe(true);

    expect(await auditedTargets(actor)).toEqual([{ targetType: null, targetId: null }]);
  });

  it('adds no row for a preview of an op name that is not registered', async () => {
    const harness = createFixtureHarness();
    // The control: one preview by this actor that DOES leave a row, so the
    // unchanged count below is a comparison rather than a blind query.
    const seeded = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(seeded.isOk()).toBe(true);
    expect(await auditedActions(harness.actor)).toHaveLength(1);

    const missing = await harness.engine.run({
      name: 'fixture.absent',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });

    expect(missing.isErr()).toBe(true);
    expect(await auditedActions(harness.actor)).toHaveLength(1);
  });

  it('adds no row for a preview whose input fails contract validation', async () => {
    const harness = createFixtureHarness();
    // The control: one preview by this actor that DOES leave a row, so the
    // unchanged count below is a comparison rather than a blind query.
    const seeded = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });
    expect(seeded.isOk()).toBe(true);
    expect(await auditedActions(harness.actor)).toHaveLength(1);

    const invalid = await harness.engine.run({
      name: 'fixture.mark',
      input: { ...validMarkInput(), targetId: 'not-a-uuid' },
      actor: harness.actor,
      mode: 'preview',
      role: 'operator',
    });

    expect(invalid.isErr()).toBe(true);
    expect(await auditedActions(harness.actor)).toHaveLength(1);
  });

  it('rejects a target declaration the validated input cannot satisfy as a defect', async () => {
    const engine = craftedDurableEngine(
      () => Promise.resolve(ok({ effects: [{ label: 'x' }], inverseInput: {} })),
      undefined,
      { type: 'fixture', field: 'absentId' }
    );

    await expect(
      engine.run({
        name: 'fixture.lawless',
        input: { targetId: crypto.randomUUID(), reason: 'x' },
        actor: 'defect@hushbox.ai',
        mode: 'preview',
        role: 'operator',
      })
    ).rejects.toThrow(/declares target field/);
  });
});

/**
 * Runs one op with the settlement transaction intercepted, collecting a shard
 * through the very handle the op body was given. The capability rides the
 * handle, so this is what shows where an op's enqueue wake ends up — and
 * preview, being execute inside a transaction that always rolls back, must
 * leave none of it behind.
 */
async function collectThroughOpTransaction(
  run: () => Promise<void>,
  shard: JobShard
): Promise<void> {
  const openTransaction = db.transaction.bind(db);
  const spy = vi.spyOn(db, 'transaction').mockImplementation((body) =>
    openTransaction(async (tx) => {
      try {
        return await body(tx);
      } finally {
        // In `finally` because preview's body always throws its rollback
        // sentinel: the collect has to happen on the granted handle either way.
        jobWakesOf(tx)?.collect(shard);
      }
    })
  );
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
}

describe('an admin op and the job-wake capability', () => {
  it('leaves a committed execute op wake on the boundary collector', async () => {
    const harness = createFixtureHarness();

    await collectThroughOpTransaction(async () => {
      const result = await harness.engine.run({
        name: 'fixture.mark',
        input: validMarkInput(),
        actor: harness.actor,
        mode: 'execute',
        role: 'operator',
        idempotencyKey: crypto.randomUUID(),
      });
      expect(result.isOk()).toBe(true);
    }, 'bulk');

    expect(boundaryWakes.shards()).toContain('bulk');
  });

  it('leaves no wake behind when the op runs as a preview', async () => {
    const harness = createFixtureHarness();

    await collectThroughOpTransaction(async () => {
      const result = await harness.engine.run({
        name: 'fixture.mark',
        input: validMarkInput(),
        actor: harness.actor,
        mode: 'preview',
        role: 'operator',
      });
      expect(result.isOk()).toBe(true);
    }, 'default');

    expect(boundaryWakes.shards()).not.toContain('default');
  });
});

/**
 * The engine's role check is the SECOND layer: the route-roles map refuses a
 * viewer before any handler runs, and this refuses again at dispatch, before
 * the settlement transaction opens and before anything is audited.
 */
describe('the engine refuses a role the contract does not list', () => {
  it('answers forbidden without opening the transaction or writing an audit row', async () => {
    const harness = createFixtureHarness();
    const before = await harness.projection();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'growth-viewer',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
    expect(await harness.auditCount()).toBe(0);
    expect(await harness.projection()).toEqual(before);
  });

  it('raises one telemetry event under the registered refusal code', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'execute',
      role: 'growth-viewer',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr()).toBe(true);
    expect(harness.recording.capturedCodes).toEqual([FINGERPRINT_CODES.adminRoleRefused]);
  });

  it('refuses a preview too, leaving not even the read-audit row it would write', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: validMarkInput(),
      actor: harness.actor,
      mode: 'preview',
      role: 'growth-viewer',
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
    expect(await harness.auditCount()).toBe(0);
  });

  it('refuses before input validation, so a refused role learns nothing about the schema', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.mark',
      input: { nonsense: true },
      actor: harness.actor,
      mode: 'execute',
      role: 'growth-viewer',
      idempotencyKey: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('forbidden');
  });
});

describe('the read path', () => {
  function readAttempt(
    harness: FixtureHarness,
    overrides: {
      name?: string;
      input?: Record<string, unknown>;
      role?: 'operator' | 'growth-viewer';
    } = {}
  ): ReturnType<FixtureHarness['engine']['read']> {
    return harness.engine.read({
      name: overrides.name ?? 'fixture.look',
      input: overrides.input ?? { note: 'looking' },
      actor: harness.actor,
      role: overrides.role ?? 'growth-viewer',
    });
  }

  it('answers with the read’s payload and the id of the row it wrote', async () => {
    const harness = createFixtureHarness();

    const result = await readAttempt(harness);

    const run = result._unsafeUnwrap();
    expect(run.kind).toBe('read');
    expect(run.data).toEqual({ note: 'looking' });
    const rows = await db
      .select({ id: adminAudit.id, action: adminAudit.action, details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.actor, harness.actor));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(run.auditId);
    expect(rows[0]?.action).toBe(READ_AUDIT_ACTIONS.opRead);
    expect(rows[0]?.details).toEqual({ op: 'fixture.look', input: { note: 'looking' } });
  });

  it('opens no settlement transaction: no idempotency key row is claimed', async () => {
    const harness = createFixtureHarness();

    const read = await readAttempt(harness);
    expect(read.isOk()).toBe(true);

    const claims = await db
      .select({ id: idempotencyKeys.id })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.route, 'admin/ops/fixture.look'));
    expect(claims).toEqual([]);
  });

  it('records nothing about what the read returned, only what was asked', async () => {
    const harness = createFixtureHarness();

    const read = await readAttempt(harness, { input: { note: 'asked' } });
    expect(read.isOk()).toBe(true);

    const rows = await db
      .select({ details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.actor, harness.actor));
    expect(JSON.stringify(rows[0]?.details)).not.toContain('data');
  });

  it('refuses a role the contract does not list, writing no row', async () => {
    const harness = createFixtureHarness();
    const engine = createAdminOpEngine({
      db,
      registry: createAdminOpRegistry<AdminFixtureDeps>([
        defineAdminReadOp<AdminFixtureDeps, typeof fixtureLookContract.input, unknown>(
          { ...fixtureLookContract, allowedRoles: ['operator'] },
          { read: () => okAsync({}) }
        ),
      ]),
      stores,
      telemetry: harness.recording.telemetry,
      opDeps: harness.deps,
      postDeps: {},
      executorId: 'admin-engine-read-test',
    });

    const result = await engine.read({
      name: 'fixture.look',
      input: {},
      actor: harness.actor,
      role: 'growth-viewer',
    });

    expect(result._unsafeUnwrapErr().code).toBe('forbidden');
    expect(await harness.auditCount()).toBe(0);
    expect(harness.recording.capturedCodes).toEqual([FINGERPRINT_CODES.adminRoleRefused]);
  });

  it('keeps a read whose body then fails on the record, because the row is written first', async () => {
    const harness = createFixtureHarness();
    const engine = createAdminOpEngine({
      db,
      registry: createAdminOpRegistry<AdminFixtureDeps>([
        defineAdminReadOp<AdminFixtureDeps, typeof fixtureLookContract.input, unknown>(
          fixtureLookContract,
          { read: () => errAsync(unavailableError('fixture read is down')) }
        ),
      ]),
      stores,
      telemetry: harness.recording.telemetry,
      opDeps: harness.deps,
      postDeps: {},
      executorId: 'admin-engine-read-test',
    });

    const result = await engine.read({
      name: 'fixture.look',
      input: { note: 'looking' },
      actor: harness.actor,
      role: 'growth-viewer',
    });

    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
    const rows = await db
      .select({ details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.actor, harness.actor));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.details).toEqual({ op: 'fixture.look', input: { note: 'looking' } });
  });

  it('rejects invalid input at the boundary, writing no row', async () => {
    const harness = createFixtureHarness();

    const result = await readAttempt(harness, { input: { note: '' } });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
    expect(await harness.auditCount()).toBe(0);
  });

  it('answers a read name nothing registered with not-found', async () => {
    const harness = createFixtureHarness();

    const result = await readAttempt(harness, { name: 'fixture.absent' });

    expect(result._unsafeUnwrapErr().code).toBe('not_found');
  });

  it('refuses a mutation asked for through the read path', async () => {
    const harness = createFixtureHarness();

    const result = await readAttempt(harness, { name: 'fixture.ping', role: 'operator' });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });

  it('refuses a read asked for through the mutation path, without throwing', async () => {
    const harness = createFixtureHarness();

    const result = await harness.engine.run({
      name: 'fixture.look',
      input: {},
      actor: harness.actor,
      role: 'operator',
      mode: 'preview',
    });

    expect(result._unsafeUnwrapErr().code).toBe('validation');
  });
});
