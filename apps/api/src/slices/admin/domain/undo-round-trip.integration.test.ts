import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, like } from 'drizzle-orm';
import { z } from 'zod';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, adminAudit, createDb, idempotencyKeys } from '@hushbox/db';
import { ADMIN_OP_CONTRACTS, ADMIN_OP_NAMES, defineAdminOpContract } from '@hushbox/shared';
import { ok } from '../../../lib/result/index.js';
import { collectAdminOpBatteryCoverage } from './operations/battery-coverage.js';
import { createAdminStores } from '../adapters/stores.js';
import { createAdminOpEngine } from './engine.js';
import { createAdminFixtureRegistry, fixtureMarkContract } from './fixture-ops.js';
import { createAdminOpRegistry, defineAdminOp } from './registry.js';
import { runUndoRoundTrip } from './undo-round-trip.js';
import { createJobWakeCollector, grantJobWakes } from '../../../lib/jobs/index.js';
import type { DbTransaction } from '../../../lib/idempotency/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { AdminFixtureDeps, AdminFixturePostDeps, AdminFixtureScratch } from './fixture-ops.js';
import type { AdminOpContractName } from '@hushbox/shared';
import type { AdminOpRegistry } from './registry.js';
import type { UndoRoundTripHarness } from './undo-round-trip.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for admin undo round-trip tests');
}

const db = grantJobWakes(
  createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
  createJobWakeCollector()
);
const stores = createAdminStores();

const fixtureRoutes: string[] = [];

afterAll(async () => {
  // admin_audit is append-only by trigger; only the scratch and engine-claim
  // key rows are ours to remove.
  for (const route of fixtureRoutes) {
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.route, route));
  }
  await db.delete(idempotencyKeys).where(like(idempotencyKeys.route, 'admin/ops/fixture.%'));
});

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, captureError: noop };
}

/** Durable scratch effect: one idempotency_keys row per marked target under a
 * per-harness route (the same no-FK trick the engine integration test uses). */
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

interface RouteHarness extends UndoRoundTripHarness {
  readonly route: string;
}

/** Wires a fresh engine over `registry` and a per-harness scratch route; the
 * projection is the set of marked target keys, so a durable mark/unmark pair
 * nets to the empty baseline iff the inverse truly restores state. */
function buildRouteHarness<Deps, PostDeps>(
  make: (route: string) => {
    registry: AdminOpRegistry<Deps, PostDeps>;
    opDeps: Deps;
    postDeps: PostDeps;
  }
): RouteHarness {
  const route = `/admin-undo-roundtrip/${crypto.randomUUID()}`;
  fixtureRoutes.push(route);
  const actor = `admin-undo-roundtrip-${crypto.randomUUID()}@hushbox.ai`;
  const { registry, opDeps, postDeps } = make(route);
  const engine = createAdminOpEngine({
    db,
    registry,
    stores,
    telemetry: noopTelemetry(),
    opDeps,
    postDeps,
    executorId: `admin-undo-roundtrip-${crypto.randomUUID()}`,
  });
  return {
    engine,
    actor,
    route,
    projection: async (): Promise<readonly string[]> => {
      const rows = await db
        .select({ key: idempotencyKeys.key })
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.route, route));
      return rows.map((row) => row.key).toSorted((a, b) => a.localeCompare(b));
    },
  };
}

function createFixtureHarness(): RouteHarness {
  return buildRouteHarness<AdminFixtureDeps, AdminFixturePostDeps>((route) => ({
    registry: createAdminFixtureRegistry(),
    opDeps: { scratch: createScratch(route) },
    postDeps: { ephemeralLog: [], ephemeralFailure: { armed: false } },
  }));
}

function validMarkInput(): Record<string, unknown> {
  return { targetId: crypto.randomUUID(), amountNanoUsd: '1000', reason: 'undo round-trip test' };
}

/** Stands in for what an operator types into the undo form. */
const OPERATOR_UNDO_REASON = 'Support call: the customer asked us to put this back.';

const auditedReason = z.object({ input: z.object({ reason: z.string() }) });

/**
 * A deliberately-WRONG durable inverse pair: `broken.mark` marks the scratch,
 * but its registered inverse `broken.unmark` is a no-op that never removes the
 * mark. Its `execute` is otherwise well-formed (non-empty effects + captured
 * inverseInput), so the engine accepts it — only the round-trip harness, by
 * comparing pre-execute and post-undo projections, exposes that state was not
 * restored. This proves the harness catches a wrong inverse.
 */
interface BrokenDeps {
  readonly scratch: AdminFixtureScratch;
}

const brokenReason = z.string().trim().min(1);
const brokenInput = z.object({ targetId: z.uuid(), reason: brokenReason });

const brokenMarkContract = defineAdminOpContract({
  name: 'broken.mark',
  title: 'Broken mark',
  kind: 'mutation',
  input: brokenInput,
  inverse: 'broken.unmark',
  effectClass: 'durable',
  target: null,
  allowedRoles: ['operator'],
});

const brokenUnmarkContract = defineAdminOpContract({
  name: 'broken.unmark',
  title: 'Broken unmark (no-op inverse)',
  kind: 'mutation',
  input: brokenInput,
  inverse: 'broken.mark',
  effectClass: 'durable',
  target: null,
  allowedRoles: ['operator'],
});

function createBrokenRegistry(): AdminOpRegistry<BrokenDeps> {
  const brokenMark = defineAdminOp<BrokenDeps, typeof brokenMarkContract.input>(
    brokenMarkContract,
    {
      async execute(ctx, input) {
        await ctx.deps.scratch.markWithinTx(ctx.tx, input.targetId);
        return ok({
          effects: [{ label: 'broken.marked', before: null, after: input.targetId }],
          target: { type: 'broken', id: input.targetId },
          inverseInput: { targetId: input.targetId },
        });
      },
    }
  );
  const brokenUnmark = defineAdminOp<BrokenDeps, typeof brokenUnmarkContract.input>(
    brokenUnmarkContract,
    {
      execute(_ctx, input) {
        // The bug under test: claims to invert but never removes the mark.
        return Promise.resolve(
          ok({
            effects: [{ label: 'broken.unmarked', before: input.targetId, after: null }],
            target: { type: 'broken', id: input.targetId },
            inverseInput: { targetId: input.targetId },
          })
        );
      },
    }
  );
  return createAdminOpRegistry<BrokenDeps>([brokenMark, brokenUnmark]);
}

function createBrokenHarness(): RouteHarness {
  return buildRouteHarness<BrokenDeps, Record<never, never>>((route) => ({
    registry: createBrokenRegistry(),
    opDeps: { scratch: createScratch(route) },
    postDeps: {},
  }));
}

describe('runUndoRoundTrip', () => {
  it('restores state after undo for a correct durable inverse pair (real engine + real inverse)', async () => {
    const harness = createFixtureHarness();

    const trip = await runUndoRoundTrip(
      harness,
      fixtureMarkContract,
      validMarkInput(),
      OPERATOR_UNDO_REASON
    );

    expect(trip.undone.effects.length).toBeGreaterThan(0);
    expect(trip.afterUndo).toEqual(trip.baseline);
    expect(trip.restored).toBe(true);
  });

  it('commits the operator reason on the undo audit row, not the one the op recorded', async () => {
    const harness = createFixtureHarness();

    const trip = await runUndoRoundTrip(
      harness,
      fixtureMarkContract,
      validMarkInput(),
      OPERATOR_UNDO_REASON
    );

    const rows = await db
      .select({ details: adminAudit.details })
      .from(adminAudit)
      .where(eq(adminAudit.undoes, trip.executed.auditId));
    expect(rows).toHaveLength(1);
    expect(auditedReason.parse(rows[0]?.details).input.reason).toBe(OPERATOR_UNDO_REASON);
  });

  it('flags a deliberately-wrong inverse whose undo does not restore state', async () => {
    const harness = createBrokenHarness();

    const trip = await runUndoRoundTrip(
      harness,
      brokenMarkContract,
      {
        targetId: crypto.randomUUID(),
        reason: 'wrong-inverse probe',
      },
      OPERATOR_UNDO_REASON
    );

    // The undo "succeeded" at the engine, yet the mark survives — the harness's
    // projection comparison is what exposes the broken inverse.
    expect(trip.afterUndo).not.toEqual(trip.baseline);
    expect(trip.restored).toBe(false);
  });
});

/**
 * Registry-driven enforcement: every DURABLE admin op must actually be run
 * through the undo round-trip harness (which `describeAdminOp` does for every
 * durable contract), and every op that skips the harness must say why. A
 * durable op with neither a round-trip fixture nor an exclusion fails the
 * build; a durable op can never be waved through by an exclusion (the
 * Reversibility Iron Law).
 *
 * Only an EPHEMERAL MUTATION is excused here. A `system-owned` op is excused by
 * its contract's own `systemOwnedReason` — the class cannot be declared without
 * one — so restating that justification here would be a second copy free to
 * drift from the contract's. A read is excused by its kind for the same reason:
 * it lands nothing durable because its body takes no settlement transaction at
 * all, which the contract states and an arch rule checks, so an exclusion
 * string per read would be that second copy five times over.
 *
 * The fixture set is derived from the operation test sources the same way
 * battery coverage is: a durable op that ships a `describeAdminOp` battery is
 * run through `runUndoRoundTrip` by that battery's round-trip case.
 */
const UNDO_ROUND_TRIP_EXCLUSIONS: Readonly<Record<string, string>> = {
  'newsletter.testSend':
    'ephemeral-class: sends a preview email to the acting admin only; no durable product state exists afterward',
};

const OPERATIONS_DIR = fileURLToPath(new URL('operations/', import.meta.url));

function operationTestSources(): readonly string[] {
  return readdirSync(OPERATIONS_DIR)
    .filter((file) => file.endsWith('.integration.test.ts'))
    .map((file) => readFileSync(path.join(OPERATIONS_DIR, file), 'utf8'));
}

describe('durable admin op undo round-trip coverage', () => {
  const covered = collectAdminOpBatteryCoverage(operationTestSources());
  const durableOps = ADMIN_OP_NAMES.filter(
    (name) => ADMIN_OP_CONTRACTS[name].effectClass === 'durable'
  );
  const ephemeralOps = ADMIN_OP_NAMES.filter(
    (name) =>
      ADMIN_OP_CONTRACTS[name].effectClass === 'ephemeral' &&
      ADMIN_OP_CONTRACTS[name].kind === 'mutation'
  );
  const readOps = ADMIN_OP_NAMES.filter((name) => ADMIN_OP_CONTRACTS[name].kind === 'read');
  const systemOwnedOps = ADMIN_OP_NAMES.filter(
    (name) => ADMIN_OP_CONTRACTS[name].effectClass === 'system-owned'
  );

  it('gives every durable op a round-trip fixture or a documented exclusion', () => {
    const unenforced = durableOps.filter(
      (name) => !covered.has(name) && UNDO_ROUND_TRIP_EXCLUSIONS[name] === undefined
    );

    expect(unenforced).toEqual([]);
  });

  it('leaves every read justified by its kind, not by an exclusion', () => {
    expect(readOps.length).toBeGreaterThan(0);
    for (const name of readOps) {
      expect(UNDO_ROUND_TRIP_EXCLUSIONS[name], name).toBeUndefined();
    }
  });

  it('documents a justified exclusion for every ephemeral mutation (no undo to prove)', () => {
    const undocumented = ephemeralOps.filter(
      (name) => (UNDO_ROUND_TRIP_EXCLUSIONS[name] ?? '').trim() === ''
    );

    expect(undocumented).toEqual([]);
  });

  it('leaves every system-owned op justified by its own contract, not by a second copy', () => {
    expect(systemOwnedOps.length).toBeGreaterThan(0);
    for (const name of systemOwnedOps) {
      expect((ADMIN_OP_CONTRACTS[name].systemOwnedReason ?? '').trim(), name).not.toBe('');
      expect(UNDO_ROUND_TRIP_EXCLUSIONS[name], name).toBeUndefined();
    }
  });

  it('never lets an exclusion shadow a durable op or name an unknown op', () => {
    for (const [name, reason] of Object.entries(UNDO_ROUND_TRIP_EXCLUSIONS)) {
      expect(ADMIN_OP_NAMES).toContain(name);
      expect(reason.trim().length).toBeGreaterThan(0);
      // A durable op must be inverted for real, never excused by a paper
      // exclusion — only an ephemeral mutation may be excluded, and a read is
      // excused by its kind rather than by a string here.
      expect(ADMIN_OP_CONTRACTS[name as AdminOpContractName].effectClass).toBe('ephemeral');
      expect(ADMIN_OP_CONTRACTS[name as AdminOpContractName].kind).toBe('mutation');
    }
  });
});
