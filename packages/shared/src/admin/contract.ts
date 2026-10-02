import { z } from 'zod';
import { ADMIN_ROLES } from './roles.ts';
import type { AdminRole } from './roles.ts';

/** Admin op names are always `<area>.<verb>` (e.g. `wallet.credit`). */
export type AdminOpName = `${string}.${string}`;

/**
 * The effect shapes an op may have — the one statement of the set, so the
 * wire enum and every consumer read it rather than repeating it.
 * {@link AdminOpContract.effectClass} carries what each one means.
 */
export const ADMIN_OP_EFFECT_CLASSES = ['durable', 'ephemeral', 'system-owned'] as const;

/** One of {@link ADMIN_OP_EFFECT_CLASSES}. */
export type AdminOpEffectClass = (typeof ADMIN_OP_EFFECT_CLASSES)[number];

/**
 * Guardrails are op metadata, enforced by the engine before execute; an
 * over-cap request refuses and the refusal is audited.
 */
export interface AdminOpGuardrails {
  /** Absolute cap on a money input, in nano-USD. */
  readonly maxAmountNanoUsd?: bigint;
}

/**
 * Which input field carries an op's target, and the type that target is.
 * Every contract states this or states `null`; the engine never infers it,
 * because a name match would be a second source of truth about something the
 * contract already knows, and it would mis-attribute silently the first time
 * an op named its field differently.
 */
export interface AdminOpTargetDeclaration {
  /** Recorded as the audit row's polymorphic `targetType` (no FK by design). */
  readonly type: string;
  /**
   * A required string field of `input`, recorded as the row's `targetId`.
   * Typed `string` rather than `keyof In['shape']` deliberately: a key-derived
   * field type makes `AdminOpContract<In>` invariant in `In`, and every
   * specifically-typed contract then refuses to widen into
   * `AnyAdminOpContract` (the registry/list element type). The name is checked
   * against the input shape at definition time instead, so a typo throws at
   * module load rather than compiling.
   */
  readonly field: string;
}

/**
 * One admin operation, defined once and consumed by the admin slice's
 * engine and the SPA form renderer. Inputs are FLAT Zod objects (the
 * generic form renderer depends on it) — the one exception is a repeatable group, an
 * array of flat-scalar objects (see `isRepeatableGroup`) — and every
 * mutation input ends with a required non-blank `reason` that lands in the
 * audit row.
 */
export interface AdminOpContract<In extends z.ZodObject = z.ZodObject> {
  readonly name: AdminOpName;
  readonly title: string;
  readonly kind: 'mutation' | 'read';
  /**
   * One sentence the operator reads beside the op, for a fact the title has
   * no room for and the input schema cannot state — a number's caveat, most
   * of all. A count this op reports as a lower bound says so here, because
   * the reader of the number is the person who must not treat it as exact.
   */
  readonly description?: string;
  readonly input: In;
  /**
   * The Reversibility Iron Law: durable mutations MUST name a registered
   * inverse; every other effect class refuses one.
   */
  readonly inverse: AdminOpName | null;
  /**
   * Which shape an op's effect has, and with it whether the Iron Law demands
   * an inverse.
   *
   * - `durable` — state the operator originated. Names a registered inverse.
   * - `ephemeral` — nothing durable is left behind, because the body makes no
   *   call taking the settlement transaction handle. That obligation is
   *   checked structurally by the `admin-ephemeral-ops-take-no-transaction`
   *   arch rule rather than trusted, so the class cannot be claimed by a body
   *   that writes.
   * - `system-owned` — a durable effect that is the system's own obligation
   *   rather than the operator's act. States {@link systemOwnedReason} and
   *   names no inverse.
   *
   * `system-owned` is not an exception to the Iron Law. The Law binds admin
   * mutations, and these effects were never admin-originated — naming them is
   * what keeps the Law's scope honest. The alternative readings were rejected:
   * folding them into `durable` would demand a registered inverse for session
   * revocation, an operation that RESTORES revoked sessions, which is a
   * security hole nobody would build; folding them into `ephemeral` would call
   * a durable write ephemeral, which is a false name.
   */
  readonly effectClass: AdminOpEffectClass;
  /**
   * Why this op's durable effect is the system's rather than the operator's —
   * required on a `system-owned` op and rejected on any other, so the class
   * can never be taken silently: claiming it means stating the case for it in
   * the contract, where the reviewer reads it at authoring time — and again
   * in the op modal, where the operator reads it at run time, because
   * `packages/shared/src/admin/wire.ts` carries the field on the
   * `GET /admin/ops` catalog entry the admin SPA renders.
   */
  readonly systemOwnedReason?: string;
  /**
   * The target the operator supplies with the request, or `null` for an op
   * that supplies none. Required like `inverse` rather than optional, so the
   * declaration cannot fall behind the registry: an op that answers neither
   * way does not compile.
   */
  readonly target: AdminOpTargetDeclaration | null;
  /**
   * The admin roles that may run this op. Required, so a new op states its
   * audience rather than inheriting one, and non-empty — an op no role may
   * run is dead surface the registry would still advertise.
   *
   * A `mutation` may list only `operator`, refused at definition time by
   * {@link assertAllowedRoles}: a read-only role that could reach a mutation
   * is the failure this whole design exists to make unrepresentable, and a
   * check at call time would still let the wrong contract ship.
   */
  readonly allowedRoles: readonly AdminRole[];
  readonly guardrails?: AdminOpGuardrails;
}

/** A contract with its input widened — the registry/list element type. */
export type AnyAdminOpContract = AdminOpContract;

/** The one statement of the wrappers a contract field's chain may carry. */
export const VALUE_WRAPPERS = [
  z.ZodOptional,
  z.ZodNullable,
  z.ZodDefault,
  z.ZodPrefault,
  z.ZodReadonly,
  z.ZodCatch,
  z.ZodNonOptional,
] as const;

/** One of {@link VALUE_WRAPPERS}, whose `unwrap()` yields the schema it decorates. */
type ValueWrapper = InstanceType<(typeof VALUE_WRAPPERS)[number]>;

export function isValueWrapper(schema: z.core.$ZodType): schema is ValueWrapper {
  return VALUE_WRAPPERS.some((wrapper) => schema instanceof wrapper);
}

/**
 * Unwrap value wrappers so `z.object(...).optional()` cannot smuggle nesting.
 * A wrapper's `unwrap()` is typed to the core schema interface, which is what
 * every caller here reads through `instanceof`.
 */
function unwrapValueWrappers(schema: z.core.$ZodType): z.core.$ZodType {
  let current = schema;
  while (isValueWrapper(current)) {
    current = current.unwrap();
  }
  return current;
}

/**
 * Scalar kinds a top-level field may unwrap to. The flat law is FAIL-CLOSED:
 * anything not on this list (or a composite of it, below) — `z.any()`,
 * `z.unknown()`, `z.record()`, a new zod kind — is rejected at definition
 * time rather than admitted by omission, so no field can smuggle arbitrary
 * nested data past the shape walk.
 */
// ZodStringFormat (z.uuid(), z.email(), …) is a sibling of ZodString in
// zod 4, not a subclass — both are needed to cover string-valued fields.
const TOP_LEVEL_SCALAR_SCHEMAS = [
  z.ZodString,
  z.ZodStringFormat,
  z.ZodNumber,
  z.ZodBoolean,
  z.ZodEnum,
] as const;

function isFlatScalar(schema: z.ZodType): boolean {
  const current = unwrapValueWrappers(schema);
  // A lazy schema hides behind a getter that cannot be statically inspected
  // (and may recurse) — fail closed and reject it outright, even for scalars.
  if (current instanceof z.ZodLazy) {
    return false;
  }
  // Composite wrappers recurse: a union is flat iff every option is; an
  // intersection iff both sides are; a pipe iff its in side is and its out
  // side is flat or the transform itself (scalar transform pipes like
  // NanoUSD stay flat).
  if (current instanceof z.ZodUnion) {
    return (current.def.options as readonly z.ZodType[]).every((option) => isFlatScalar(option));
  }
  if (current instanceof z.ZodIntersection) {
    return (
      isFlatScalar(current.def.left as z.ZodType) && isFlatScalar(current.def.right as z.ZodType)
    );
  }
  if (current instanceof z.ZodPipe) {
    const outSide = current.def.out as z.ZodType;
    return (
      isFlatScalar(current.def.in as z.ZodType) &&
      (outSide instanceof z.ZodTransform || isFlatScalar(outSide))
    );
  }
  return TOP_LEVEL_SCALAR_SCHEMAS.some((scalar) => current instanceof scalar);
}

/**
 * Scalar kinds a repeatable-group sub-field may be. Deliberately narrower
 * than the top-level rule (no unions, no pipes): the form renderer draws a
 * group row as one input per sub-field, and only these map to one widget.
 */
const GROUP_SCALAR_SCHEMAS = [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodEnum] as const;

/**
 * A repeatable group — the one sanctioned departure from flat inputs: an
 * array of objects whose sub-fields are all flat scalars (each optionally
 * wrapped in optional/default/etc.). Anything deeper stays rejected.
 */
function isRepeatableGroup(schema: z.ZodType): boolean {
  const current = unwrapValueWrappers(schema);
  if (!(current instanceof z.ZodArray)) {
    return false;
  }
  const element = unwrapValueWrappers(current.def.element as z.ZodType);
  if (!(element instanceof z.ZodObject)) {
    return false;
  }
  // A catchall (looseObject/passthrough/.catchall) admits undeclared keys the
  // shape walk below never sees — arbitrary nesting would smuggle through.
  // Fail closed on ANY catchall, strict ones included.
  if (element.def.catchall !== undefined) {
    return false;
  }
  return Object.values(element.shape as Record<string, z.ZodType>).every((subField) => {
    const unwrapped = unwrapValueWrappers(subField);
    return GROUP_SCALAR_SCHEMAS.some((scalar) => unwrapped instanceof scalar);
  });
}

function assertInverseRule(contract: AnyAdminOpContract): void {
  if (contract.effectClass === 'durable') {
    if (contract.inverse === null) {
      throw new Error(`admin op ${contract.name}: durable ops must name an inverse (Iron Law)`);
    }
    return;
  }
  if (contract.inverse !== null) {
    throw new Error(
      `admin op ${contract.name}: ${contract.effectClass} ops never declare an inverse`
    );
  }
}

/**
 * The stated case for taking the `system-owned` class, required there and
 * refused everywhere else. Rejected on another class rather than ignored: the
 * catalog projection serializes whatever a contract states, so a reason
 * sitting on a `durable` op would be shown to the operator as a justification
 * the Law had accepted.
 */
function assertSystemOwnedReason(contract: AnyAdminOpContract): void {
  const stated = contract.systemOwnedReason;
  if (contract.effectClass !== 'system-owned') {
    if (stated !== undefined) {
      throw new Error(
        `admin op ${contract.name}: systemOwnedReason belongs only on a system-owned op`
      );
    }
    return;
  }
  if (stated === undefined || stated.trim() === '') {
    throw new Error(
      `admin op ${contract.name}: a system-owned op must state, in systemOwnedReason, ` +
        "why its durable effect is the system's and not the operator's"
    );
  }
}

/**
 * The mutation half of the role law. Stated as "every listed role is the
 * operator" rather than "the viewer is not listed", so a role added to
 * {@link ADMIN_ROLES} later is refused on mutations by default instead of
 * slipping past a name-specific check.
 */
function assertAllowedRoles(contract: AnyAdminOpContract): void {
  if (contract.allowedRoles.length === 0) {
    throw new Error(`admin op ${contract.name}: allowedRoles must list at least one role`);
  }
  for (const role of contract.allowedRoles) {
    if (!(ADMIN_ROLES as readonly string[]).includes(role)) {
      throw new Error(`admin op ${contract.name}: allowedRoles names unknown role '${role}'`);
    }
  }
  if (contract.kind !== 'mutation') return;
  const nonOperator = contract.allowedRoles.filter((role) => role !== 'operator');
  if (nonOperator.length > 0) {
    throw new Error(
      `admin op ${contract.name}: a mutation's allowedRoles may name only 'operator' ` +
        `(refused: ${nonOperator.join(', ')})`
    );
  }
}

function assertFlatInput(name: AdminOpName, shape: Record<string, z.ZodType>): void {
  for (const [key, field] of Object.entries(shape)) {
    if (isRepeatableGroup(field)) {
      continue;
    }
    if (!isFlatScalar(field)) {
      throw new Error(
        `admin op ${name}: input field '${key}' is not a recognized flat scalar — inputs must stay flat`
      );
    }
  }
}

function assertReasonField(name: AdminOpName, shape: Record<string, z.ZodType>): void {
  const reasonField = shape['reason'];
  if (!reasonField) {
    throw new Error(`admin op ${name}: mutation input must include reason`);
  }
  if (
    reasonField.safeParse('').success ||
    reasonField.safeParse(' \t\n ').success ||
    !reasonField.safeParse('valid reason').success
  ) {
    throw new Error(`admin op ${name}: reason must be a required non-blank string`);
  }
}

/**
 * A declared target field must be a required string field of the input:
 * `admin_audit.target_id` is text, and the engine projects the value straight
 * out of the validated input, so a wrapped field (optional, defaulted) or a
 * non-string one would record an absent or unrenderable id. Wrappers are
 * rejected rather than unwrapped — fail-closed, like the flat-input rule.
 */
function assertTargetDeclaration(
  contract: AnyAdminOpContract,
  shape: Record<string, z.ZodType>
): void {
  const declared = contract.target;
  if (declared === null) return;
  const field = shape[declared.field];
  if (
    field === undefined ||
    !(field instanceof z.ZodString || field instanceof z.ZodStringFormat)
  ) {
    throw new Error(
      `admin op ${contract.name}: target field '${declared.field}' must be a required string input field`
    );
  }
}

/**
 * A declared guardrail rides out of this factory as a REQUIRED slot, so a
 * consumer can oblige a capped op at build time instead
 * of at test time. Two overloads rather than one generic over the whole
 * literal: an argument typed by the literal is its own excess-property
 * target, which would silently accept `guardrail:` for `guardrails:` — a
 * typo that ships an op with no money cap at all. Each overload's parameter
 * stays a closed shape, so that check keeps firing.
 */
export function defineAdminOpContract<In extends z.ZodObject, G extends AdminOpGuardrails>(
  contract: AdminOpContract<In> & { readonly guardrails: G }
): AdminOpContract<In> & { readonly guardrails: G };
export function defineAdminOpContract<In extends z.ZodObject>(
  contract: AdminOpContract<In> & { readonly guardrails?: undefined }
): AdminOpContract<In>;
/**
 * Fail-fast constructor for admin op contracts. Throws at module load on a
 * contract violating the Iron Law (durable ⟺ inverse), a system-owned op
 * that states no reason for its class, the flat-input rule, a target
 * declaration the input cannot satisfy, or the required non-blank `reason`
 * on mutations.
 */
export function defineAdminOpContract<In extends z.ZodObject>(
  contract: AdminOpContract<In>
): AdminOpContract<In> {
  assertInverseRule(contract);
  assertSystemOwnedReason(contract);
  assertAllowedRoles(contract);
  const shape = contract.input.shape as Record<string, z.ZodType>;
  assertFlatInput(contract.name, shape);
  assertTargetDeclaration(contract, shape);
  if (contract.kind === 'mutation') {
    assertReasonField(contract.name, shape);
  }
  return contract;
}
