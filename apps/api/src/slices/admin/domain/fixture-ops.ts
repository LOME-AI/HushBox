import { z } from 'zod';
import { NanoUSD, defineAdminOpContract, serializeNanoUSD } from '@hushbox/shared';
import { conflictError } from '../../../lib/errors/index.js';
import { err, ok, okAsync } from '../../../lib/result/index.js';
import { createAdminOpRegistry, defineAdminOp, defineAdminReadOp } from './registry.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { AdminOpRegistry } from './registry.js';

/**
 * Test-only fixture ops proving the engine and the `describeAdminOp` battery
 * end-to-end without a real op (real ops live under `domain/operations/`).
 * A durable inverse pair over a scratch effect, an ephemeral op, and a read;
 * never exported from the slice barrel, never mounted.
 */

/** The scratch durable effect, injected by tests (the port the fixture composes). */
export interface AdminFixtureScratch {
  markWithinTx(tx: SettlementTx, targetId: string): Promise<'marked' | 'already-marked'>;
  unmarkWithinTx(tx: SettlementTx, targetId: string): Promise<void>;
}

export interface AdminFixtureDeps {
  readonly scratch: AdminFixtureScratch;
}

/** What the engine hands a registered effect once the transaction has committed. */
export interface AdminFixturePostDeps {
  /** Post-commit side-channel the ephemeral effects append to. */
  readonly ephemeralLog: string[];
  /** Armed by tests to make every registered ephemeral effect throw. */
  readonly ephemeralFailure: { armed: boolean };
}

/** Guardrail cap exercised by the battery's guardrail-trip case. */
export const FIXTURE_AMOUNT_CAP_NANO_USD = 1_000_000_000n;

const reason = z.string().trim().min(1);

const fixtureInput = z.object({
  targetId: z.uuid(),
  amountNanoUsd: NanoUSD,
  reason,
});

export const fixtureMarkContract = defineAdminOpContract({
  name: 'fixture.mark',
  title: 'Mark fixture target',
  kind: 'mutation',
  input: fixtureInput,
  inverse: 'fixture.unmark',
  effectClass: 'durable',
  target: { type: 'fixture', field: 'targetId' },
  allowedRoles: ['operator'],
  guardrails: { maxAmountNanoUsd: FIXTURE_AMOUNT_CAP_NANO_USD },
});

export const fixtureUnmarkContract = defineAdminOpContract({
  name: 'fixture.unmark',
  title: 'Unmark fixture target',
  kind: 'mutation',
  input: fixtureInput,
  inverse: 'fixture.mark',
  effectClass: 'durable',
  target: { type: 'fixture', field: 'targetId' },
  allowedRoles: ['operator'],
  guardrails: { maxAmountNanoUsd: FIXTURE_AMOUNT_CAP_NANO_USD },
});

export const fixturePingContract = defineAdminOpContract({
  name: 'fixture.ping',
  title: 'Ping fixture target',
  kind: 'mutation',
  input: z.object({ targetId: z.uuid(), reason }),
  inverse: null,
  effectClass: 'ephemeral',
  target: { type: 'fixture', field: 'targetId' },
  allowedRoles: ['operator'],
});

function pushEphemeral(post: AdminFixturePostDeps, entry: string): void {
  if (post.ephemeralFailure.armed) {
    throw new Error('fixture ephemeral effect armed to fail');
  }
  post.ephemeralLog.push(entry);
}

const fixtureMark = defineAdminOp<
  AdminFixtureDeps,
  typeof fixtureMarkContract.input,
  AdminFixturePostDeps
>(fixtureMarkContract, {
  async execute(ctx, input) {
    const marked = await ctx.deps.scratch.markWithinTx(ctx.tx, input.targetId);
    if (marked === 'already-marked') {
      return err(conflictError('fixture target is already marked'));
    }
    ctx.registerEphemeral({
      name: 'fixture.mark.notify',
      run: (post) => {
        pushEphemeral(post, `marked:${input.targetId}`);
        return Promise.resolve();
      },
    });
    return ok({
      effects: [{ label: 'fixture.marked', before: null, after: input.targetId }],
      target: { type: 'fixture', id: input.targetId },
      // Inverse snapshot semantics: captured from execute-time state.
      inverseInput: {
        targetId: input.targetId,
        amountNanoUsd: serializeNanoUSD(input.amountNanoUsd),
      },
    });
  },
});

const fixtureUnmark = defineAdminOp<
  AdminFixtureDeps,
  typeof fixtureUnmarkContract.input,
  AdminFixturePostDeps
>(fixtureUnmarkContract, {
  async execute(ctx, input) {
    await ctx.deps.scratch.unmarkWithinTx(ctx.tx, input.targetId);
    return ok({
      effects: [{ label: 'fixture.unmarked', before: input.targetId, after: null }],
      target: { type: 'fixture', id: input.targetId },
      inverseInput: {
        targetId: input.targetId,
        amountNanoUsd: serializeNanoUSD(input.amountNanoUsd),
      },
    });
  },
});

const fixturePing = defineAdminOp<
  AdminFixtureDeps,
  typeof fixturePingContract.input,
  AdminFixturePostDeps
>(fixturePingContract, {
  execute(ctx, input) {
    ctx.registerEphemeral({
      name: 'fixture.ping.notify',
      run: (post) => {
        pushEphemeral(post, `ping:${input.targetId}`);
        return Promise.resolve();
      },
    });
    return Promise.resolve(
      ok({
        effects: [{ label: 'fixture.pinged', after: input.targetId }],
        target: { type: 'fixture', id: input.targetId },
      })
    );
  },
});

/**
 * The read fixture: its body echoes the note it was handed and touches no
 * state at all, which is what makes it a probe of the engine's read path
 * rather than of a read's data — every assertion driven through it is about
 * what the engine does around a body, never about what a body found.
 */
export const fixtureLookContract = defineAdminOpContract({
  name: 'fixture.look',
  title: 'Echo a fixture note',
  kind: 'read',
  description: 'The note comes back exactly as it was given; this read reaches no state.',
  input: z.object({ note: z.string().min(1).optional() }),
  inverse: null,
  effectClass: 'ephemeral',
  target: null,
  allowedRoles: ['operator', 'growth-viewer'],
});

const fixtureLook = defineAdminReadOp<
  AdminFixtureDeps,
  typeof fixtureLookContract.input,
  { note: string | null }
>(fixtureLookContract, {
  read: (_ctx, input) => okAsync({ note: input.note ?? null }),
});

export function createAdminFixtureRegistry(): AdminOpRegistry<
  AdminFixtureDeps,
  AdminFixturePostDeps
> {
  return createAdminOpRegistry<AdminFixtureDeps, AdminFixturePostDeps>([
    fixtureMark,
    fixtureUnmark,
    fixturePing,
    fixtureLook,
  ]);
}
