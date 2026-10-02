/**
 * The single source of truth for the model ids the E2E suite and the seed
 * drive. The live OpenRouter catalog must EXPOSE every one of them (E2E media
 * is mock-synthesized in-process, not cassette-replayed — the mock produces a
 * canned PNG/MP4 for any image/video model, so no per-id cassette exists — but
 * the send path still resolves the real catalog descriptor, so a hidden or
 * mis-classified id fails the turn).
 *
 * The catalog itself is always real/live — populated by `catalog:refresh`
 * (the same job the hourly production cron runs) against OpenRouter's public
 * metadata endpoints, never by hand-authored descriptors. This constant does
 * not describe models; it names the subset E2E depends on and lets the refresh
 * fail loud (`assertE2eModelsPresent`) when the live catalog no longer exposes
 * one, or exposes it under the wrong call-shape family — the signal to update
 * this set.
 *
 * The image ids are exposed STRICT-family ids: their descriptor `outputs` are
 * exactly `["image"]`. That strictness is load-bearing — the
 * send path's `assertModelProducesModality` refuses a model whose `outputs`
 * aren't a single element equal to the requested modality, and a language-family
 * model (e.g. `["image","text"]`) echoes text through the mock instead of
 * synthesizing media. `assertE2eModelsPresent` enforces both exposure and
 * family agreement so a catalog drift back to a language-family id is caught at
 * `e2e:prepare`, not mid-test.
 *
 * Grouped by modality because the seed's group-chat factory (`pickSeedTextModels`)
 * and the app's model picker read exposed descriptors per call-shape family.
 *
 * `model-ids.ts` declares more than `E2E_MODELS`. Every other declaration
 * {@link assertE2eModelsPresent} validates answers to conditions of its own —
 * among them `PRESENCE_ONLY_MODELS`, the ids that seed stamps, demo fixtures and
 * the Smart Model spec name in their own literals, held to PRESENCE alone, and
 * `HOLD_PROBE_MODEL_ID`, held to presence plus a minimum admission hold. The
 * synthetic ids that file also declares are absent from the live catalog and
 * reach `model_catalog` only when the seed injects them, so
 * {@link assertSeededModelsPresent} holds those instead. What each guarantees,
 * and why one is not another, is written where it is declared.
 */
import { and, isNull } from 'drizzle-orm';
import {
  EMPTY_PROMPT_BASIS,
  ModelDescriptor,
  PAID_CUSHION_NANO_USD,
  REFUSAL_CODES,
  callShapeFamilyFor,
  freeDailyAllowanceNanoUsd,
  getAffordableOptions,
  getTurnOptions,
  isExposedModel,
  modelId,
  nanoUSD,
  planReasoningOff,
  reasoningPlanModelFrom,
  spendableFundsNanoUsd,
} from '@hushbox/shared';
import { poolModelFromDescriptor } from '@hushbox/shared/affordability';
import { createConsoleTelemetry, listDescriptors, trialEligibility } from '@hushbox/api/dev-seed';
import { modelCatalog, type Database } from '@hushbox/db';
import {
  E2E_MODELS,
  E2E_SEEDED_IMAGE_MODEL_ID,
  E2E_SEEDED_VIDEO_MODEL_IDS,
  E2E_TEXT_PINNED_EFFORT,
  HOLD_PROBE_MODEL_ID,
  PRESENCE_ONLY_MODELS,
} from './model-ids.js';
import { CORE_TEST_PERSONAS } from '../seed/personas.js';
import type { E2eModelSet } from './model-ids.js';
import type {
  Availability,
  CallShapeFamily,
  ExcludeReason,
  PriceableModel,
  RefusalCode,
  Selection,
} from '@hushbox/shared';

// The id data itself lives in `model-ids.ts`, free of runtime imports, so db-banned
// e2e code can share it; re-exported here so existing consumers keep one path.
export { E2E_MODELS, e2eModelIds } from './model-ids.js';

/**
 * How a guard explains an id that no sellable `model_catalog` row backs. The two
 * guards reach that branch for opposite reasons — one id is the gateway's to
 * publish, the other is this repo's to write — so a message shared between them
 * would offer one of them a step it cannot take.
 */
type AbsentRowRefusal = (id: string) => string;

/**
 * One declared set of ids, as a guard sees it: the constant a reader edits to
 * retire one, and how that set explains an id no sellable row backs. They travel
 * together because the remedy the refusal offers IS the constant's name. Each
 * declared set guarantees something the others do not, so a refusal naming the
 * wrong one advises exactly the move that breaks the set it moves into.
 */
interface Declaration {
  readonly name: string;
  readonly absentRefusal: AbsentRowRefusal;
}

/**
 * A live-catalog declaration. A refresh that discovered the id and turned it
 * down knows why, and that reason survives only in the summary it returns: an id
 * that was never admissible gets no row, so the decision is unreadable from the
 * catalog afterwards.
 */
function liveDeclaration(
  name: string,
  excludedReasonById: ReadonlyMap<string, ExcludeReason>
): Declaration {
  const absentRefusal: AbsentRowRefusal = (id) => {
    const excludedReason = excludedReasonById.get(id);
    if (excludedReason !== undefined) {
      // The refresh saw this id and turned it down, so none of the causes the
      // generic message offers applies and every one of them sends the reader to
      // debug a healthy pipeline.
      return (
        `e2e model '${id}' was discovered by the catalog refresh and excluded as ` +
        `'${excludedReason}' — the refresh succeeded and this id is genuinely not ` +
        `sellable; retire it from ${name}`
      );
    }
    // Two causes reach here: no row at all, and a row the catalog read filtered
    // as unsellable. Naming both keeps a soft-deleted id from being debugged as
    // a failed refresh.
    return (
      `e2e model '${id}' is not sellable in the live OpenRouter catalog — either ` +
      'absent, or soft-deleted (excluded_reason) or admin-disabled — update ' +
      `${name}, or the catalog refresh failed`
    );
  };
  return { name, absentRefusal };
}

/**
 * The seeded guard's refusal. Both remedies the live one offers are impossible
 * for a synthetic id — it is never in the gateway's catalog, and
 * `model-ids.ts` requires it to stay out of `E2E_MODELS` — so naming them
 * would send the reader nowhere. Exactly two causes remain, because this guard
 * runs immediately after `upsertCatalog` wrote the row and that upsert clears
 * `excluded_reason` while deliberately leaving `admin_disabled_at` alone.
 */
function seededDeclaration(name: string): Declaration {
  return {
    name,
    absentRefusal: (id) =>
      `seeded e2e model '${id}' has no sellable model_catalog row after the seed — ` +
      'this id is written by db:seed, never by any live catalog, so either its ' +
      'catalog upsert did not land or the row is admin-disabled (which no upsert ' +
      'clears); fix the seed, or re-enable the row',
  };
}

/**
 * How a guard explains a declared id whose sellable row the product's catalog
 * read drops. Reached only for an id every presence leg admitted — present,
 * unexcluded, un-admin-disabled, parseable and exposed — which leaves that
 * read's one remaining filter, the sighting window, as the cause. Nothing marks
 * a model the gateway stopped offering, because a refresh iterates only the
 * models its fetch returned, so an unadvancing sighting is the whole evidence a
 * retirement leaves and the state is permanent.
 */
function retiredRefusal(id: string, declarationName: string): string {
  return (
    `e2e model '${id}' is sellable but the product's catalog read no longer returns it — its ` +
    "row has gone unsighted past that read's freshness window, which is what a gateway " +
    `retirement looks like; retire it from ${declarationName}`
  );
}

/**
 * A declared id whose sellable row passed every presence leg, carrying the
 * constant that declares it so a later refusal can name the one a reader edits.
 */
interface SellableId {
  readonly id: string;
  readonly declarationName: string;
}

/** One declared id as its set presents it for grading. */
interface DeclaredId {
  readonly id: string;
  readonly family: CallShapeFamily;
}

/**
 * One declared set's presence verdict: the refusals its ids drew, and the ids
 * that drew none. The two halves travel together because {@link retiredRefusal}
 * is meaningful only for the second — an id a presence leg condemned has already
 * been explained, and explaining it again would name a cause that is not the one
 * that happened.
 */
interface PresenceVerdict {
  readonly failures: readonly string[];
  readonly sellable: readonly SellableId[];
}

function presenceVerdict(
  ids: readonly DeclaredId[],
  declaration: Declaration,
  byId: ReadonlyMap<string, unknown>
): PresenceVerdict {
  const failures: string[] = [];
  const sellable: SellableId[] = [];
  for (const { id, family } of ids) {
    const failure = validateE2eModel(id, family, declaration, byId.get(id));
    if (failure === undefined) sellable.push({ id, declarationName: declaration.name });
    else failures.push(failure);
  }
  return { failures, sellable };
}

/** The call-shape family each `E2E_MODELS` bucket must classify into. */
const FAMILY_BY_BUCKET = {
  text: 'language',
  image: 'image',
  video: 'video',
} as const satisfies Record<keyof E2eModelSet, CallShapeFamily>;

/**
 * Validate one E2E model id against its stored descriptor, returning the failure
 * message or `undefined` when it passes both the exposure and family-agreement
 * checks. Split out of {@link assertE2eModelsPresent} to keep each unit simple.
 * The absent branch belongs to the {@link Declaration} because it is the one leg
 * on which a live id and a seeded id have nothing in common.
 */
function validateE2eModel(
  id: string,
  expectedFamily: CallShapeFamily,
  declaration: Declaration,
  raw: unknown
): string | undefined {
  if (raw === undefined) {
    return declaration.absentRefusal(id);
  }
  const parsed = ModelDescriptor.safeParse(raw);
  if (!parsed.success) {
    return `e2e model '${id}' has a stored descriptor that fails its contract`;
  }
  const family = callShapeFamilyFor(parsed.data.outputs);
  if (!isExposedModel(parsed.data)) {
    return (
      `e2e model '${id}' is present but NOT exposed (needs zdrReachable, text ` +
      'input, and a single routable non-embedding output) — pick an exposed id'
    );
  }
  if (family !== expectedFamily) {
    return (
      `e2e model '${id}', declared in ${declaration.name}, has outputs ` +
      `[${parsed.data.outputs.join(', ')}] classifying as '${String(family)}', not ` +
      `'${expectedFamily}' — the send path requires a strict-family match`
    );
  }
  return undefined;
}

/**
 * The exposed catalog as the PRODUCT reads it, keyed by model id — one map
 * answering every question this guard puts to that read: whether a declared id
 * survives it at all, the descriptor the text legs grade, and the pool that
 * grading happens in. So the set an id is graded IN and the set it is graded
 * AGAINST cannot come apart.
 *
 * No call-shape family filter, deliberately: the eligibility verdict refuses a
 * non-text model itself, and the bucket's family obligation is settled over the
 * raw rows by {@link validateE2eModel} before any text leg runs. Filtering here
 * would buy nothing and would put the pool and the lookup back on separate
 * predicates.
 *
 * This is NOT {@link readSellableDescriptors}, and the two differ in what they
 * drop: this read applies the product's own exposure rules — the staleness
 * window, the corrupt-row skip, the descriptor-version refusal — so an id
 * missing from here is not necessarily one the presence legs condemned.
 */
async function exposedDescriptorsById(
  db: Database,
  nowMs: number
): Promise<Map<string, ModelDescriptor>> {
  const read = await listDescriptors({ db, telemetry: createConsoleTelemetry() }, nowMs);
  if (read.isErr()) {
    throw new Error(`the product's catalog read refused this catalog — ${read.error.message}`);
  }
  // Keyed by the descriptor's own id, which is how the turn path resolves a
  // selected model against this same read.
  return new Map(read.value.map((descriptor) => [descriptor.id, descriptor]));
}

/**
 * The two properties the text-turn-shape helper depends on, neither of them
 * implied by exposure:
 *
 * - THE OFF RUNG. The helper pins reasoning off so the characters a priced turn
 *   persists stay sizeable by the spec that asserts them. A mandatory-reasoning
 *   model presents no off row and a model with no reasoning metadata offers
 *   nothing to turn off; either way the helper throws mid-spec.
 * - SELECTABLE BY THE PAYER THE SPECS SEND AS. A model the product's
 *   eligibility gate refuses is refused to every payer below the paid tier
 *   whatever their funding, and the picker greys it and will not select it — so
 *   pinning one kills every spec whose payer is spending a free allowance.
 *
 * The second verdict is the PRODUCT'S, not one assembled here: what it weighs —
 * a live percentile of the model pool, a recency window, a minimal exchange
 * against the per-message cap — moves with the catalog and with the product's
 * own code, and a copy of the reasoning would answer the question the picker
 * answers only until one of them changed. A model that is selectable today can
 * stop being so with no commit in this repo, and that drift belongs here, where
 * it reddens the declaration, rather than in a spec two directories away, where
 * it surfaces one refused model at a time.
 */
function validateTextTurnShape(
  id: string,
  descriptor: ModelDescriptor,
  exposedCatalog: readonly ModelDescriptor[],
  nowMs: number
): string | undefined {
  if (!planReasoningOff(reasoningPlanModelFrom(descriptor), 1).feasible) {
    return (
      `e2e model '${id}' presents no reasoning-off rung — its reasoning is mandatory, or it ` +
      'has none to turn off — and the text-turn-shape helper pins that rung on every priced ' +
      'turn; declare a text model whose reasoning is optional'
    );
  }
  const verdict = trialEligibility(descriptor, exposedCatalog, nowMs);
  if (verdict.eligible) return undefined;
  if (verdict.reason === 'non-text') {
    return (
      `e2e model '${id}' does not answer a text turn, so the product's eligibility gate refuses ` +
      'it outright; declare a model whose one output is text'
    );
  }
  return (
    `e2e model '${id}' is premium — the picker refuses a premium row to any payer at a zero ` +
    'purchased balance, so the specs that spend a free allowance cannot select it; declare a ' +
    "text model the product's eligibility gate admits"
  );
}

/**
 * Every turn-shape failure the product's catalog implies for `E2E_MODELS.text` —
 * the one declared set that carries these two obligations. An id that read does
 * not expose is skipped rather than graded: there is no descriptor to grade, and
 * the skip reports nothing because something else already has — a presence leg
 * when the row is unsellable, corrupt or unexposed, {@link retiredRefusal} when
 * it is none of those.
 */
function textTurnShapeFailures(
  exposedById: ReadonlyMap<string, ModelDescriptor>,
  nowMs: number
): string[] {
  const exposedCatalog = [...exposedById.values()];
  const failures: string[] = [];
  for (const id of E2E_MODELS.text) {
    const descriptor = exposedById.get(id);
    if (descriptor === undefined) continue;
    const failure = validateTextTurnShape(id, descriptor, exposedCatalog, nowMs);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}

/**
 * Funds no priced text turn in the pool approaches, so the pinned-rung verdict
 * below turns on the models alone.
 */
const AMPLE_FUNDS_NANO_USD = 10n ** 18n;

/**
 * The verdict the effort menu renders for {@link E2E_TEXT_PINNED_EFFORT} when
 * both `E2E_MODELS.text` ids are selected together, as the multi-model spec
 * selects them: the turn producer's effort dimension, read rather than
 * re-derived, so the rung is graded with the context headroom and output caps
 * the product folds in. `undefined` means the producer presents no such rung.
 */
function pinnedEffortVerdict(
  exposedCatalog: readonly ModelDescriptor[],
  nowMs: number
): Availability | undefined {
  const [first, ...rest] = E2E_MODELS.text;
  const { affordable } = getAffordableOptions(
    {
      spendableNanoUsd: nanoUSD(AMPLE_FUNDS_NANO_USD),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    {
      answerSources: {
        models: [modelId(first), ...rest.map((id) => modelId(id))],
        smartSlot: false,
      },
      modality: 'text',
      pinned: {},
      webSearch: false,
    },
    { models: pricedPool(exposedCatalog), nowMs }
  );
  return affordable.turnDimensions
    .find((dimension) => dimension.dimensionId === 'effort')
    ?.options.find((option) => option.optionId === E2E_TEXT_PINNED_EFFORT)?.availability;
}

/**
 * The effort-rung failure `E2E_MODELS.text` carries as a PAIR: the multi-model
 * spec selects both ids and pins {@link E2E_TEXT_PINNED_EFFORT}, and a rung the
 * menu greys is one the spec cannot pick. Skipped when either id is not exposed,
 * because the pair the spec selects does not exist and a presence leg has
 * already said why.
 */
function pinnedEffortFailures(
  exposedById: ReadonlyMap<string, ModelDescriptor>,
  nowMs: number
): string[] {
  if (!E2E_MODELS.text.every((id) => exposedById.has(id))) return [];
  const verdict = pinnedEffortVerdict([...exposedById.values()], nowMs);
  if (verdict?.available === true) return [];
  const pair = E2E_MODELS.text.map((id) => `'${id}'`).join(' and ');
  const cause =
    verdict === undefined
      ? `the turn producer does not offer the '${E2E_TEXT_PINNED_EFFORT}' reasoning-effort rung for them at all`
      : `the turn producer greys the '${E2E_TEXT_PINNED_EFFORT}' reasoning-effort rung for '${verdict.reason}'`;
  return [
    `e2e models ${pair}, selected together, cannot run at the pinned effort — ${cause}. ` +
      'The multi-model spec pins that rung for this pair; declare text models that can run it ' +
      'in E2E_MODELS',
  ];
}

/**
 * What the hold-probe slot's own obligation comes to in nano-USD. The spec pins
 * its payer at half the measured hold less the paid negative-balance cushion, so
 * anything at or below twice that cushion pins the payer at or under zero and the
 * scarcity the spec drives is unreachable.
 */
const HOLD_PROBE_MINIMUM_NANO_USD = 2n * PAID_CUSHION_NANO_USD;

/** The seeded persona the hold-probe spec sends its priced turns as. */
const HOLD_PROBE_PAYER_NAME = 'test-alice';

/**
 * That payer's seeded spendable funds. A hold is only ever taken against
 * spendable and can never exceed it, so this is the largest hold the spec can
 * observe — pricing the leg below against anything richer would admit a model
 * whose hold no run of the suite produces.
 */
function holdProbePayerSpendableNanoUsd(): bigint {
  const payer = CORE_TEST_PERSONAS.find((persona) => persona.name === HOLD_PROBE_PAYER_NAME);
  /* v8 ignore next 3 -- the roster is a repo constant that names this persona; the
     branch exists so renaming it fails loudly instead of pricing against nothing */
  if (payer === undefined) {
    throw new Error(`the hold-probe payer '${HOLD_PROBE_PAYER_NAME}' is not a seeded persona`);
  }
  return spendableFundsNanoUsd(payer.balanceNanoUsd);
}

/**
 * The exposed catalog as the turn producer draws it: the SHARED pool
 * projection, so nothing here can price a model the send path would not draw,
 * or draw one it would have turned down. A row the projection refuses — no
 * per-token rates, no release date, an output the token turn cannot run — is
 * absent from the pool rather than present at some stand-in price.
 */
function pricedPool(exposedCatalog: readonly ModelDescriptor[]): PriceableModel[] {
  return exposedCatalog.flatMap((descriptor) => {
    const model = poolModelFromDescriptor(descriptor);
    return model === undefined ? [] : [model];
  });
}

/**
 * The admission hold one single-model text turn on `id` reserves, taken from the
 * SHARED turn producer rather than from arithmetic of this file's own: the spec
 * measures what that producer sized, so a second formula here could grade a model
 * the suite then finds holds something else.
 *
 * The basis is the producer's own zero-length one. This guard holds no prompt,
 * and the only term a real prompt moves is the input leg, which is orders below
 * the threshold the hold is graded against.
 */
function holdProbeHoldNanoUsd(
  id: string,
  exposedCatalog: readonly ModelDescriptor[],
  nowMs: number
): bigint | undefined {
  const models = pricedPool(exposedCatalog);
  const { holdNanoUsd } = getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(holdProbePayerSpendableNanoUsd()),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'paid',
      payer: 'self',
    },
    EMPTY_PROMPT_BASIS,
    {
      answerSources: { models: [modelId(id)], smartSlot: false },
      modality: 'text',
      pinned: {},
      webSearch: false,
    },
    { models, nowMs }
  );
  return holdNanoUsd === undefined ? undefined : BigInt(holdNanoUsd);
}

/**
 * The hold-size failure the hold-probe declaration carries, and the one leg no
 * other declared set answers to. An id the product's read does not expose is
 * skipped rather than graded, for the same reason the text legs skip one: there
 * is no descriptor to price, and a presence leg has already said why.
 */
function holdProbeFailures(
  exposedById: ReadonlyMap<string, ModelDescriptor>,
  nowMs: number
): string[] {
  if (!exposedById.has(HOLD_PROBE_MODEL_ID)) return [];
  const hold = holdProbeHoldNanoUsd(HOLD_PROBE_MODEL_ID, [...exposedById.values()], nowMs);
  if (hold !== undefined && hold > HOLD_PROBE_MINIMUM_NANO_USD) return [];
  const reserved =
    hold === undefined
      ? 'the turn producer can price no hold for it at all, so one turn on it reserves nothing'
      : `one turn on it reserves ${hold.toString()} nano-USD`;
  return [
    `e2e model '${HOLD_PROBE_MODEL_ID}' holds too little — ${reserved}. The hold-probe ` +
      `spec needs a hold above ${HOLD_PROBE_MINIMUM_NANO_USD.toString()} nano-USD, because ` +
      'it pins its payer at half the hold less the paid negative-balance cushion; declare ' +
      'a dearer text model in HOLD_PROBE_MODEL_ID',
  ];
}

/**
 * The turn a free-tier payer actually sends: the Smart Model slot, nothing
 * pinned, no web search. It is the composer's own default, so its verdict —
 * not that of some model a declaration happens to name — is what decides
 * whether that payer can send at all.
 */
const FREE_TIER_DEFAULT_SELECTION: Selection = {
  answerSources: { models: [], smartSlot: true },
  modality: 'text',
  pinned: {},
  webSearch: false,
};

/**
 * Where `REFUSAL_CODES` changes axis. That order is behaviour rather than
 * documentation, and the two axes meet at this code: ahead of it sit the TIER
 * verdicts, which no amount of the payer's money moves, and from it on sit the
 * turn arithmetic's answers about what the money buys. Read positionally so a
 * tier reason added later lands on the right leg with no edit here.
 */
const FIRST_FUNDING_REFUSAL_INDEX = REFUSAL_CODES.indexOf('insufficient_funds');

/** Whether the producer turned the pool down on funding rather than on tier. */
function refusedOnFunding(reason: RefusalCode): boolean {
  return REFUSAL_CODES.indexOf(reason) >= FIRST_FUNDING_REFUSAL_INDEX;
}

/**
 * Whether one day of the free daily allowance leaves that payer anything to
 * send on, answered by the SHARED turn producer over the exposed pool — the
 * same call the composer makes, so this cannot admit a catalog the product then
 * refuses, nor invent a second affordability rule to keep in step with the
 * first.
 *
 * `available` is exactly the conjunction the free tier needs. The slot resolves
 * only to a CANDIDATE, which is a row the payer's tier admits and the funding
 * covers, so one verdict settles both legs and neither can be satisfied alone.
 */
function freeTierSlotVerdict(pool: readonly PriceableModel[], nowMs: number): Availability {
  return getAffordableOptions(
    {
      spendableNanoUsd: freeDailyAllowanceNanoUsd(),
      heldNanoUsd: nanoUSD(0n),
      payerTier: 'free',
      payer: 'self',
    },
    FREE_TIER_DEFAULT_SELECTION,
    { models: pool, nowMs }
  ).smartSlot;
}

/**
 * The obligation the live catalog carries as a WHOLE, which no declared id
 * carries for it: something the gateway sells must be both within one day's
 * free allowance and a model the default selection would actually pick.
 *
 * It is absolute, against the free daily allowance itself, and it is over the
 * catalog rather than over any id. Neither property is anything the declared
 * ids answer for: {@link validateTextTurnShape} grades two named ids on the
 * product's eligibility verdict, whose money legs are a live percentile of the
 * pool and the TRIAL per-message cap — a different constant from the allowance,
 * against a different basis, on a turn that reserves no classifier. So the
 * allowance can stop buying the turn a free-tier payer sends with every
 * declared id still admitted.
 */
function freeTierSendFailures(
  exposedById: ReadonlyMap<string, ModelDescriptor>,
  nowMs: number
): string[] {
  const verdict = freeTierSlotVerdict(pricedPool([...exposedById.values()]), nowMs);
  if (verdict.available) return [];
  const allowance = `${freeDailyAllowanceNanoUsd().toString()} nano-USD`;
  if (refusedOnFunding(verdict.reason)) {
    return [
      'the free tier cannot send: one day of the free daily allowance — ' +
        `${allowance} — buys a minimum text turn on none of the live OpenRouter models the ` +
        `Smart Model default would pick, and the shared turn producer refuses the whole pool ` +
        `for '${verdict.reason}'. The affordability leg is what failed. No constant here ` +
        'names the model, so there is nothing to retire: either the gateway has repriced ' +
        'past the allowance, or the allowance no longer covers what it sells',
    ];
  }
  return [
    'the free tier cannot send, because nothing affordable is selectable: the Smart Model ' +
      'default — the turn a free-tier payer sends — can pick none of the live OpenRouter ' +
      `models on offer, refusing the whole pool for '${verdict.reason}' before the ` +
      `${allowance} daily allowance is weighed at all. The selectability leg is what ` +
      'failed. No constant here names the model, so there is nothing to retire: every model ' +
      "the gateway now sells is one the product's own selection gate turns down at this tier",
  ];
}

/**
 * The SELLABLE rows of `model_catalog`, folded to the stored descriptor per id.
 * The two unsellable authorities are filtered in the QUERY, not in the exposure
 * predicate:
 * both are row columns rather than descriptor fields, so a marked row keeps a
 * perfectly valid descriptor — ZDR-reachable, priced, strict-family — and would
 * otherwise satisfy every predicate below while `/models` hid it.
 */
async function readSellableDescriptors(db: Database): Promise<Map<string, unknown>> {
  const rows = await db
    .select({ modelId: modelCatalog.modelId, descriptor: modelCatalog.descriptor })
    .from(modelCatalog)
    .where(and(isNull(modelCatalog.excludedReason), isNull(modelCatalog.adminDisabledAt)));
  return new Map(rows.map((row) => [row.modelId, row.descriptor]));
}

/**
 * Fail-loud guard: every `E2E_MODELS` id must be a SELLABLE row of `model_catalog`
 * (the query filter in the read above — a soft-deleted or admin-disabled row is
 * hidden from `/models` while its descriptor stays valid) whose stored descriptor
 * is (1) EXPOSED (the shared `isExposedModel` the API's catalog read uses — mere
 * row presence let a hidden
 * model slip through) AND (2) in the call-shape family its
 * bucket requires (`text`→language, `image`→image, `video`→video — video
 * declares no id, so it contributes no check). Family
 * agreement catches a language-family model (e.g. `["image","text"]`) sitting in
 * the image bucket, which the send path would refuse. An id that clears every
 * one of those legs and is still missing from the product's own catalog read is
 * refused separately ({@link retiredRefusal}), because that read applies one
 * filter none of them can see — the sighting window. A `text` id carries two
 * further obligations, both of them what the suite's turn-shape helper needs and
 * neither implied by exposure — see {@link validateTextTurnShape} — and the text
 * ids together carry a third, the effort rung the multi-model spec pins for the
 * pair ({@link pinnedEffortFailures}). Every `PRESENCE_ONLY_MODELS` id runs the
 * same exposure and family legs and NONE of the text obligations, which is the
 * whole difference between that set and the text bucket. `HOLD_PROBE_MODEL_ID` runs those same legs and, in place of the text
 * obligations, one of its own — the admission hold a turn on it reserves must
 * exceed twice the paid negative-balance cushion ({@link holdProbeFailures}). One
 * leg answers to no declaration at all: the catalog as a whole must leave a
 * free-tier payer a model to send on ({@link freeTierSendFailures}). Any
 * failure lists which id failed which check, and stops the E2E pipeline before a
 * test drives a model the catalog can't back.
 *
 * Its venue is `e2e:prepare`, where the live catalog has just been refreshed:
 * every local E2E run and the CI job that runs one. A change under review
 * reaches none of that, by the pipeline's own design, so nothing here is a
 * guard on a pull request.
 */
export async function assertE2eModelsPresent(
  db: Database,
  excludedReasonById: ReadonlyMap<string, ExcludeReason>
): Promise<void> {
  // One clock reading for both halves: the product's read grades a row's last
  // sighting against it and the eligibility verdict grades a release date
  // against it, and the two must not see different instants.
  const nowMs = Date.now();
  const byId = await readSellableDescriptors(db);
  const exposedById = await exposedDescriptorsById(db, nowMs);
  const declared = presenceVerdict(
    (['text', 'image', 'video'] as const).flatMap((bucket) =>
      E2E_MODELS[bucket].map((id) => ({ id, family: FAMILY_BY_BUCKET[bucket] }))
    ),
    liveDeclaration('E2E_MODELS', excludedReasonById),
    byId
  );
  const presenceOnly = presenceVerdict(
    Object.values(PRESENCE_ONLY_MODELS).map((id) => ({ id, family: 'language' as const })),
    liveDeclaration('PRESENCE_ONLY_MODELS', excludedReasonById),
    byId
  );
  const holdProbe = presenceVerdict(
    [{ id: HOLD_PROBE_MODEL_ID, family: 'language' }],
    liveDeclaration('HOLD_PROBE_MODEL_ID', excludedReasonById),
    byId
  );
  const failures = [...declared.failures, ...presenceOnly.failures, ...holdProbe.failures];
  for (const { id, declarationName } of [
    ...declared.sellable,
    ...presenceOnly.sellable,
    ...holdProbe.sellable,
  ]) {
    if (!exposedById.has(id)) failures.push(retiredRefusal(id, declarationName));
  }
  failures.push(
    ...textTurnShapeFailures(exposedById, nowMs),
    ...pinnedEffortFailures(exposedById, nowMs),
    ...holdProbeFailures(exposedById, nowMs),
    ...freeTierSendFailures(exposedById, nowMs)
  );
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
}

/**
 * Post-seed fail-loud guard for synthetic media rows: each must be present,
 * exposed, and in the call-shape family its bucket requires — so the E2E catalog
 * carries enough distinct exposed strict-family ids for that modality's fan-out
 * to select two models. Runs AFTER `db:seed` (the pre-seed
 * {@link assertE2eModelsPresent} cannot cover a synthetic id, which is absent
 * from the live catalog it validates against). Reuses {@link validateE2eModel}
 * so the exposure + strict-family legs stay identical to the live guard's; the
 * absent leg deliberately does not, hence {@link seededDeclaration}.
 */
async function assertSeededModelsPresent(
  db: Database,
  ids: readonly string[],
  bucket: keyof E2eModelSet,
  declarationName: string
): Promise<void> {
  const byId = await readSellableDescriptors(db);
  const declaration = seededDeclaration(declarationName);
  const failures = ids
    .map((id) => validateE2eModel(id, FAMILY_BY_BUCKET[bucket], declaration, byId.get(id)))
    .filter((failure) => failure !== undefined);
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
}

/** The seeded strict-image row ({@link E2E_SEEDED_IMAGE_MODEL_ID}) landed. */
export async function assertSeededImageModelPresent(db: Database): Promise<void> {
  await assertSeededModelsPresent(
    db,
    [E2E_SEEDED_IMAGE_MODEL_ID],
    'image',
    'E2E_SEEDED_IMAGE_MODEL_ID'
  );
}

/**
 * Every seeded strict-video row ({@link E2E_SEEDED_VIDEO_MODEL_IDS}) landed. All
 * of them, not one: with no live video model exposed anywhere, these rows are
 * the entire video catalog the suite runs against.
 */
export async function assertSeededVideoModelsPresent(db: Database): Promise<void> {
  await assertSeededModelsPresent(
    db,
    E2E_SEEDED_VIDEO_MODEL_IDS,
    'video',
    'E2E_SEEDED_VIDEO_MODEL_IDS'
  );
}
