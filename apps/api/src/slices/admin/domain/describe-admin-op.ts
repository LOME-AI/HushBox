import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES } from '@hushbox/shared';
import { runUndoRoundTrip, withUndoReason } from './undo-round-trip.js';
import type { AdminRole, AnyAdminOpContract } from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { Result } from '../../../lib/result/index.js';
import type {
  AdminOpAuditedRun,
  AdminOpEngine,
  AdminOpEngineHooks,
  AdminOpRunResult,
} from './engine.js';

/**
 * The reusable per-op test battery (`describeAdminOp`) — every registered op
 * ships one invocation of this harness; later op tasks parameterize it with
 * their own wiring. It is test tooling that lives beside the engine so the
 * battery and the engine version together; it is imported only by test
 * files and never exported from the slice barrel.
 *
 * Battery (per the slice CLAUDE.md): preview ≡ execute with preview
 * committing nothing; audit atomicity under an injected failure; idempotent
 * replay; guardrail refusal in both modes
 * (audited on execute); input validation; for durable ops — undo produces the inverse effects, threads
 * `undoes`, nets the projection to zero, and a second undo fails the unique
 * claim; ephemeral effects run post-commit only and their failure never
 * fails the op. Every durable op additionally ships the seeded Iron Law
 * interleaving-invariance property test (execute → seeded user actions →
 * undo ≡ the same actions alone) and the concurrent double-execute-one-key
 * race: its `interleaving` config is an obligation this harness refuses to
 * build without, never an opt-in.
 *
 * "Committing nothing" is the projection, not the row count: the engine
 * writes the preview's read-audit record on the request connection, outside
 * the transaction it rolls back, so the battery's preview cases count that
 * one row.
 */

/** Deterministic pseudo-random stream in [0, 1) — the replay artifact is the seed. */
export type SeededRng = () => number;

/** mulberry32: tiny, dependency-free, stable across runtimes. */
export function seededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * One user/system action the Iron Law's `U₁…Uₙ` sequence draws from. Actions
 * must be feasible on any fresh harness whether or not the op ran (the
 * Charter's feasibility rule — never gate on op state), and any randomness
 * must come from the passed rng so the control and op runs consume identical
 * streams.
 */
export interface AdminOpInterleavingAction {
  readonly name: string;
  run(harness: AdminOpHarnessInstance, rng: SeededRng): Promise<void>;
}

/**
 * Config for the seeded interleaving-invariance battery every durable op
 * supplies (its delta must net to zero across interleavings).
 * Harness projections must be comparable across fresh instances (normalized
 * — no per-instance ids), because the Iron Law test compares an op run
 * against a control harness that never ran the op.
 */
export interface AdminOpInterleavingConfig {
  /** Mandated seeds — a failing test names its seed, which replays it exactly. */
  readonly seeds: readonly number[];
  readonly stepsPerSeed: number;
  /** Fresh valid wire-shape input targeting THIS harness's domain state. */
  opInput(harness: AdminOpHarnessInstance): Record<string, unknown>;
  readonly actions: readonly AdminOpInterleavingAction[];
  /** Optional post-condition (e.g. a scoped conservation audit) per run. */
  afterRun?(harness: AdminOpHarnessInstance): Promise<void>;
}

/** Exported for the harness's own unit tests (the guard arms). */
export async function runSeededActions(
  harness: AdminOpHarnessInstance,
  interleaving: AdminOpInterleavingConfig,
  rng: SeededRng
): Promise<void> {
  for (let step = 0; step < interleaving.stepsPerSeed; step += 1) {
    const action = interleaving.actions[Math.floor(rng() * interleaving.actions.length)];
    if (action === undefined) {
      throw new Error('describeAdminOp: interleaving requires at least one action');
    }
    await action.run(harness, rng);
  }
}

export interface AdminOpEphemeralProbes {
  /** The post-commit side-channel the op's ephemeral effects write to. */
  log(): readonly string[];
  /** Makes every subsequent ephemeral effect throw. */
  armFailure(): void;
}

/** One freshly-wired engine plus the probes the battery asserts against. */
export interface AdminOpHarnessInstance {
  readonly engine: AdminOpEngine;
  readonly actor: string;
  /** Effective-state projection over the op's domain (net-zero comparisons). */
  projection(): Promise<unknown>;
  /** Committed audit rows attributable to this instance's actor. */
  auditCount(): Promise<number>;
  /** Required when the op registers post-commit ephemeral effects. */
  readonly ephemeral?: AdminOpEphemeralProbes;
}

interface DescribeAdminOpBattery<C extends AnyAdminOpContract> {
  readonly contract: C;
  /** Fresh, isolated wiring per test (unique actor, empty projection). */
  createHarness(options?: { hooks?: AdminOpEngineHooks }): Promise<AdminOpHarnessInstance>;
  /** Fresh valid wire-shape input (unique target per call). */
  validInput(): Record<string, unknown>;
  readonly invalidInput: Record<string, unknown>;
  /**
   * The over-cap input the guardrail case runs. Optional here and made
   * required by {@link DescribeAdminOpConfig} on a contract whose declared
   * cap survives in its type; a contract declaring no cap is refused for
   * supplying one — see {@link requiredOverGuardrailInput}.
   */
  overGuardrailInput?(): Record<string, unknown>;
  /** Set when the op registers post-commit ephemeral effects. */
  readonly hasEphemeralEffects?: boolean;
  /**
   * The seeded Iron Law interleaving battery. Required of a durable op and
   * refused-as-missing at build time by {@link describeAdminOp}; absent on
   * every other effect class, which names no inverse to round-trip.
   */
  readonly interleaving?: AdminOpInterleavingConfig;
}

/**
 * A battery whose contract declares the cap the engine enforces owes an
 * over-cap input, and owes it at BUILD time — the same obligation
 * {@link requiredOverGuardrailInput} carries at test time, moved as early as
 * the contract's type allows. It reads the cap VALUE, matching both the
 * engine's refusal and the condition {@link describeAdminOp} registers its
 * guardrail case on.
 *
 * The runtime guard is not replaced by this. A config whose contract arrives
 * widened to `AdminOpContract` has no declaration left in its type to read,
 * and the converse — an over-cap input supplied for an op declaring no cap —
 * is not expressible here at all.
 */
export type DescribeAdminOpConfig<C extends AnyAdminOpContract = AnyAdminOpContract> =
  DescribeAdminOpBattery<C> &
    (C extends { readonly guardrails: { readonly maxAmountNanoUsd: bigint } }
      ? { overGuardrailInput(): Record<string, unknown> }
      : unknown);

/**
 * Classifies a concurrent same-key double-execute: a loser may only be the
 * in-progress conflict; a late arrival replays the winner's stored result.
 * Exported for the harness's own unit tests (the race outcome is
 * nondeterministic in vivo, so the guard arms are covered directly).
 */
export function winnerOfConcurrentRace(
  results: readonly Result<AdminOpRunResult, DomainError>[]
): AdminOpRunResult {
  const committed: AdminOpRunResult[] = [];
  for (const result of results) {
    if (result.isOk()) {
      committed.push(result.value);
    } else {
      expect(result.error.code).toBe('conflict');
    }
  }
  const winner = committed[0];
  if (winner === undefined) {
    throw new Error('describeAdminOp: concurrent double-execute committed nothing');
  }
  if (committed.length === 2) {
    expect(committed[1]).toEqual(winner);
  }
  return winner;
}

/** Exported for the harness's own unit tests (the guard arms). */
export function ephemeralProbes(harness: AdminOpHarnessInstance): AdminOpEphemeralProbes {
  if (harness.ephemeral === undefined) {
    throw new Error('describeAdminOp: hasEphemeralEffects requires harness.ephemeral probes');
  }
  return harness.ephemeral;
}

/**
 * The over-cap input the guardrail case needs, matched against the cap the
 * case registers off. A contract that declares a `maxAmountNanoUsd` cap owes
 * this battery an input, so omitting it fails that case instead of silently
 * removing it; a contract that declares no cap registers no case, so an input
 * supplied for one would run nowhere and is refused rather than ignored.
 *
 * Exported for the harness's own unit tests (the guard arms).
 */
export function requiredOverGuardrailInput(
  config: DescribeAdminOpConfig
): () => Record<string, unknown> {
  const supplied = config.overGuardrailInput?.bind(config);
  if (supplied !== undefined && config.contract.guardrails?.maxAmountNanoUsd === undefined) {
    throw new Error(
      `describeAdminOp: ${config.contract.name} declares no maxAmountNanoUsd guardrail, so its battery must not supply overGuardrailInput`
    );
  }
  if (supplied === undefined) {
    throw new Error(
      `describeAdminOp: ${config.contract.name} declares a maxAmountNanoUsd guardrail, so its battery must supply overGuardrailInput`
    );
  }
  return supplied;
}

/** Exported for the harness's own unit tests (the guard arms). */
export function requiredInverse(contract: AnyAdminOpContract): string {
  if (contract.inverse === null) {
    throw new Error('describeAdminOp: durable contract without an inverse');
  }
  return contract.inverse;
}

/** Exported for the harness's own unit tests (the guard arms). */
export function requiredInverseInput(result: AdminOpRunResult): Record<string, unknown> {
  if (result.inverseInput === null) {
    throw new Error('describeAdminOp: durable op returned no inverseInput');
  }
  return result.inverseInput;
}

/**
 * Stands in for the words an operator types into the undo form. Deliberately
 * not derived from the op being undone: an undo's reason is a person's account
 * of why they reversed something, and a machine-generated one is exactly what
 * the audit trail must never carry.
 */
const BATTERY_UNDO_REASON = 'Support call: the customer asked us to put this back.';

/**
 * The input every undo in this battery runs with: the op's recorded
 * `inverseInput` under the battery's operator reason, which replaces whatever
 * reason the recording carried.
 *
 * Exported for the harness's own unit tests.
 */
export function undoInputFor(result: AdminOpRunResult): Record<string, unknown> {
  return withUndoReason(requiredInverseInput(result), BATTERY_UNDO_REASON);
}

interface BatteryRun {
  readonly mode: 'preview' | 'execute';
  readonly key?: string;
  readonly undoes?: string;
  /** Defaults to the operator; the refusal case is what supplies another. */
  readonly role?: AdminRole;
}

function runAttempt(
  harness: AdminOpHarnessInstance,
  name: string,
  input: Record<string, unknown>,
  options: BatteryRun
): ReturnType<AdminOpEngine['run']> {
  return harness.engine.run({
    name,
    input,
    actor: harness.actor,
    role: options.role ?? 'operator',
    mode: options.mode,
    ...(options.key === undefined ? {} : { idempotencyKey: options.key }),
    ...(options.undoes === undefined ? {} : { undoes: options.undoes }),
  });
}

async function runOk(
  harness: AdminOpHarnessInstance,
  name: string,
  input: Record<string, unknown>,
  options: BatteryRun
): Promise<AdminOpRunResult> {
  const result = await runAttempt(harness, name, input, options);
  return result._unsafeUnwrap();
}

async function runErr(
  harness: AdminOpHarnessInstance,
  name: string,
  input: Record<string, unknown>,
  options: BatteryRun
): Promise<string> {
  const result = await runAttempt(harness, name, input, options);
  return result._unsafeUnwrapErr().code;
}

/**
 * The roles a contract does not list — the ones its battery probes for a
 * refusal. Derived from {@link ADMIN_ROLES} rather than named, so a role added
 * later is probed against every registered op without an edit here, and an op
 * that lists every role registers no case rather than a vacuous one.
 *
 * Exported for the harness's own unit tests.
 */
export function rolesRefusedBy(contract: AnyAdminOpContract): readonly AdminRole[] {
  return ADMIN_ROLES.filter((role) => !contract.allowedRoles.includes(role));
}

/**
 * A read's battery owes none of the mutation-only obligations and may claim
 * none of them: the Iron Law's interleaving test runs a registered inverse a
 * read can never have, and a guardrail cap bounds a money field a read never
 * takes. Supplying either would register nothing, so it is refused rather than
 * ignored — the same treatment {@link requiredOverGuardrailInput} gives an
 * over-cap input for an uncapped op.
 *
 * Exported for the harness's own unit tests.
 */
export function assertReadBattery(config: DescribeAdminOpConfig): void {
  const { name } = config.contract;
  if (config.interleaving !== undefined) {
    throw new Error(
      `describeAdminOp: ${name} is a read, so its battery must not supply interleaving (a read has no inverse to round-trip)`
    );
  }
  if (config.overGuardrailInput !== undefined) {
    throw new Error(
      `describeAdminOp: ${name} is a read, so its battery must not supply overGuardrailInput`
    );
  }
}

/**
 * The battery items that apply to a read: it answers, it writes exactly the
 * one read-audit row that records the asking, it changes nothing, and it
 * refuses bad input at the boundary before writing anything at all. The
 * mutation cases are absent rather than made vacuous — a read opens no
 * settlement transaction, claims no idempotency key and names no inverse, so
 * preview≡execute, the audit-atomicity rollback, the replay and the undo
 * round-trip have nothing to assert on it.
 */
function describeAdminReadOp<C extends AnyAdminOpContract>(config: DescribeAdminOpConfig<C>): void {
  const opName = config.contract.name;
  assertReadBattery(config);
  // A contract declaring no input field has nothing a body could get wrong, so
  // the boundary case would be vacuous; what is true of such a read is that an
  // undeclared body reaches it and is ignored, and that is asserted instead.
  // Both arms run `invalidInput`, so the battery's obligation to supply one
  // holds for every read.
  const declaresInput = Object.keys(config.contract.input.shape).length > 0;

  describe(`admin read battery: ${opName}`, () => {
    // Every case runs once per role the contract lists, and the list is where
    // the role comes from: a read that forgets a role produces an empty
    // catalogue for that role rather than an error, which reads as a rendering
    // fault, and this is what fails instead. The refusal of a role the contract
    // does NOT list is the engine's, taken before the kind split and asserted
    // there (`apps/api/src/slices/admin/domain/engine.integration.test.ts`).
    for (const role of config.contract.allowedRoles) {
      it(`answers the ${role} role, records the asking, and changes nothing`, async () => {
        const harness = await config.createHarness();
        const before = await harness.projection();

        const result = await harness.engine.read({
          name: opName,
          input: config.validInput(),
          actor: harness.actor,
          role,
        });

        const run = result._unsafeUnwrap();
        expect(run.kind).toBe('read');
        expect(run.auditId).toBeTruthy();
        expect(await harness.auditCount()).toBe(1);
        expect(await harness.projection()).toEqual(before);
      });

      if (declaresInput) {
        it(`rejects the ${role} role's invalid input at the boundary, recording nothing`, async () => {
          const harness = await config.createHarness();

          const result = await harness.engine.read({
            name: opName,
            input: config.invalidInput,
            actor: harness.actor,
            role,
          });

          expect(result._unsafeUnwrapErr().code).toBe('validation');
          expect(await harness.auditCount()).toBe(0);
        });
      } else {
        it(`answers the ${role} role a body its contract declares nothing of, ignoring it`, async () => {
          const harness = await config.createHarness();

          const result = await harness.engine.read({
            name: opName,
            input: config.invalidInput,
            actor: harness.actor,
            role,
          });

          expect(result._unsafeUnwrap().kind).toBe('read');
          expect(await harness.auditCount()).toBe(1);
        });
      }
    }
  });
}

export function describeAdminOp<C extends AnyAdminOpContract>(
  config: DescribeAdminOpConfig<C>
): void {
  if (config.contract.kind === 'read') {
    describeAdminReadOp(config);
    return;
  }
  const opName = config.contract.name;
  const durable = config.contract.effectClass === 'durable';
  // Checked before the suite is built: a supplied over-cap input that matches
  // no declared cap registers no case below, so it would run nowhere.
  if (config.overGuardrailInput !== undefined) {
    requiredOverGuardrailInput(config);
  }
  // Checked here for the opposite reason: the interleaving cases below are the
  // Reversibility Iron Law's own test, so omitting the config would drop them
  // silently rather than run them nowhere. Scoped to `durable` because that
  // test runs the registered inverse and no other effect class may name one
  // (`assertInverseRule`, `packages/shared/src/admin/contract.ts`).
  if (durable && config.interleaving === undefined) {
    throw new Error(
      `describeAdminOp: ${opName} is durable, so its battery must supply interleaving (the Iron Law test)`
    );
  }

  describe(`admin op battery: ${opName}`, () => {
    it('preview returns the effect diff and commits nothing', async () => {
      const harness = await config.createHarness();
      const before = await harness.projection();

      const previewed = await runOk(harness, opName, config.validInput(), { mode: 'preview' });

      expect(previewed.effects.length).toBeGreaterThan(0);
      // Committing nothing is the projection, not the row count: a preview
      // leaves exactly ONE row, the read-audit record of a sensitive read,
      // written outside the settlement transaction the engine rolls back. The
      // op's own audit row rolls back with the effects; that the surviving
      // row is the read-audit one is pinned by action name in
      // `apps/api/src/slices/admin/domain/engine.integration.test.ts`, which
      // holds a database handle this battery does not.
      expect(await harness.projection()).toEqual(before);
      expect(await harness.auditCount()).toBe(1);
    });

    it('execute commits exactly the effects preview showed (one code path)', async () => {
      const harness = await config.createHarness();
      const input = config.validInput();
      const before = await harness.projection();

      const previewed = await runOk(harness, opName, input, { mode: 'preview' });
      const executed = await runOk(harness, opName, input, {
        mode: 'execute',
        key: crypto.randomUUID(),
      });

      expect(executed.effects).toEqual(previewed.effects);
      // The preview's read-audit row plus the execute's own row.
      expect(await harness.auditCount()).toBe(2);
      if (durable) {
        expect(await harness.projection()).not.toEqual(before);
      } else {
        expect(await harness.projection()).toEqual(before);
      }
    });

    it('rolls back effects and audit together under an injected failure', async () => {
      const injected = new Error('injected admin failure after audit');
      const harness = await config.createHarness({
        hooks: {
          afterAudit: () => {
            throw injected;
          },
        },
      });
      const before = await harness.projection();

      await expect(
        runAttempt(harness, opName, config.validInput(), {
          mode: 'execute',
          key: crypto.randomUUID(),
        })
      ).rejects.toThrow(injected.message);

      expect(await harness.projection()).toEqual(before);
      expect(await harness.auditCount()).toBe(0);
    });

    it('replays a repeated idempotency key without re-executing effects', async () => {
      const harness = await config.createHarness();
      const input = config.validInput();
      const key = crypto.randomUUID();

      const first = await runOk(harness, opName, input, { mode: 'execute', key });
      const afterFirst = await harness.projection();
      const replayed = await runOk(harness, opName, input, { mode: 'execute', key });

      expect(replayed).toEqual(first);
      expect(await harness.projection()).toEqual(afterFirst);
      expect(await harness.auditCount()).toBe(1);
    });

    it('rejects invalid input at the boundary with no committed effect', async () => {
      const harness = await config.createHarness();
      const before = await harness.projection();

      const code = await runErr(harness, opName, config.invalidInput, {
        mode: 'execute',
        key: crypto.randomUUID(),
      });

      expect(code).toBe('validation');
      expect(await harness.projection()).toEqual(before);
      expect(await harness.auditCount()).toBe(0);
    });

    it('rejects a missing reason at the boundary', async () => {
      const harness = await config.createHarness();
      const withoutReason = { ...config.validInput() };
      delete withoutReason['reason'];

      const code = await runErr(harness, opName, withoutReason, {
        mode: 'execute',
        key: crypto.randomUUID(),
      });

      expect(code).toBe('validation');
    });

    // Registered off the CONTRACT's enforceable cap — not off the config, and
    // not off the mere presence of `guardrails`. The engine refuses on
    // `maxAmountNanoUsd` (`apps/api/src/slices/admin/domain/engine.ts`), so
    // keying the obligation on that same value is what stops the two readings
    // from drifting as the guardrail type grows; a declaration carrying no cap
    // owes no case, because nothing could trip one. Keying off the config would
    // instead make the refusal a battery option an op could forget to pass.
    if (config.contract.guardrails?.maxAmountNanoUsd !== undefined) {
      it('refuses an over-guardrail input in both modes and audits the execute refusal', async () => {
        const overGuardrailInput = requiredOverGuardrailInput(config);
        const harness = await config.createHarness();
        const before = await harness.projection();

        expect(await runErr(harness, opName, overGuardrailInput(), { mode: 'preview' })).toBe(
          'forbidden'
        );
        // The refused preview's own guardrail row rolls back like every other
        // preview row; what stands is its read-audit record, written before
        // the transaction so a refused read is still on the record.
        expect(await harness.auditCount()).toBe(1);

        expect(
          await runErr(harness, opName, overGuardrailInput(), {
            mode: 'execute',
            key: crypto.randomUUID(),
          })
        ).toBe('forbidden');

        // The execute refusal is the permanent record (Charter #7), beside it.
        expect(await harness.auditCount()).toBe(2);
        expect(await harness.projection()).toEqual(before);
      });
    }

    for (const role of rolesRefusedBy(config.contract)) {
      it(`refuses the ${role} role in both modes, with no effect and no audit row`, async () => {
        const harness = await config.createHarness();
        const before = await harness.projection();

        expect(await runErr(harness, opName, config.validInput(), { mode: 'preview', role })).toBe(
          'forbidden'
        );
        expect(
          await runErr(harness, opName, config.validInput(), {
            mode: 'execute',
            key: crypto.randomUUID(),
            role,
          })
        ).toBe('forbidden');

        // The refusal precedes the preview's read-audit row and the execute's
        // key-row claim, so a refused role leaves no trace but the Sentry event.
        expect(await harness.auditCount()).toBe(0);
        expect(await harness.projection()).toEqual(before);
      });
    }

    if (durable) {
      it('undo runs the inverse, threads undoes, and nets the projection to zero', async () => {
        // The generic registry-driven round-trip harness: snapshot →
        // execute → registered inverse as undo → snapshot, asserting the
        // post-undo projection equals the pre-execute one. A wrong inverse that
        // fails to restore state fails here, not merely a missing registration.
        const harness = await config.createHarness();

        const trip = await runUndoRoundTrip(
          harness,
          config.contract,
          config.validInput(),
          BATTERY_UNDO_REASON
        );

        expect(trip.undone.effects.length).toBeGreaterThan(0);
        expect(trip.afterUndo).toEqual(trip.baseline);
        expect(await harness.auditCount()).toBe(2);
      });

      it('refuses a second undo of the same audit row (unique undoes claim)', async () => {
        const harness = await config.createHarness();
        const inverseName = requiredInverse(config.contract);

        const executed = await runOk(harness, opName, config.validInput(), {
          mode: 'execute',
          key: crypto.randomUUID(),
        });
        const undoInput = undoInputFor(executed);
        await runOk(harness, inverseName, undoInput, {
          mode: 'execute',
          key: crypto.randomUUID(),
          undoes: executed.auditId,
        });

        const code = await runErr(harness, inverseName, undoInput, {
          mode: 'execute',
          key: crypto.randomUUID(),
          undoes: executed.auditId,
        });

        expect(code).toBe('conflict');
      });

      it('records an inverseInput that carries no reason', async () => {
        const harness = await config.createHarness();

        const executed = await runOk(harness, opName, config.validInput(), {
          mode: 'execute',
          key: crypto.randomUUID(),
        });

        expect(requiredInverseInput(executed)).not.toHaveProperty('reason');
      });

      it('records the operator’s reason on the undo’s audit row', async () => {
        // The audit row is read at the engine's insert seam rather than from
        // the database: this battery lives in domain (no database handle) and
        // the harness surface exposes only a row count. The `auditCount` below
        // is what proves the observed rows are the ones that committed.
        const audited: AdminOpAuditedRun[] = [];
        const harness = await config.createHarness({
          hooks: {
            afterAudit: (row) => {
              audited.push(row);
            },
          },
        });
        const inverseName = requiredInverse(config.contract);

        const executed = await runOk(harness, opName, config.validInput(), {
          mode: 'execute',
          key: crypto.randomUUID(),
        });
        await runOk(harness, inverseName, undoInputFor(executed), {
          mode: 'execute',
          key: crypto.randomUUID(),
          undoes: executed.auditId,
        });

        expect(await harness.auditCount()).toBe(2);
        const undone = audited.find((row) => row.undoes === executed.auditId);
        expect(undone?.input['reason']).toBe(BATTERY_UNDO_REASON);
      });
    }

    const interleaving = config.interleaving;
    if (interleaving !== undefined) {
      for (const seed of interleaving.seeds) {
        it(`nets its delta to zero across a seeded interleaving (Iron Law, seed ${String(seed)})`, async () => {
          const inverseName = requiredInverse(config.contract);

          const control = await config.createHarness();
          await runSeededActions(control, interleaving, seededRng(seed));
          const controlProjection = await control.projection();

          const harness = await config.createHarness();
          const executed = await runOk(harness, opName, interleaving.opInput(harness), {
            mode: 'execute',
            key: crypto.randomUUID(),
          });
          await runSeededActions(harness, interleaving, seededRng(seed));
          await runOk(harness, inverseName, undoInputFor(executed), {
            mode: 'execute',
            key: crypto.randomUUID(),
            undoes: executed.auditId,
          });

          expect(await harness.projection()).toEqual(controlProjection);
          await interleaving.afterRun?.(control);
          await interleaving.afterRun?.(harness);
        });
      }

      it('commits exactly one effect under a concurrent double-execute of one key', async () => {
        const inverseName = requiredInverse(config.contract);
        const harness = await config.createHarness();
        const baseline = await harness.projection();
        const input = interleaving.opInput(harness);
        const key = crypto.randomUUID();

        const attempt = (): ReturnType<AdminOpEngine['run']> =>
          runAttempt(harness, opName, input, { mode: 'execute', key });
        const results = await Promise.all([attempt(), attempt()]);

        const winner = winnerOfConcurrentRace(results);
        expect(await harness.auditCount()).toBe(1);

        // Exactly one committed effect: a single undo restores the baseline.
        await runOk(harness, inverseName, undoInputFor(winner), {
          mode: 'execute',
          key: crypto.randomUUID(),
          undoes: winner.auditId,
        });
        expect(await harness.projection()).toEqual(baseline);
        await interleaving.afterRun?.(harness);
      });
    }

    if (config.hasEphemeralEffects === true) {
      it('runs ephemeral effects only after a committed execute, never in preview', async () => {
        const harness = await config.createHarness();
        const ephemeral = ephemeralProbes(harness);
        const input = config.validInput();

        await runOk(harness, opName, input, { mode: 'preview' });
        expect(ephemeral.log()).toEqual([]);

        await runOk(harness, opName, input, { mode: 'execute', key: crypto.randomUUID() });
        expect(ephemeral.log().length).toBe(1);
      });

      it('does not run ephemeral effects when the transaction rolls back', async () => {
        const harness = await config.createHarness({
          hooks: {
            afterAudit: () => {
              throw new Error('injected rollback');
            },
          },
        });
        const ephemeral = ephemeralProbes(harness);

        await expect(
          runAttempt(harness, opName, config.validInput(), {
            mode: 'execute',
            key: crypto.randomUUID(),
          })
        ).rejects.toThrow('injected rollback');

        expect(ephemeral.log()).toEqual([]);
      });

      it('does not fail the executed op when an ephemeral effect fails', async () => {
        const harness = await config.createHarness();
        const ephemeral = ephemeralProbes(harness);
        ephemeral.armFailure();

        const executed = await runOk(harness, opName, config.validInput(), {
          mode: 'execute',
          key: crypto.randomUUID(),
        });

        expect(executed.auditId).toBeTruthy();
        expect(await harness.auditCount()).toBe(1);
        expect(ephemeral.log()).toEqual([]);
      });
    }
  });
}
