import { z } from 'zod';
import { adminAuditExecutedDetailsSchema, adminOpExecuteResultSchema } from '@hushbox/shared';
import {
  conflictError,
  forbiddenError,
  notFoundError,
  validationError,
} from '../../../lib/errors/index.js';
import {
  REQUEST_LEASE_SECONDS,
  canonicalJson,
  claimKeyRow,
  failKeyRow,
  hashCanonicalJson,
  uuidFromHex,
  requestInProgressError,
  runSettlement,
  succeedKeyRow,
} from '../../../lib/idempotency/index.js';
import { ResultAsync, err, ok } from '../../../lib/result/index.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import { UndoAlreadyClaimedError } from '../ports/index.js';
import { READ_AUDIT_ACTIONS, writeReadAudit } from './read-audit.js';
import type { JobWakeCapable } from '../../../lib/jobs/index.js';
import type { Database } from '@hushbox/db';
import type {
  AdminOpExecuteResult,
  AdminOpReadResult,
  AdminRole,
  AnyAdminOpContract,
} from '@hushbox/shared';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  IdempotencyScope,
  KeyRowClaim,
  KeyRowFence,
  SettlementTx,
} from '../../../lib/idempotency/index.js';
import type { Result } from '../../../lib/result/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { AdminAuditInsertRow, AdminStores } from '../ports/index.js';
import type {
  AdminEphemeralEffect,
  AdminMutationOpImplementation,
  AdminOpRegistry,
  AdminOpTarget,
} from './registry.js';

/**
 * The admin ops engine — one code path, two modes. Both modes run the SAME
 * body (op execute → audit insert, inside one settlement transaction);
 * `preview` throws the `PreviewRollback` sentinel so the transaction rolls
 * back and the computed effect diff becomes the plan; `execute` commits,
 * fenced by the shared idempotency-key row so a retried execute replays the
 * stored response and never re-runs effects.
 *
 * Note on the idempotency wrapper: the Charter names `idempotent.byKey`, but
 * `byKey` opens a plain transaction and cannot mint the `SettlementTx` op
 * bodies require. The engine therefore composes byKey's own published
 * primitives — `claimKeyRow` (claim / replay / in-progress semantics,
 * canonical body hash, lease) + `runSettlement` (the sole `SettlementTx`
 * mint) + the fenced `succeedKeyRow`/`failKeyRow` flips — exactly the
 * composition the workflows engine's fenced settlement already uses. Same
 * machinery, same semantics, no parallel implementation.
 */

export interface RunAdminOpParams {
  readonly name: string;
  /** Wire-shape JSON input (validated against the contract's Zod schema). */
  readonly input: unknown;
  /** The verified Cloudflare Access email claim performing the op. */
  readonly actor: string;
  /**
   * The role the Access stage resolved for that actor. Required, so a caller
   * cannot reach the engine without stating who is acting; the engine checks
   * it against the contract's `allowedRoles` before it does anything else.
   */
  readonly role: AdminRole;
  readonly mode: 'preview' | 'execute';
  /** Client-minted Idempotency-Key; required in execute mode. */
  readonly idempotencyKey?: string;
  /**
   * The audit row id being undone when this run is an inverse-as-undo. The
   * audit insert claims the `undoes` UNIQUE column, so a second undo of the
   * same row fails with `conflict` — undo is exactly-once by construction.
   */
  readonly undoes?: string;
}

/** What a read run is asked for: no mode, no key, no undo target — a read has nothing for any of them to mean. */
export interface RunAdminReadParams {
  readonly name: string;
  /** Wire-shape JSON input (validated against the contract's Zod schema). */
  readonly input: unknown;
  /** The verified Cloudflare Access email claim performing the read. */
  readonly actor: string;
  /** The role the Access stage resolved, checked against the contract's `allowedRoles` before anything else. */
  readonly role: AdminRole;
}

/**
 * What a run produces, in the shape it reaches the wire in — the shared
 * execute-result schema's type, so the engine, the route envelope and the
 * admin SPA all read one declaration.
 */
export type AdminOpRunResult = AdminOpExecuteResult;

/**
 * What a read produces: the id of the read-audit row the run wrote, and the
 * read's own payload. Its `kind` literal is what keeps it from being taken for
 * a mutation's result, which carries no such field and is unchanged.
 */
export type AdminOpReadRunResult = AdminOpReadResult;

/** The audit row a run just inserted, as the `afterAudit` seam sees it. */
export interface AdminOpAuditedRun {
  /** The wire input recorded on the row (`details.input`). */
  readonly input: Record<string, unknown>;
  /** The audit row this run undoes, when it is an undo. */
  readonly undoes?: string;
}

export interface AdminOpEngineHooks {
  /**
   * The battery's in-transaction seam: runs inside the settlement transaction
   * after the op body and the audit insert, before the key-row flip / rollback
   * sentinel. Its position is what it is for — a throw here must roll back
   * effect and audit together, and the audit row arrives as inserted, readable
   * by a caller that holds no database handle. Production wiring leaves it
   * undefined.
   */
  afterAudit?: (audited: AdminOpAuditedRun) => void | Promise<void>;
}

/** What the post-commit notifier learns about one committed execute. */
export interface AdminOpExecutedNotice {
  readonly opName: string;
  readonly actor: string;
  readonly reason: string;
  readonly target?: AdminOpTarget;
  readonly auditId: string;
  readonly isUndo: boolean;
}

/**
 * The handle the engine opens its settlement on: capability-bearing, so an op's
 * enqueue leaves its wake on the boundary that granted it. Published because the
 * route layer declares the factory that supplies one and may not reach `lib/`.
 */
export type AdminOpEngineDb = JobWakeCapable<Database>;

interface AdminOpEngineDeps<Deps, PostDeps = Record<never, never>> {
  readonly db: AdminOpEngineDb;
  readonly registry: AdminOpRegistry<Deps, PostDeps>;
  readonly stores: AdminStores;
  readonly telemetry: Telemetry;
  /**
   * The composed slice dependencies an op body receives as `ctx.deps` — the
   * half the engine hands into the transaction. A post-commit capability is
   * declared on `postDeps` instead, and the
   * `admin-external-ports-stay-post-commit` arch rule refuses a name declared
   * there from being written here too. Being on this half does not by itself
   * decide whether a call rolls back: that follows the handle each member's
   * own slice bound it to, and some published store methods are bound to the
   * base database rather than a `tx`. Must be constructed separately from
   * `postDeps` — one object typed two ways would restore exactly the reach
   * the split removes.
   */
  readonly opDeps: Deps;
  /**
   * Post-commit capabilities (Redis, socket eviction, senders). The engine
   * reads this field in exactly one place: the call that hands it to each
   * registered ephemeral effect's `run`, once `runSettlement` has committed.
   */
  readonly postDeps: PostDeps;
  /** Claimant identity recorded as the key-row fence (`claimedBy`). */
  readonly executorId: string;
  readonly hooks?: AdminOpEngineHooks;
  /**
   * Best-effort mutation notification (telemetry, never a control — the
   * admin plane's remaining tripwire against a compromised-but-valid
   * session). Fires once per COMMITTED execute, after the ephemeral
   * effects: never in preview, never on replay, never on a failed op. A
   * throw is captured and never fails the already-committed op.
   */
  readonly onExecuted?: (notice: AdminOpExecutedNotice) => Promise<void>;
}

export interface AdminOpEngine {
  run(params: RunAdminOpParams): ResultAsync<AdminOpRunResult, DomainError>;
  /**
   * The read path: the same registry, the same role check and the same
   * contract validation as {@link AdminOpEngine.run}, and then the op's own
   * body — no settlement transaction, no key row, no inverse. What it does
   * write is one read-audit row, before the body runs, so a read that then
   * fails is still on the record.
   */
  read(params: RunAdminReadParams): ResultAsync<AdminOpReadRunResult, DomainError>;
}

/** Rollback sentinel: module-private, carries the computed plan out of the
 * deliberately-aborted preview transaction. A real error can never be an
 * instance of this class, so it cannot be mistaken for the sentinel. */
class PreviewRollback extends Error {
  constructor(readonly result: AdminOpRunResult) {
    super('admin engine: preview rollback');
    this.name = 'PreviewRollback';
  }
}

/** Carries an expected op failure (a `Result` err) across the transaction
 * boundary so Drizzle rolls everything back. */
class OpFailed extends Error {
  constructor(readonly domainError: DomainError) {
    super('admin engine: op execution failed');
    this.name = 'OpFailed';
  }
}

/** Aborts the transaction when the completion fence finds a zombie claimant. */
class FenceLost extends Error {
  constructor() {
    super('admin engine: completion fence lost');
  }
}

export function createAdminOpEngine<Deps, PostDeps = Record<never, never>>(
  deps: AdminOpEngineDeps<Deps, PostDeps>
): AdminOpEngine {
  return {
    run(params: RunAdminOpParams): ResultAsync<AdminOpRunResult, DomainError> {
      return new ResultAsync(runInternal(deps, params));
    },
    read(params: RunAdminReadParams): ResultAsync<AdminOpReadRunResult, DomainError> {
      return new ResultAsync(readInternal(deps, params));
    },
  };
}

async function runInternal<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  params: RunAdminOpParams
): Promise<Result<AdminOpRunResult, DomainError>> {
  const op = deps.registry.get(params.name);
  if (op === undefined) {
    return err(notFoundError('admin op is not registered'));
  }
  if (!op.contract.allowedRoles.includes(params.role)) {
    return err(roleRefusal(deps, op.contract, params.role));
  }
  if (op.contract.kind !== 'mutation' || !('execute' in op)) {
    // A read reaches the plane through the same routes, so a client can ask
    // for one here: a typed refusal, never a defect. Preview has nothing to
    // show for a run that changes nothing, and execute dispatches reads to
    // `read` before it gets this far.
    return err(validationError('admin op is a read; it runs through the read path'));
  }
  const parsed = op.contract.input.safeParse(params.input);
  if (!parsed.success) {
    return err(validationError('admin op input failed validation'));
  }
  const run: OpRun<Deps, PostDeps> = { op, parsed: parsed.data, params };
  return params.mode === 'preview' ? previewRun(deps, run) : executeRun(deps, run);
}

/**
 * The read path, in the order the checks must happen: the op must exist, the
 * role must be listed, the contract must be a read, and the input must parse —
 * only then does anything reach the database. The read-audit row is written
 * before the body, so a read that fails afterwards is still on the record; it
 * records what was asked for (the op and its wire input) and never what came
 * back, which is the same rule every other audited read on this plane follows.
 */
async function readInternal<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  params: RunAdminReadParams
): Promise<Result<AdminOpReadRunResult, DomainError>> {
  const op = deps.registry.get(params.name);
  if (op === undefined) {
    return err(notFoundError('admin op is not registered'));
  }
  if (!op.contract.allowedRoles.includes(params.role)) {
    return err(roleRefusal(deps, op.contract, params.role));
  }
  if (op.contract.kind !== 'read' || !('read' in op)) {
    return err(validationError('admin op is a mutation; it runs through the op engine'));
  }
  const parsed = op.contract.input.safeParse(params.input);
  if (!parsed.success) {
    return err(validationError('admin op input failed validation'));
  }
  const { id } = await writeReadAudit(deps.stores, deps.db, {
    actor: params.actor,
    role: params.role,
    action: READ_AUDIT_ACTIONS.opRead,
    details: {
      op: op.contract.name,
      input: auditWireInput(params.input, op.contract.input),
    },
  });
  const outcome = await op.read({ deps: deps.opDeps }, parsed.data);
  if (outcome.isErr()) return err(outcome.error);
  assertWireJson(outcome.value, op.contract.name);
  return ok({ kind: 'read', auditId: id, data: outcome.value });
}

/**
 * The engine's role refusal, taken before the mode split — so before the
 * preview's read-audit row, before the key-row claim and before the settlement
 * transaction. Nothing durable records it: the audit trail is a record of acts,
 * and a refused op is not one, so the Sentry event is the only channel on which
 * an operator learns a role probed a mutation. The refusal is the same typed
 * 403 whatever the body held, and it precedes input validation so a refused
 * caller learns nothing about the op's schema.
 */
function roleRefusal<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  contract: AnyAdminOpContract,
  role: AdminRole
): DomainError {
  deps.telemetry.captureError(
    new Error(`admin op ${contract.name} refused role '${role}'`),
    FINGERPRINT_CODES.adminRoleRefused
  );
  return forbiddenError('admin op is not permitted for this role');
}

/**
 * `maxAmountNanoUsd` caps every money field of the parsed input (money
 * parses to bigint; nothing else does). It is the only guardrail: rate
 * limiting on admin routes is declared per route in the slice's posture
 * fragment, over fixed registry entries, and does not read op metadata.
 */
function guardrailViolation(
  contract: AnyAdminOpContract,
  parsed: Record<string, unknown>
): string | null {
  const cap = contract.guardrails?.maxAmountNanoUsd;
  if (cap === undefined) return null;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'bigint' && value > cap) {
      return `${key} exceeds maxAmountNanoUsd`;
    }
  }
  return null;
}

interface PerformedOp<PostDeps> {
  readonly kind: 'performed';
  readonly result: AdminOpRunResult;
  readonly ephemeralEffects: readonly AdminEphemeralEffect<PostDeps>[];
  readonly target?: AdminOpTarget;
}

/** What the shared body produced: the op ran, or a guardrail refused it. */
type OpOutcome<PostDeps> =
  | PerformedOp<PostDeps>
  | { readonly kind: 'refused'; readonly violation: string };

function guardrailRefusedError(violation: string): DomainError {
  return forbiddenError(`admin op guardrail refused: ${violation}`);
}

/** The replayable response a committed refusal stores on its key row. */
const refusalResponseSchema = z.object({ refusal: z.string() });

/** One validated run: the op, its parsed input, and the raw run params. */
interface OpRun<Deps, PostDeps> {
  readonly op: AdminMutationOpImplementation<Deps, z.ZodObject, PostDeps>;
  readonly parsed: Record<string, unknown>;
  readonly params: RunAdminOpParams;
}

const auditIdSchema = z.uuid();

/**
 * Validates the undo-target relationship inside the settlement transaction,
 * before the op body and the audit insert: the target row must exist, must
 * be an executed-effect row, the running op must be the target action's
 * REGISTERED inverse, and the input must equal that row's recorded
 * `inverseInput` everywhere but `reason` — a caller can never burn an
 * arbitrary row's one undo slot (`undoes` is UNIQUE on an append-only
 * table), write a false undone-by linkage, or run the inverse with values it
 * did not record. That last check lives here and not in the form because the
 * operator is the party it protects against; equality is canonical JSON over
 * the wire input picked down to the contract's keys, the same comparison the
 * body-hash fence makes on a reused idempotency key. An operator who wants
 * different values runs the forward operation instead. Undoing an undo row
 * is legal by explicit decision: inverse pairs register bidirectionally, so
 * the inverse chain makes it a redo, and each row still gets at most one
 * undo via the UNIQUE claim.
 * Mismatches throw `OpFailed` (typed refusals mapped to error Results, like
 * any op-body refusal), never a defect.
 */
async function assertUndoTarget<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  tx: SettlementTx,
  run: OpRun<Deps, PostDeps>
): Promise<void> {
  const undoes = run.params.undoes;
  if (undoes === undefined) return;
  if (!auditIdSchema.safeParse(undoes).success) {
    throw new OpFailed(validationError('admin undo target id is not a uuid'));
  }
  const target = await deps.stores.getAuditForUndo(tx, undoes);
  if (target === undefined) {
    throw new OpFailed(notFoundError('admin undo target audit row does not exist'));
  }
  const details = adminAuditExecutedDetailsSchema.safeParse(target.details);
  if (!details.success) {
    throw new OpFailed(forbiddenError('admin undo target is not an executed-effect audit row'));
  }
  const targetOp = deps.registry.get(target.action);
  if (targetOp?.contract.inverse !== run.op.contract.name) {
    throw new OpFailed(
      forbiddenError(
        `admin op ${run.op.contract.name} is not the registered inverse of the undo target`
      )
    );
  }
  // A row that recorded no inverse input canonicalizes to `null`, which no
  // object input can equal — an unprovable undo refuses through this same arm.
  const recorded = canonicalJson(withoutReason(details.data.inverseInput));
  const supplied = canonicalJson(
    withoutReason(auditWireInput(run.params.input, run.op.contract.input))
  );
  if (supplied !== recorded) {
    throw new OpFailed(conflictError('admin undo input does not match the recorded inverse input'));
  }
}

/**
 * Drops `reason` for the undo comparison. An undo's justification is the
 * operator's own words, typed at undo time, and is never part of what the
 * inverse must reproduce. Dropping it from the RECORDED side too — not only
 * the submitted one — keeps rows written while op bodies still authored a
 * reason undoable, and makes the rule total: the recorded value is never
 * consulted, so a stray one cannot matter. `null` (a row that recorded no
 * inverse input at all) stays `null`, which no object input can equal.
 */
function withoutReason(input: Record<string, unknown> | null): Record<string, unknown> | null {
  if (input === null) return null;
  return Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'reason'));
}

/**
 * The audit copy of the input: the raw wire values (bigint money stays in
 * its string wire form — `parsed.data` cannot cross the jsonb boundary)
 * picked down to the contract schema's known keys, so unvalidated payload
 * keys never land in the permanent audit row.
 */
function auditWireInput(raw: unknown, schema: z.ZodObject): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return {};
  const source = raw as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(schema.shape)
      .filter((key) => key in source)
      .map((key) => [key, source[key]])
  );
}

/** The one op body + audit-in-tx path both modes share. */
async function performOp<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  tx: JobWakeCapable<SettlementTx>,
  run: OpRun<Deps, PostDeps>
): Promise<OpOutcome<PostDeps>> {
  const { op, parsed, params } = run;
  const violation = guardrailViolation(op.contract, parsed);
  if (violation !== null) {
    // The refusal is audited (Charter #7) on the transaction, behind the
    // caller's key-row claim like every other audit row — so a retry of a
    // refused request replays the recorded refusal instead of appending a
    // second permanent row to an append-only table.
    await deps.stores.insertAudit(tx, {
      actor: params.actor,
      role: params.role,
      action: op.contract.name,
      details: { refusal: violation, input: auditWireInput(params.input, op.contract.input) },
    });
    return { kind: 'refused', violation };
  }
  await assertUndoTarget(deps, tx, run);
  const ephemeralEffects: AdminEphemeralEffect<PostDeps>[] = [];
  const outcome = await op.execute(
    {
      tx,
      deps: deps.opDeps,
      ...(params.undoes === undefined ? {} : { undoes: params.undoes }),
      registerEphemeral: (effect) => ephemeralEffects.push(effect),
    },
    parsed
  );
  if (outcome.isErr()) throw new OpFailed(outcome.error);
  const value = outcome.value;
  assertInverseInput(op.contract, value.inverseInput);
  const details = {
    input: auditWireInput(params.input, op.contract.input),
    effects: value.effects,
    inverseInput: value.inverseInput ?? null,
  };
  assertWireJson(details, op.contract.name);
  const { id } = await deps.stores.insertAudit(
    tx,
    auditRowFor(op.contract.name, params, value.target, details)
  );
  await deps.hooks?.afterAudit?.({
    input: details.input,
    ...(params.undoes === undefined ? {} : { undoes: params.undoes }),
  });
  return {
    kind: 'performed',
    result: {
      auditId: id,
      effects: [...value.effects],
      inverseInput: value.inverseInput ?? null,
    },
    ephemeralEffects,
    ...(value.target === undefined ? {} : { target: value.target }),
  };
}

/**
 * The two defects an op body can commit in what it returns, both fatal at this
 * seam rather than typed refusals an operator could see: a durable op that
 * records no inverse (the Iron Law), and any op that authors the reason its
 * undo will carry — an undo's justification is the operator's own words, typed
 * at undo time, so the audit trail never holds a machine-written one.
 */
function assertInverseInput(
  contract: AnyAdminOpContract,
  inverseInput: Record<string, unknown> | undefined
): void {
  if (contract.effectClass === 'durable' && inverseInput === undefined) {
    throw new Error(
      `admin engine: durable op ${contract.name} returned no inverseInput (Iron Law)`
    );
  }
  if (inverseInput !== undefined && Object.hasOwn(inverseInput, 'reason')) {
    throw new Error(
      `admin engine: op ${contract.name} authored a reason inside its inverseInput ` +
        '(an undo reason is the operator’s own words, typed at undo time)'
    );
  }
}

/** Assembles the executed-effect audit row (target and undoes are optional). */
function auditRowFor(
  action: string,
  params: RunAdminOpParams,
  target: AdminOpTarget | undefined,
  details: unknown
): AdminAuditInsertRow {
  return {
    actor: params.actor,
    role: params.role,
    action,
    ...(target === undefined ? {} : { targetType: target.type, targetId: target.id }),
    details,
    ...(params.undoes === undefined ? {} : { undoes: params.undoes }),
  };
}

/** Audit details must survive the jsonb boundary — fail fast, not mid-insert. */
function assertWireJson(details: unknown, opName: string): void {
  try {
    JSON.stringify(details);
  } catch (error) {
    throw new Error(`admin engine: op ${opName} produced non-JSON audit details`, {
      cause: error,
    });
  }
}

/**
 * The target the operator ASKED FOR, read out of the validated input at the
 * field the contract itself names. Never a resolved target: an op body
 * resolves one only inside the transaction preview rolls back, and the field
 * is never guessed from its name — an op declaring no target leaves both
 * audit columns null.
 */
function suppliedTarget(
  contract: AnyAdminOpContract,
  parsed: Record<string, unknown>
): AdminOpTarget | undefined {
  const declared = contract.target;
  if (declared === null) return undefined;
  const id = parsed[declared.field];
  if (typeof id !== 'string') {
    throw new TypeError(
      `admin engine: op ${contract.name} declares target field '${declared.field}', ` +
        'which its validated input does not carry as a string'
    );
  }
  return { type: declared.type, id };
}

/**
 * The preview's own record of a sensitive read (Charter #12), written on the
 * request connection BEFORE the transaction opens. Both halves are
 * load-bearing: the transaction below always rolls back, so a row written on
 * it would roll back with the effect diff it exists to record, and writing
 * first keeps on the record a preview that refuses or throws once the
 * transaction is under way. A preview refused before the transaction opens —
 * an unregistered op name, an input that fails contract validation — writes
 * no row at all. It records what was asked for — the op, its wire input, and
 * the target the operator supplied — never what came back.
 */
async function writePreviewReadAudit<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  run: OpRun<Deps, PostDeps>
): Promise<void> {
  const target = suppliedTarget(run.op.contract, run.parsed);
  await writeReadAudit(deps.stores, deps.db, {
    actor: run.params.actor,
    role: run.params.role,
    action: READ_AUDIT_ACTIONS.opPreview,
    ...(target === undefined ? {} : { targetType: target.type, targetId: target.id }),
    details: {
      op: run.op.contract.name,
      input: auditWireInput(run.params.input, run.op.contract.input),
    },
  });
}

async function previewRun<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  run: OpRun<Deps, PostDeps>
): Promise<Result<AdminOpRunResult, DomainError>> {
  await writePreviewReadAudit(deps, run);
  try {
    // The body always throws (the sentinel), so this transaction never
    // commits — preview cannot lie because it IS execute, rolled back.
    return await runSettlement(deps.db, async (tx) => {
      const outcome = await performOp(deps, tx, run);
      // On the refused arm `performOp` wrote its refusal row on this
      // transaction, so that row rolls back with the rest: preview surfaces
      // the refusal as its blocking error, and the permanent record of a
      // refusal is the execute path's to write.
      if (outcome.kind === 'refused') throw new OpFailed(guardrailRefusedError(outcome.violation));
      throw new PreviewRollback(outcome.result);
    });
    // eslint-disable-next-line catch-swallow/no-silent-catch -- catches the preview-rollback sentinel; maps to a Result via mapRunError.
  } catch (error) {
    return mapRunError(error);
  }
}

async function executeRun<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  run: OpRun<Deps, PostDeps>
): Promise<Result<AdminOpRunResult, DomainError>> {
  const { op, params } = run;
  if (params.idempotencyKey === undefined || params.idempotencyKey === '') {
    return err(validationError('admin op execute requires an idempotency key'));
  }
  const scope: IdempotencyScope = {
    userId: await actorScopeId(params.actor),
    route: `admin/ops/${op.contract.name}`,
    key: params.idempotencyKey,
  };
  const bodyHash = await hashCanonicalJson({
    input: params.input,
    undoes: params.undoes ?? null,
  });
  const claim = await claimKeyRow(deps.db, {
    scope,
    kind: 'request',
    bodyHash,
    executorId: deps.executorId,
    leaseSeconds: REQUEST_LEASE_SECONDS,
  });
  if (claim.isErr()) return err(claim.error);
  const resolved = resolveClaimForExecute(claim.value, deps.executorId);
  if (resolved.outcome === 'replay') {
    return replayStoredResponse(resolved.response);
  }
  return executeClaimed(deps, run, resolved.fence);
}

/**
 * A committed refusal stores its violation as the key row's response, so a
 * retry answers with the identical refusal rather than re-running the check
 * and appending a second audit row. Every other stored response is a run
 * result.
 */
function replayStoredResponse(response: unknown): Result<AdminOpRunResult, DomainError> {
  const refusal = refusalResponseSchema.safeParse(response);
  if (refusal.success) return err(guardrailRefusedError(refusal.data.refusal));
  return ok(adminOpExecuteResultSchema.parse(response));
}

/**
 * Post-claim resolution, exported for the attach-defect test: the engine
 * always claims kind=request and `claimKeyRow` attaches only run-kind
 * claims, so no store state can reach the attach arm through `run()` itself
 * — this guards the contract against future state-machine changes.
 */
export function resolveClaimForExecute(
  claim: KeyRowClaim,
  executorId: string
): { outcome: 'replay'; response: unknown } | { outcome: 'execute'; fence: KeyRowFence } {
  if (claim.outcome === 'replay') {
    return { outcome: 'replay', response: claim.response };
  }
  if (claim.outcome === 'attach') {
    throw new Error('admin engine: attach outcome on a request-kind claim');
  }
  return {
    outcome: 'execute',
    fence: { id: claim.row.id, executorId, claims: claim.row.claims },
  };
}

async function executeClaimed<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  run: OpRun<Deps, PostDeps>,
  fence: KeyRowFence
): Promise<Result<AdminOpRunResult, DomainError>> {
  try {
    const outcome = await runSettlement(deps.db, async (tx) => {
      const inner = await performOp(deps, tx, run);
      // A refusal is a definitive answer to this request, so its key row
      // flips to succeeded carrying the refusal: the request is spent, and
      // retries replay it. Only an unfinished run stays retryable.
      const response = inner.kind === 'refused' ? { refusal: inner.violation } : inner.result;
      const flip = await succeedKeyRow(tx, fence, response);
      if (flip.isErr()) throw new OpFailed(flip.error);
      if (flip.value === 'lost') throw new FenceLost();
      return inner;
    });
    if (outcome.kind === 'refused') return err(guardrailRefusedError(outcome.violation));
    await runEphemeralEffects(outcome.ephemeralEffects, deps.postDeps, deps.telemetry);
    await notifyExecuted(deps, run, outcome);
    return ok(outcome.result);
  } catch (error) {
    // Drizzle has already rolled the transaction back: nothing committed —
    // no effects, no audit row (atomic total auditability).
    if (error instanceof FenceLost) return err(requestInProgressError());
    await markFailed(deps.db, fence);
    return mapRunError(error);
  }
}

/** Expected failures become Results; everything else is a defect and rethrows. */
function mapRunError(error: unknown): Result<AdminOpRunResult, DomainError> {
  if (error instanceof PreviewRollback) return ok(error.result);
  if (error instanceof OpFailed) return err(error.domainError);
  if (error instanceof UndoAlreadyClaimedError) {
    return err(conflictError('admin audit row has already been undone', error));
  }
  throw error;
}

/**
 * Best-effort failed flip (mirrors `byKey`): if the fence write itself fails
 * the row stays as it is and lease expiry takes over — recovery is
 * in-mechanism, never a second delivery path.
 */
async function markFailed(db: Database, fence: KeyRowFence): Promise<void> {
  const flip = await failKeyRow(db, fence);
  flip.unwrapOr('lost');
}

/**
 * Post-commit ephemeral effects (Redis watermark bumps, best-effort socket
 * eviction). Never inside the transaction, never in preview; a failure is
 * captured and never fails the already-committed op.
 */
async function runEphemeralEffects<PostDeps>(
  effects: readonly AdminEphemeralEffect<PostDeps>[],
  postDeps: PostDeps,
  telemetry: Telemetry
): Promise<void> {
  for (const effect of effects) {
    try {
      await effect.run(postDeps);
    } catch (error) {
      telemetry.captureError(
        error instanceof Error
          ? error
          : new Error('admin ephemeral effect threw a non-Error value'),
        FINGERPRINT_CODES.adminEphemeralEffectFailed
      );
    }
  }
}

/**
 * Best-effort post-commit notification (the `onExecuted` dep's contract).
 * Runs only on this path — a replay returns before `executeClaimed`, and a
 * preview never commits the op — so a committed execute notifies exactly
 * once. `reason` is read from the parsed input (every mutation contract
 * requires it).
 */
async function notifyExecuted<Deps, PostDeps>(
  deps: AdminOpEngineDeps<Deps, PostDeps>,
  run: OpRun<Deps, PostDeps>,
  performed: PerformedOp<PostDeps>
): Promise<void> {
  if (deps.onExecuted === undefined) return;
  // Every mutation contract requires `reason: z.string()` (Charter #6), so
  // the parsed value is a string by construction.
  const reason = run.parsed['reason'] as string;
  try {
    await deps.onExecuted({
      opName: run.op.contract.name,
      actor: run.params.actor,
      reason,
      ...(performed.target === undefined ? {} : { target: performed.target }),
      auditId: performed.result.auditId,
      isUndo: run.params.undoes !== undefined,
    });
  } catch (error) {
    deps.telemetry.captureError(
      error instanceof Error ? error : new Error('admin op notifier threw a non-Error value'),
      FINGERPRINT_CODES.adminOpNotificationFailed
    );
  }
}

/**
 * The idempotency scope's `userId` column is a uuid, but the admin actor is
 * the verified Cloudflare Access email claim. Derive a stable, deterministic
 * per-actor uuid from the canonical hash so the scope stays per-actor without
 * putting the identity in the uuid column.
 */
async function actorScopeId(actor: string): Promise<string> {
  return uuidFromHex(await hashCanonicalJson({ adminActor: actor }));
}
