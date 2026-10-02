import type { z } from 'zod';
import type {
  AdminOpContract,
  AdminOpEffect as AdminOpEffectWire,
  AnyAdminOpContract,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { JobWakeCapable } from '../../../lib/jobs/index.js';
import type { Result, ResultAsync } from '../../../lib/result/index.js';

/**
 * One typed effect description an op returns; preview renders these as the
 * change list, and they land verbatim in the audit row's `details`. Values
 * must stay wire-JSON (no bigint) — the engine fail-fasts on anything the
 * audit jsonb column cannot serialize.
 */
export type AdminOpEffect = AdminOpEffectWire;

/** The audit row's polymorphic target (no FK by design). */
export interface AdminOpTarget {
  readonly type: string;
  readonly id: string;
}

/**
 * A post-commit ephemeral effect (Redis watermark bumps, best-effort socket
 * eviction). Op bodies stay Postgres-only inside the settlement transaction;
 * the engine runs registered ephemeral effects ONLY after a successful
 * commit — never inside the transaction, never in preview — and their
 * failure is logged best-effort, never failing the executed op.
 *
 * `run` receives the post-commit dependency half as its argument: the engine
 * passes `postDeps` here once the transaction has committed, and passes an op
 * body only `ctx.deps`. The composition root builds the two halves as separate
 * literals sharing no key, so a body that casts `ctx.deps` to the post-commit
 * half reads `undefined` rather than a live capability.
 */
export interface AdminEphemeralEffect<PostDeps> {
  readonly name: string;
  run(post: PostDeps): Promise<void>;
}

export interface AdminOpOutcome {
  readonly effects: readonly AdminOpEffect[];
  readonly target?: AdminOpTarget;
  /**
   * Wire-shape input for the registered inverse op, captured from PRE-state
   * at execute time (inverse snapshot semantics — never recomputed at undo
   * time). Required from durable ops; a class that registers no inverse
   * omits it.
   */
  readonly inverseInput?: Record<string, unknown>;
}

/**
 * The narrow, closed context an op body receives: engine-constructed values
 * only, each one the engine's to hand over and never the body's to make or
 * widen. Nothing else — no db handle, no fetch, no adapters (the admin-op
 * purity arch rule + lint extension enforce the import side).
 */
export interface AdminOpContext<Deps, PostDeps = Record<never, never>> {
  /**
   * The engine's settlement transaction, carrying the job-wake capability the
   * enqueue and redrive seams require: an op that leaves a row claimable now
   * leaves its shard on the request boundary's collector, and no op body holds
   * a nudge of its own. A previewed op rolls back and merges nothing.
   */
  readonly tx: JobWakeCapable<SettlementTx>;
  /**
   * The transaction-scoped half. A post-commit capability is declared on the
   * family's post-commit half instead, and the engine hands that half to
   * {@link AdminEphemeralEffect.run} after commit; the
   * `admin-external-ports-stay-post-commit` arch rule refuses a name a
   * post-commit half declares wherever a transaction-scoped declaration
   * writes it.
   */
  readonly deps: Deps;
  /**
   * The audit row id this run is undoing; absent on a forward run. Engine-
   * owned and never an input field: a body reads it (an effect whose
   * identity must distinguish an undo from the forward act it reverses needs
   * it) and can never supply one.
   */
  readonly undoes?: string;
  registerEphemeral(effect: AdminEphemeralEffect<PostDeps>): void;
}

/**
 * An op's current-state prefill: the wire-JSON input values the SPA pours
 * into the op form (never `reason` — the operator always types it). Errors
 * stay in the `Result` channel like `execute`, so a store outage surfaces
 * as an expected domain failure, not a route defect.
 *
 * Sensitivity constraint: prefill is served by the generic prefill read
 * route, which is UNAUDITED and un-rate-limited — a resolver must return
 * only non-sensitive, admin-authored configuration. Never customer-derived
 * data; anything customer-derived belongs on the audited read surface.
 */
export type AdminOpPrefill =
  | ResultAsync<Record<string, unknown>, DomainError>
  | Promise<Result<Record<string, unknown>, DomainError>>;

/**
 * The narrow context a READ body receives: its composed dependencies, and
 * nothing else. A read opens no settlement transaction, so there is no handle
 * for it to hold — the absence is what makes "a read lands nothing durable" a
 * property of the type rather than a promise the body keeps.
 */
export interface AdminOpReadContext<Deps> {
  readonly deps: Deps;
}

/**
 * A registered mutation: the shared contract bound to its executable body.
 * `execute` (and the optional `prefill`) are declared method-style
 * deliberately — bivariance lets a specifically-typed op (input inferred
 * from its own contract) widen into the registry's element type.
 */
export interface AdminMutationOpImplementation<
  Deps,
  In extends z.ZodObject = z.ZodObject,
  PostDeps = Record<never, never>,
> {
  readonly contract: AdminOpContract<In>;
  execute(
    ctx: AdminOpContext<Deps, PostDeps>,
    input: z.output<In>
  ): ResultAsync<AdminOpOutcome, DomainError> | Promise<Result<AdminOpOutcome, DomainError>>;
  /** Optional current-state resolver behind `GET /ops/:name/prefill`; ops
   * without one 404 there, indistinguishable from an unknown op by design.
   * That route is unaudited and un-rate-limited — resolvers may return only
   * non-sensitive, admin-authored configuration (see `AdminOpPrefill`). */
  prefill?(deps: Deps): AdminOpPrefill;
}

/**
 * A registered read: the shared contract bound to a body that answers with a
 * wire-JSON payload and writes nothing. `Out` stays on the type so a read's
 * own payload is checked where it is written; the registry widens it to
 * `unknown`, which is what the engine hands to the route.
 */
export interface AdminReadOpImplementation<
  Deps,
  In extends z.ZodObject = z.ZodObject,
  Out = unknown,
> {
  readonly contract: AdminOpContract<In>;
  read(
    ctx: AdminOpReadContext<Deps>,
    input: z.output<In>
  ): ResultAsync<Out, DomainError> | Promise<Result<Out, DomainError>>;
}

/**
 * A registered op of either kind. The two arms carry different bodies rather
 * than one body that ignores half its context: a mutation's body takes the
 * settlement transaction, a read's cannot reach one. Which arm a value is on
 * is read off the body it carries, so the contract's `kind` and the body can
 * never disagree — {@link createAdminOpRegistry} refuses the pair that does.
 */
export type AdminOpImplementation<
  Deps,
  In extends z.ZodObject = z.ZodObject,
  PostDeps = Record<never, never>,
> = AdminMutationOpImplementation<Deps, In, PostDeps> | AdminReadOpImplementation<Deps, In>;

/** Binds a shared contract to a mutation body with the input type inferred. */
export function defineAdminOp<Deps, In extends z.ZodObject, PostDeps = Record<never, never>>(
  contract: AdminOpContract<In>,
  body: Pick<AdminMutationOpImplementation<Deps, In, PostDeps>, 'execute' | 'prefill'>
): AdminMutationOpImplementation<Deps, In, PostDeps> {
  return {
    contract,
    execute: body.execute,
    ...(body.prefill === undefined ? {} : { prefill: body.prefill }),
  };
}

/** Binds a shared contract to a read body with both types inferred. */
export function defineAdminReadOp<Deps, In extends z.ZodObject, Out>(
  contract: AdminOpContract<In>,
  body: Pick<AdminReadOpImplementation<Deps, In, Out>, 'read'>
): AdminReadOpImplementation<Deps, In, Out> {
  return { contract, read: body.read };
}

declare const ADMIN_OP_REGISTRY: unique symbol;

interface AdminOpRegistrySurface<Deps, PostDeps> {
  get(name: string): AdminOpImplementation<Deps, z.ZodObject, PostDeps> | undefined;
  /** Exhaustive contract listing — what the `GET /ops` catalog serves. */
  list(): readonly AnyAdminOpContract[];
}

/**
 * The branded registry type (compile-time-only phantom intersection, same
 * mechanism as `SettlementTx`): `createAdminOpRegistry` below is the sole
 * mint point, so holding an `AdminOpRegistry` proves the Iron Law gate ran —
 * a hand-built structural `{ get, list }` cannot satisfy `AdminOpEngineDeps`
 * and bypass it.
 */
export type AdminOpRegistry<Deps, PostDeps = Record<never, never>> = AdminOpRegistrySurface<
  Deps,
  PostDeps
> & {
  readonly [ADMIN_OP_REGISTRY]: 'AdminOpRegistry';
};

/**
 * Registry construction is the Iron Law gate: a durable mutation whose
 * inverse is not ALSO registered fails here, at module load / app boot —
 * an irreversible admin operation cannot exist at runtime. The exemption is
 * a closed set ({@link CLASSES_OWING_NO_INVERSE}), so an unrecognized class
 * is refused rather than admitted as "not durable".
 */
export function createAdminOpRegistry<Deps, PostDeps = Record<never, never>>(
  implementations: readonly AdminOpImplementation<Deps, z.ZodObject, PostDeps>[]
): AdminOpRegistry<Deps, PostDeps> {
  const byName = new Map<string, AdminOpImplementation<Deps, z.ZodObject, PostDeps>>();
  for (const implementation of implementations) {
    const { name } = implementation.contract;
    if (byName.has(name)) {
      throw new Error(`admin op registry: duplicate registration of ${name}`);
    }
    byName.set(name, implementation);
  }
  for (const implementation of byName.values()) {
    assertBodyMatchesKind(implementation);
    assertIronLaw(implementation.contract, byName);
  }
  const registry: AdminOpRegistrySurface<Deps, PostDeps> = {
    get: (name) => byName.get(name),
    list: () =>
      [...byName.values()]
        .map((implementation) => implementation.contract)
        .toSorted((a, b) => a.name.localeCompare(b.name)),
  };
  // The single brand mint (mirrors `brandSettlementTx`): legal only here,
  // after the Iron Law assertions above have passed.
  return registry as AdminOpRegistry<Deps, PostDeps>;
}

/**
 * The contract's kind decides which body it must carry, checked at
 * construction like the Iron Law beside it: a read reaching the mutation path
 * would open a settlement transaction for a run that lands nothing, and a
 * mutation reaching the read path would run its effects outside one.
 */
function assertBodyMatchesKind<Deps, PostDeps>(
  implementation: AdminOpImplementation<Deps, z.ZodObject, PostDeps>
): void {
  const { name, kind } = implementation.contract;
  if (kind === 'read') {
    if (!('read' in implementation)) {
      throw new Error(`admin op registry: read ${name} registers no read body`);
    }
    return;
  }
  if (!('execute' in implementation)) {
    throw new Error(`admin op registry: mutation ${name} registers no execute body`);
  }
}

/**
 * The classes whose effects the Iron Law does not ask an admin to invert:
 * `ephemeral` leaves nothing durable (its body takes no settlement
 * transaction handle, checked by the `admin-ephemeral-ops-take-no-transaction`
 * arch rule), and `system-owned` names a durable effect the operator never
 * originated. Enumerated rather than derived from "not durable" so the
 * exemption stays a closed set: a mutation carrying any other class is
 * refused here instead of walking past the inverse requirement. A new effect
 * class therefore fails this gate until someone adds it here deliberately,
 * which is the point — silence would be a new way to owe no inverse.
 */
const CLASSES_OWING_NO_INVERSE: ReadonlySet<AnyAdminOpContract['effectClass']> = new Set([
  'ephemeral',
  'system-owned',
]);

function assertIronLaw(contract: AnyAdminOpContract, byName: ReadonlyMap<string, unknown>): void {
  if (contract.kind !== 'mutation') return;
  if (contract.effectClass !== 'durable') {
    if (!CLASSES_OWING_NO_INVERSE.has(contract.effectClass)) {
      throw new Error(
        `admin op registry: mutation ${contract.name} declares effect class ` +
          `'${contract.effectClass}', which no rule excuses from naming an inverse ` +
          '(Reversibility Iron Law)'
      );
    }
    // `system-owned`'s escape from the inverse requirement rests on its stated
    // reason alone, where `ephemeral`'s rests on the
    // `admin-ephemeral-ops-take-no-transaction` arch rule. So the reason is
    // re-checked here against raw literals, exactly as the durable half
    // re-checks the inverse the shared contract constructor already demanded.
    if (
      contract.effectClass === 'system-owned' &&
      (contract.systemOwnedReason ?? '').trim() === ''
    ) {
      throw new Error(
        `admin op registry: system-owned mutation ${contract.name} states no ` +
          'systemOwnedReason (the class may not be taken silently)'
      );
    }
    return;
  }
  // The shared contract constructor already refuses a null inverse on a
  // durable op; this re-check guards raw contract literals that bypassed it.
  if (contract.inverse === null) {
    throw new Error(`admin op registry: durable mutation ${contract.name} names no inverse`);
  }
  if (!byName.has(contract.inverse)) {
    throw new Error(
      `admin op registry: durable mutation ${contract.name} requires its inverse ` +
        `${contract.inverse}, which is not registered (Reversibility Iron Law)`
    );
  }
}
