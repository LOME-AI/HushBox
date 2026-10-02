import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import * as affordability from './index.ts';
import * as root from '../index.ts';

/**
 * One symbol per relocated unit of the money layer. The barrel and the root
 * barrel must hand back the *same* binding, which is what makes the relocation
 * a move rather than a copy.
 *
 * Each representative must be a symbol both entry points still publish, so a
 * unit whose original representative is now behind the wall
 * ({@link WALLED_EXPORTS}) is represented by another of its own exports rather
 * than dropped — the move-not-copy property is about the unit, not the symbol.
 */
const RELOCATED_UNITS = [
  'TOTAL_FEE_RATE', // constants (fee rates)
  'STORAGE_COST_PER_CHARACTER', // constants (storage cost model)
  // money — the fee helpers themselves stay off this barrel (fee-seams rule);
  // the root barrel is their one sanctioned publication site.
  'usdToNanoUsd',
  'NANO_USD_PER_CENT', // nano-usd
  'getUserTier', // tiers
  'generateNotifications', // budget
  'FEE_CATEGORIES', // fees
  'inputTokensOf', // price quantities
  'CANONICAL_REASONING_EFFORTS', // reasoning-effort
  'MODALITIES', // modality
  'compileParamSpec', // param-spec
  'callShapeFamilyFor', // model-descriptor
  'levenshtein', // string distance
  'outputTokensOf', // estimate
  'buildClassifierSystemPrompt', // smart-model
  'resolveFunding', // billing
  'resolveClientBilling', // billing (client wrapper)
] as const;

/**
 * The money layer is content-free: no export accepts a prompt, a message or a
 * history array. These two took conversation text, so they live with the caller
 * that has the text rather than behind the money barrel. Pinned on both entry
 * points, because the root barrel re-exports this one.
 */
const CONTENT_SHAPED_NAMES = ['truncateForClassifier', 'buildClassifierMessages'] as const;

/**
 * The two reasoning-plan producers, published at both entry points.
 *
 * Four of their siblings — `reasoningPlanModelFrom`, `reasoningBudgetForWire`,
 * `ReasoningWire` and `REASONING_OFF_WIRE` — were already published, so the
 * wall never protected this family; keeping only these two behind it was an
 * inconsistency rather than a policy, and it forced a caller either to reach a
 * subpath or to re-derive `B + H` for itself, which is the mirrored-formula
 * shape `docs/CODE-RULES.md` bans. What stays walled is the LADDER these plans
 * are computed from (`REASONING_BUDGET_TOKENS_BY_EFFORT`), pinned below: a
 * caller may ask for a plan, never for the budget table behind it.
 */
const REASONING_PLAN_PRODUCERS = ['planReasoning', 'planReasoningOff'] as const;

/**
 * The Smart Model producers, published at both entry points, and each one an
 * answer rather than the apparatus behind it: the effort axis's cheapest option,
 * the effort plan that FITS a completion cap, and what one classifier answer
 * named among the ids a turn presented.
 *
 * The apparatus stays walled and is pinned below — the budget ladder, the
 * per-dimension matchers, the answer split. The cheapest option is not one of
 * them and never was: it is a query over the axis's own declared domain, which
 * is why it appears here with no wall entry to remove.
 */
const SMART_MODEL_PRODUCERS = [
  'cheapestClassifierEffort',
  'pickClassifiedEffortPlan',
  'resolveClassifierAnswer',
] as const;

/**
 * The money layer's export wall, as symbols. `docs/BILLING.md` §Where the Code
 * Lives states it as categories — "the minimum-answer constant, tier ratios,
 * the reasoning-budget ladder, rates, manifests, reducers, per-candidate
 * ceiling solvers, clamping" — and this is that list resolved against the
 * module's actual declarations, grouped in the doc's own order so a reader can
 * check the mapping rather than trust it.
 *
 * A consumer that needs one of these is evidence a producer is missing, which
 * is the wall's whole purpose; the interim reaches those consumers hold are
 * enumerated in {@link INTERIM_UNIT_SUBPATHS}.
 */
const WALLED_EXPORTS = [
  // the minimum-answer constant
  'MINIMUM_OUTPUT_TOKENS',
  // the characters-per-token ratios
  'INPUT_CHARS_PER_TOKEN',
  'STORED_CHARS_PER_OUTPUT_TOKEN',
  'storedTextAllowanceChars',
  'outputStorageNanoUsdPerToken',
  // the reasoning-budget ladder
  'REASONING_BUDGET_FLOOR_TOKENS',
  'REASONING_BUDGET_TOKENS_BY_EFFORT',
  'OfferedLevel',
  'offeredLevels',
  // manifests
  'Manifest',
  'NanoLineItem',
  'MediaRateKey',
  'NodeStorage',
  'classifierReserveChars',
  // reducers — over a manifest, and over a classifier answer
  'Affordability',
  'affordability',
  'evaluateManifest',
  'ReservationCeilingInput',
  'reservationCeiling',
  'ClassifierAnswerParts',
  'parseClassifierAnswer',
  'resolveClassifierOutput',
  // per-candidate ceiling solvers
  'DeclaredCeiling',
  'estimateRunCeilingNanoUsd',
  'PromptCapacity',
  'PromptCapacityInput',
  'computePromptCapacity',
  'ReasoningInfeasibleReason',
  'ReasoningPlan',
  'ReasoningPlanResult',
  'EffortOption',
  'ResolvedEffort',
  'resolveEffortForModel',
  'turnEffortOptions',
  // clamping
  'validCap',
] as const;

/**
 * The type-only members of the wall. Listed rather than inferred from casing
 * because the split decides which assertion carries the weight for a symbol: a
 * type has no runtime binding, so `Object.hasOwn` is vacuous for it and only
 * {@link publishedNames} can hold it to account.
 */
const WALLED_TYPE_ONLY_EXPORTS = new Set<string>([
  'OfferedLevel',
  'Manifest',
  'NanoLineItem',
  'MediaRateKey',
  'NodeStorage',
  'Affordability',
  'ReservationCeilingInput',
  'ClassifierAnswerParts',
  'DeclaredCeiling',
  'PromptCapacity',
  'PromptCapacityInput',
  'ReasoningInfeasibleReason',
  'ReasoningPlan',
  'ReasoningPlanResult',
  'EffortOption',
  'ResolvedEffort',
]);

/** The subset with a runtime binding, so `Object.hasOwn` can see it at all. */
const WALLED_VALUE_EXPORTS = WALLED_EXPORTS.filter((name) => !WALLED_TYPE_ONLY_EXPORTS.has(name));

/**
 * Consumers that still need a walled symbol reach the declaring unit directly,
 * through one subpath per unit. An entry exists either because the producer that
 * should serve the consumer does not exist yet, or — once it does — because the
 * consumer has not yet moved onto it; the subpath goes with that move, out of
 * the export map and out of this list together. The list is pinned so that
 * neither a new reach nor a forgotten one is silent — a unit still listed here
 * is a consumer still behind the wall.
 *
 * Per-unit rather than per-directory on purpose: a `./affordability/estimate`
 * subpath would republish the whole estimator and put the wall back where it
 * started, one entry point along.
 */
const INTERIM_UNIT_SUBPATHS = [
  './affordability/completion-cap',
  './affordability/constants',
  './affordability/estimate/effort-options',
  './affordability/estimate/reasoning-plan',
  './affordability/estimate/run-ceiling',
  './affordability/estimate/smart-model-affordability',
  './affordability/price/curve',
  './affordability/price/display',
  './affordability/price/reservation',
  './affordability/price/schedule',
  './affordability/price/trial',
  './affordability/price/wire',
] as const;

const ROOT_BARREL = fileURLToPath(new URL('../index.ts', import.meta.url));
const MODULE_BARREL = fileURLToPath(new URL('index.ts', import.meta.url));
const ESTIMATE_BARREL = fileURLToPath(new URL('estimate/index.ts', import.meta.url));
const SMART_MODEL_BARREL = fileURLToPath(new URL('smart-model/index.ts', import.meta.url));

/**
 * Every name an entry point publishes, types included. The runtime `import *`
 * above sees only value bindings, and more than a third of the wall is
 * type-only — so absence is also asserted against the export graph the
 * compiler sees, by walking `export *` chains from the barrel.
 *
 * This is package-local and deliberately narrow: it reads the two barrel files
 * of this package. The equivalent static rule in the arch harness is what
 * catches a re-export added from a package that has no such test.
 */
function publishedNames(entry: string): ReadonlySet<string> {
  const names = new Set<string>();
  const visited = new Set<string>();

  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    for (const statement of source.statements) {
      for (const name of exportedNames(statement)) names.add(name);
      const target = starTargetOf(file, statement);
      if (target !== undefined) visit(target);
    }
  };

  visit(entry);
  return names;
}

/** The names one statement publishes: a re-export clause, or its own declaration. */
function exportedNames(statement: ts.Statement): readonly string[] {
  if (ts.isExportDeclaration(statement)) return reExportedNames(statement.exportClause);
  if (!isExported(statement)) return [];
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations
      .map((declaration) => declaration.name)
      .filter((name): name is ts.Identifier => ts.isIdentifier(name))
      .map((name) => name.text);
  }
  return hasDeclarationName(statement) ? [statement.name.text] : [];
}

function reExportedNames(clause: ts.NamedExportBindings | undefined): readonly string[] {
  if (clause === undefined) return [];
  if (ts.isNamedExports(clause)) return clause.elements.map((element) => element.name.text);
  return [clause.name.text];
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  );
}

function hasDeclarationName(statement: ts.Statement): statement is ts.Statement & {
  name: ts.Identifier;
} {
  const named = statement as ts.Statement & { readonly name?: ts.Node };
  return named.name !== undefined && ts.isIdentifier(named.name);
}

/**
 * Every file in an entry point's `export *` closure that itself continues into
 * an unenumerated star — the doors the two inventory pins exist to gate.
 *
 * This is here because the claim "there are exactly these doors" was once a
 * sentence in this file, and it was wrong: `smart-model/index.ts` was a second
 * one, so a constant added to `smart-model/prompts.ts` reached both package
 * entry points with nothing red, and the test a reviewer would consult said the
 * estimator was the only such star. A negative existence claim that guards a
 * gate has to be executable, or it becomes false reassurance the moment the
 * shape it describes changes.
 */
function unenumeratedStarBarrels(entry: string): readonly string[] {
  const found = new Set<string>();
  const visited = new Set<string>();

  const visit = (file: string): void => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    );
    for (const statement of source.statements) {
      const target = starTargetOf(file, statement);
      if (target === undefined) continue;
      if (file !== entry) found.add(file);
      visit(target);
    }
  };

  visit(entry);
  return [...found].map((file) => path.relative(path.dirname(entry), file)).toSorted(byName);
}

/**
 * The file an `export *` continues into. Only a relative specifier is walked: a
 * bare one leaves the package and cannot hold a money symbol.
 */
function starTargetOf(from: string, statement: ts.Statement): string | undefined {
  if (!ts.isExportDeclaration(statement) || statement.exportClause !== undefined) return undefined;
  const specifier = statement.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteral(specifier)) return undefined;
  if (!specifier.text.startsWith('.')) return undefined;
  return path.resolve(path.dirname(from), specifier.text.replace(/\.js$/, '.ts'));
}

/**
 * The producers `docs/BILLING.md` §The public surface names — what feature code
 * touches. Held to the doc by {@link documentedProducerNames} below rather than
 * kept in step by hand: a name added to or dropped from the part of the section
 * that function reads fails the equality, so the doc and its executable pin
 * cannot disagree there in either direction.
 */
const DOCUMENTED_PRODUCERS = [
  'getTurnOptions',
  'resolveFunding',
  'notices',
  'getMediaTurnOptions',
  'minTurnCostNanoUsd',
  'textTurnBudget',
  'mediaTurnCostNanoUsd',
  'effortSelectionForTurn',
] as const;

/**
 * The named structural seams of the same section, which it describes by role
 * rather than by symbol — so unlike the producers above, these are resolved
 * against the module's declarations here.
 *
 * The two storage rates, the two functions that turn a count into storage
 * money, and the byte estimate those functions price are one seam, so they are
 * pinned together — the section names them in one breath ("the storage-fee
 * functions and the byte estimate they price"). A caller that can reach the
 * rate but not the function re-derives the product, and one that can price
 * bytes it cannot count re-derives the count. The display twin belongs to the
 * same seam, for the same reason.
 */
const DOCUMENTED_SEAMS = [
  'STORAGE_COST_PER_CHARACTER_NANO',
  'MEDIA_STORAGE_COST_PER_BYTE_NANO',
  'charStorageNanoUsd',
  'mediaStorageNanoUsd',
  'mediaOutputBytes',
  'charStorageDollars',
  'getUserTier',
  'tierCanAccessPremium',
  'isPremiumModel',
  'premiumPriceThresholdNanoUsd',
  'DIMENSIONS',
  'dimensionFor',
  'buildClassifierSystemPrompt',
  'nanoUnitPriceUsd',
] as const;

/**
 * What the module entry point answers for. This pins PRESENCE — the totality
 * pin (set equality against this list) waits until the interim per-unit
 * subpaths are gone, because until then a consumer reaching a walled unit is
 * still resolving, and a totality assertion would have to name every symbol
 * those consumers reach.
 */
const DOCUMENTED_SURFACE = [...DOCUMENTED_PRODUCERS, ...DOCUMENTED_SEAMS];

const BILLING_DOC = fileURLToPath(new URL('../../../../docs/BILLING.md', import.meta.url));

/**
 * The producer names `docs/BILLING.md` §The public surface publishes: every
 * backticked identifier on the section's lines before its first table row, plus
 * the backticked first cell of every table row. That derivation is the whole
 * read set — a name reachable only from the section's later prose is outside
 * it, which is what lets that prose discuss a producer without enlarging this
 * list.
 */
function documentedProducerNames(): readonly string[] {
  const section = publicSurfaceSection();
  const tableStart = section.findIndex((line) => line.startsWith('|'));
  const intro = tableStart === -1 ? section : section.slice(0, tableStart);
  const firstCells = section
    .filter((line) => line.startsWith('|'))
    .map((row) => row.split('|')[1]?.trim() ?? '')
    .filter((cell) => cell.startsWith('`'));
  const spans = intro.flatMap((line) =>
    [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '')
  );

  return [
    ...new Set(
      [...spans, ...firstCells]
        .map((span) => identifierOf(span))
        .filter((name): name is string => name !== undefined)
    ),
  ];
}

/** The section's lines: from its heading to the next heading of any depth. */
function publicSurfaceSection(): readonly string[] {
  const lines = readFileSync(BILLING_DOC, 'utf8').split('\n');
  const body = lines.slice(lines.indexOf('### The public surface') + 1);
  const end = body.findIndex((line) => line.startsWith('#'));
  return end === -1 ? body : body.slice(0, end);
}

/** A backticked span becomes a name when it reads as one, signature stripped. */
function identifierOf(span: string): string | undefined {
  const name = span.replaceAll('`', '').split('(')[0]?.trim() ?? '';
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

function byName(a: string, b: string): number {
  return a.localeCompare(b);
}

/**
 * The types the surface's own signatures name. A consumer that can call
 * `getTurnOptions` and cannot name what it returns has no usable API, so these
 * travel with it.
 */
const DOCUMENTED_SURFACE_TYPES = [
  'TurnOptions',
  'OptionSet',
  'ModelEntry',
  'DimensionAvailability',
  'Availability',
  'RefusalCode',
  'Selection',
  'FundingSnapshot',
  'PromptBasis',
  'PriceableModel',
  'ModelId',
  'Notice',
  'NoticeReason',
  'TextTurnBudget',
  'TextTurnBudgetInput',
  'MediaTurnCostInput',
  'TurnEffortSelectionInput',
] as const;

describe('the public surface', () => {
  it('pins exactly the producers `docs/BILLING.md` §The public surface names', () => {
    expect([...DOCUMENTED_PRODUCERS].toSorted(byName)).toEqual(
      [...documentedProducerNames()].toSorted(byName)
    );
  });

  it.each(DOCUMENTED_SURFACE)('binds %s on the affordability barrel', (name) => {
    expect(Object.hasOwn(affordability, name)).toBe(true);
  });

  it.each(DOCUMENTED_SURFACE)('binds %s on the package root barrel', (name) => {
    expect(Object.hasOwn(root, name)).toBe(true);
  });

  it.each(DOCUMENTED_SURFACE)('hands back one binding for %s at both entry points', (name) => {
    expect((affordability as Record<string, unknown>)[name]).toBe(
      (root as Record<string, unknown>)[name]
    );
  });

  it.each(DOCUMENTED_SURFACE_TYPES)('publishes the type %s at both entry points', (name) => {
    expect(publishedNames(MODULE_BARREL).has(name)).toBe(true);
    expect(publishedNames(ROOT_BARREL).has(name)).toBe(true);
  });
});

/**
 * One published producer family, pinned at both entry points. Parameterised
 * rather than copied for the reason {@link pinSubBarrelInventory} states below:
 * a second copy of these three assertions could drift into holding one family
 * more weakly than the other (`docs/CODE-RULES.md` §One Implementation, Shared).
 */
function pinProducerBindings(label: string, names: readonly string[]): void {
  describe(label, () => {
    it.each(names)('binds %s on the affordability barrel', (name) => {
      expect(Object.hasOwn(affordability, name)).toBe(true);
    });

    it.each(names)('binds %s on the package root barrel', (name) => {
      expect(Object.hasOwn(root, name)).toBe(true);
    });

    it.each(names)('hands back one binding for %s at both entry points', (name) => {
      expect((affordability as Record<string, unknown>)[name]).toBe(
        (root as Record<string, unknown>)[name]
      );
    });
  });
}

pinProducerBindings('the reasoning plan producers', REASONING_PLAN_PRODUCERS);
pinProducerBindings('the Smart Model producers', SMART_MODEL_PRODUCERS);
pinProducerBindings('the effort menu copy', [
  'REASONING_EFFORT_LABELS',
  'REASONING_EFFORT_DESCRIPTIONS',
]);

describe('the reasoning plan ladder', () => {
  it('keeps the ladder the plans are built from behind the wall', () => {
    expect(Object.hasOwn(affordability, 'REASONING_BUDGET_TOKENS_BY_EFFORT')).toBe(false);
    expect(Object.hasOwn(root, 'REASONING_BUDGET_TOKENS_BY_EFFORT')).toBe(false);
  });
});

describe('affordability barrel', () => {
  it.each(RELOCATED_UNITS)('exposes %s', (name) => {
    expect(Object.hasOwn(affordability, name)).toBe(true);
  });

  it.each(CONTENT_SHAPED_NAMES)('does not export the content-shaped %s', (name) => {
    expect(Object.hasOwn(affordability, name)).toBe(false);
  });

  it.each(CONTENT_SHAPED_NAMES)('keeps the content-shaped %s off the root barrel', (name) => {
    expect(Object.hasOwn(root, name)).toBe(false);
  });

  it.each(RELOCATED_UNITS)('hands back the same binding as the root barrel for %s', (name) => {
    expect((affordability as Record<string, unknown>)[name]).toBe(
      (root as Record<string, unknown>)[name]
    );
  });
});

/**
 * One block per entry point. Both matter: a symbol absent from one and present
 * on the other is a hole, not a partial pass, because either resolves from
 * every workspace.
 */
describe('the export wall — the `@hushbox/shared/affordability` entry point', () => {
  const published = publishedNames(MODULE_BARREL);

  it('walks `export *` chains, so absence below means absence', () => {
    expect(published.has('getUserTier')).toBe(true);
    expect(published.has('FundingDecision')).toBe(true);
    expect(published.has('truncateForClassifier')).toBe(false);
  });

  it.each(WALLED_VALUE_EXPORTS)('does not bind %s', (name) => {
    expect(Object.hasOwn(affordability, name)).toBe(false);
  });

  it.each(WALLED_EXPORTS)('does not publish %s', (name) => {
    expect(published.has(name)).toBe(false);
  });
});

describe('the export wall — the package root entry point', () => {
  const published = publishedNames(ROOT_BARREL);

  it('walks `export *` chains, so absence below means absence', () => {
    expect(published.has('getUserTier')).toBe(true);
    expect(published.has('FundingDecision')).toBe(true);
    expect(published.has('truncateForClassifier')).toBe(false);
  });

  it.each(WALLED_VALUE_EXPORTS)('does not bind %s', (name) => {
    expect(Object.hasOwn(root, name)).toBe(false);
  });

  it.each(WALLED_EXPORTS)('does not publish %s', (name) => {
    expect(published.has(name)).toBe(false);
  });
});

/**
 * The barrel inventories, and why there are three of them.
 *
 * The two blocks above pin the wall by naming what must be ABSENT, which cannot
 * see a name that was never on the list. The money layer's own barrel is pinned
 * as a whole set below, so any export added there fails whatever route it
 * arrived by — a name walled by policy and a name nobody meant to publish are
 * the same event to a set-equality assertion, and it needs no view about which.
 *
 * The two sub-barrel pins are not made redundant by it. `index.ts` reaches three
 * sub-barrels through `export *`, and two of them star their own units without
 * spelling the names out — `estimate/index.ts` and `smart-model/index.ts` — so
 * the sub-barrel pins name the door a widening came through instead of only
 * reporting that the surface moved. (`dimensions/index.ts` is the third, and it
 * enumerates every export, so a new name there is already a visible edit.)
 *
 * An inventory, not a wall list: the assertion is set equality, so it fails on a
 * name ADDED as loudly as on one removed. Both directions are what it is for —
 * a removal is a break for a consumer, an addition is an unreviewed widening of
 * the money surface.
 */
/**
 * Every name the money layer's own barrel publishes, in one set. The wall
 * blocks above say what may not appear here; this says what does, so an export
 * that no policy list happens to name still cannot arrive unreviewed. It is the
 * whole surface `@hushbox/shared/affordability` offers, and every entry earned
 * its place in a reviewed edit.
 */
const MODULE_BARREL_SURFACE = [
  'Activation',
  'AddAvailability',
  'AffordableOptions',
  'ALL_FEE_CATEGORIES',
  'answerRoomTokens',
  'AnswerSources',
  'AnyDimensionId',
  'Availability',
  'bindingGroupLimit',
  'BudgetError',
  'buildClassifierSystemPrompt',
  'CALL_SHAPE_FAMILIES',
  'CallShapeFamily',
  'callShapeFamilyFor',
  'CallUsage',
  'CandidateModelEntry',
  'CANONICAL_REASONING_EFFORTS',
  'CanonicalReasoningEffort',
  'canUseModel',
  'CAPACITY_RED_THRESHOLD',
  'CAPACITY_YELLOW_THRESHOLD',
  'carveToolLoopSteps',
  'CatalogSnapshot',
  'centsToNanoUsd',
  'classifierEngineOf',
  'CHARACTERS_PER_KILOBYTE',
  'charStorageDollars',
  'charStorageNanoUsd',
  'cheapestClassifierEffort',
  'CLASSIFIER_EFFORT_DIMENSION_MARKER',
  'CLASSIFIER_MAX_DESCRIPTION_CHARS',
  'CLASSIFIER_MODEL_DIMENSION_MARKER',
  'CLASSIFIER_OUTPUT_TOKEN_CAP',
  'CLASSIFIER_SYSTEM_PROMPT_MARKER',
  'ClassifierEffortLevel',
  'ClassifierEligibleModel',
  'ClassifierPromptDimensions',
  'ClassifierResolution',
  'ClientBillingInput',
  'ClientFundingContext',
  'combinedRateNanoUsd',
  'compileParamSpec',
  'computeClassifierPromptOverhead',
  'contextFillBand',
  'ContextFillBand',
  'CREDIT_CARD_FEE_RATE',
  'DeclaredMediaDomains',
  'DenialReason',
  'deriveClientFundingInputs',
  'DIMENSION_COST_CLASSES',
  'DIMENSION_IDS',
  'DIMENSION_RESOLUTIONS',
  'DIMENSION_RESOURCES',
  'DimensionAvailability',
  'DimensionCostClass',
  'dimensionFor',
  'DimensionId',
  'dimensionOptionAvailability',
  'DimensionModel',
  'DimensionOption',
  'DimensionResolution',
  'DimensionResource',
  'DIMENSIONS',
  'DimensionSpec',
  'DimensionSupport',
  'dollarsToCents',
  'dollarsToNanoUsd',
  'EffortChoice',
  'effortFitsAnswerRoom',
  'effortSelectionForTurn',
  'EMPTY_PROMPT_BASIS',
  'ESTIMATED_AUDIO_BYTES_PER_SECOND',
  'ESTIMATED_IMAGE_BYTES',
  'ESTIMATED_VIDEO_BYTES_PER_SECOND',
  'estimateErr',
  'EstimateError',
  'EstimateErrorCode',
  'estimateOk',
  'EstimateResult',
  'exceedsModelAgeLimit',
  'exceedsTrialBudget',
  'EXPENSIVE_MODEL_THRESHOLD_PER_1K',
  'FEE_BUCKET_BY_ID',
  'FEE_CATEGORIES',
  'FeeBucketId',
  'FeeCategory',
  'FeeCategoryId',
  'formatFeePercent',
  'freeDailyAllowanceNanoUsd',
  'FREE_ALLOWANCE_CENTS_VALUE',
  'FundingDecision',
  'FundingInputs',
  'FundingSnapshot',
  'FundingSource',
  'FundingVerdict',
  'generateNotifications',
  'getAffordableOptions',
  'getCushionNano',
  'getEffectiveBalanceNano',
  'getMediaTurnOptions',
  'getTurnOptions',
  'getUserTier',
  'groupHeadroom',
  'HoldAwareGroupDimensions',
  'holdAwareGroupHeadroom',
  'HUSHBOX_FEE_RATE',
  'inputTokensOf',
  'isExpensiveModelNano',
  'isOverContextCapacity',
  'isPremiumModel',
  'isRunnableModelShape',
  'isToolName',
  'isTransientBlock',
  'KILOBYTES_PER_GIGABYTE',
  'levenshtein',
  'LOW_BALANCE_OUTPUT_TOKEN_THRESHOLD',
  'MARKUP_BASIS_POINTS',
  'MAX_ALLOWED_NEGATIVE_BALANCE_CENTS',
  'MAX_CLASSIFIER_CONTEXT_CHARS',
  'MAX_MODEL_AGE_MS',
  'MAX_TRIAL_MESSAGE_COST_CENTS',
  'MEDIA_DIMENSION_IDS',
  'MEDIA_DIMENSIONS',
  'MEDIA_MONTHLY_COST_PER_GB',
  'MEDIA_PARAMETER_NAMES',
  'MEDIA_REFERENCE_UNITS',
  'MEDIA_STORAGE_COST_PER_BYTE',
  'MEDIA_STORAGE_COST_PER_BYTE_NANO',
  'MediaCallQuantity',
  'MediaDimensionAvailability',
  'mediaDimensionFor',
  'MediaDimensionId',
  'MediaModel',
  'MediaModelEntry',
  'mediaModelFrom',
  'mediaModelFromWire',
  'MediaOptionSet',
  'mediaOutputBytes',
  'MediaParameterName',
  'mediaParameterSpecs',
  'MediaSelection',
  'mediaStorageNanoUsd',
  'MediaTurnCostInput',
  'mediaTurnCostNanoUsd',
  'MediaTurnOptions',
  'MessageSegment',
  'MIN_POOL_FOR_PRICE_PERCENTILE',
  'MIN_PRICE_PER_1K_TOKENS_NANO',
  'MinTurnCostInput',
  'MinTurnCostSibling',
  'minTurnCostNanoUsd',
  'MODALITIES',
  'Modality',
  'ModelDescriptor',
  'ModelEntry',
  'modelId',
  'ModelId',
  'modelPriceDisplay',
  'ModelPriceDisplay',
  'ModelReasoning',
  'MONTHLY_COST_PER_GB',
  'MONTHS_PER_YEAR',
  'NANO_USD_PER_CENT',
  'NANO_USD_PER_DOLLAR',
  'nanoPricePer1k',
  'nanoPriceRangePer1k',
  'nanoRateCompactPer1k',
  'nanoUnitPriceUsd',
  'nanoUSD',
  'NanoUSD',
  'nanoUsdToCents',
  'nanoUsdToDollarString',
  'nanoUsdToFourPlaceDollarString',
  'nanoUsdToFullDollarString',
  'nanoUsdToTwoPlaceDollarString',
  'NonEmpty',
  'Notice',
  'NOTICE_COPY',
  'NOTICE_REASONS',
  'NoticeCopy',
  'NoticeReason',
  'notices',
  'noticeText',
  'noticeTextOf',
  'NotificationInput',
  'OpenDimension',
  'OptionAvailability',
  'OptionId',
  'OptionLabel',
  'OptionSet',
  'outputTokensOf',
  'OwnerFundingLimit',
  'PAID_CUSHION_NANO_USD',
  'PARAM_TYPES',
  'PARAM_WIRES',
  'ParamSpec',
  'ParamType',
  'ParamWire',
  'parseNanoUSD',
  'PayerSwitchReason',
  'pickClassifiedEffortPlan',
  'PinnedModelEntry',
  'planReasoning',
  'planReasoningOff',
  'PoolCandidateRow',
  'poolModelFrom',
  'poolModelFromDescriptor',
  'poolModelFromWire',
  'PREMIUM_PRICE_PERCENTILE',
  'PREMIUM_RECENCY_MS',
  'PremiumClassificationInput',
  'premiumPriceThresholdNanoUsd',
  'PriceableModel',
  'priceableModelFrom',
  'priceFloorVerdict',
  'PriceFloorVerdict',
  'PromptBasis',
  'promptBasisFromTotal',
  'promptCharsOf',
  'PROVIDER_FEE_RATE',
  'ProviderParams',
  'REASONING_EFFORT_DESCRIPTIONS',
  'REASONING_EFFORT_LABELS',
  'REASONING_EFFORT_SELECTIONS',
  'REASONING_OFF',
  'REASONING_OFF_WIRE',
  'reasoningBudgetForTurn',
  'reasoningBudgetForWire',
  'ReasoningBudgetInput',
  'ReasoningBudgetModel',
  'ReasoningEffortSelection',
  'ReasoningOff',
  'ReasoningPlanDescriptorInput',
  'ReasoningPlanModel',
  'reasoningPlanModelFrom',
  'reasoningPlanModelOf',
  'ReasoningWire',
  'REFUSAL_CODES',
  'RefusalCode',
  'refusalPrecedence',
  'refusesRegenerate',
  'ReserveContribution',
  'ResolveBillingResult',
  'resolveClassifierAnswer',
  'resolveClientBilling',
  'RESOLVED_REASONING_EFFORTS',
  'ResolvedReasoningEffort',
  'resolveFunding',
  'roundHalfEvenDiv',
  'roundPreservingSum',
  'Selection',
  'SELECTION_CAUSED_COPY',
  'SelectionCausedReason',
  'serializeNanoUSD',
  'smartSlotAvailability',
  'SmartSlotMinTurnCostInput',
  'smartSlotMinTurnCostNanoUsd',
  'spendableFundsNanoUsd',
  'STORAGE_COST_PER_1K_CHARS',
  'STORAGE_COST_PER_CHARACTER',
  'STORAGE_COST_PER_CHARACTER_NANO',
  'STORAGE_YEARS',
  'StoredMediaModality',
  'textTurnBudget',
  'TextTurnBudget',
  'TextTurnBudgetInput',
  'tierCanAccessPremium',
  'TOOL_CALL_CAP_MAX',
  'TOOL_DECLARATIONS',
  'TOOL_NAMES',
  'toolCallBillableNano',
  'toolCallCapFor',
  'toolCallChargeNanoUsd',
  'toolCallsOfSteps',
  'ToolLoopBound',
  'toolLoopBound',
  'toolLoopStepsFor',
  'ToolName',
  'TOP_CONTEXT_PERCENTILE',
  'topContextExemptionTokens',
  'TOTAL_FEE_RATE',
  'TRIAL_AFFORDABILITY_MULTIPLIER',
  'trialDailyMessageAllowance',
  'TRIAL_MESSAGE_COST_CAP_NANO_USD',
  'TRIAL_MESSAGE_LIMIT',
  'trialFundingSnapshot',
  'TurnEffortSelectionInput',
  'TurnOptions',
  'unpinnedEffortOf',
  'usdToNanoUsd',
  'USER_TIERS',
  'UserBalanceState',
  'UserTier',
  'UserTierInfo',
  'WEB_SEARCH_RESULT_MAX_CHARS',
  'WELCOME_CREDIT_CENTS',
] as const;

const ESTIMATE_SUBBARREL_SURFACE = [
  // storage rates and the byte estimate they price
  'STORAGE_COST_PER_CHARACTER_NANO',
  'MEDIA_STORAGE_COST_PER_BYTE_NANO',
  'charStorageNanoUsd',
  'mediaStorageNanoUsd',
  'StoredMediaModality',
  'mediaOutputBytes',
  // display formatters
  'nanoPricePer1k',
  'nanoPriceRangePer1k',
  'nanoRateCompactPer1k',
  'isExpensiveModelNano',
  'nanoUnitPriceUsd',
  // the fail-closed result channel
  'estimateErr',
  'estimateOk',
  'EstimateError',
  'EstimateErrorCode',
  'EstimateResult',
  // funding pre-adapters
  'getCushionNano',
  'getEffectiveBalanceNano',
  'PAID_CUSHION_NANO_USD',
  'spendableFundsNanoUsd',
  // the one run-ceiling term a caller may name
  'outputTokensOf',
  'CallUsage',
  // the reasoning-plan producers and their wire fragment
  'REASONING_OFF_WIRE',
  'ReasoningWire',
  'planReasoning',
  'planReasoningOff',
  'reasoningBudgetForWire',
  'reasoningPlanModelFrom',
  'ReasoningPlanDescriptorInput',
  'ReasoningPlanModel',
  // the three coarse producers of `docs/BILLING.md` §The public surface
  'EffortChoice',
  'effortSelectionForTurn',
  'TurnEffortSelectionInput',
  // the turn's reasoning budget, reduced across the models it draws on
  'reasoningBudgetForTurn',
  'ReasoningBudgetInput',
  'ReasoningBudgetModel',
  'mediaTurnCostNanoUsd',
  'MediaTurnCostInput',
  'textTurnBudget',
  'TextTurnBudget',
  'TextTurnBudgetInput',
] as const;

/**
 * Every name the Smart Model sub-barrel publishes. The second unenumerated star
 * off `index.ts`, and the reason this is a pair rather than a single pin: a
 * constant added to `smart-model/prompts.ts` reaches both package entry points
 * exactly as an estimator export does.
 *
 * The classifier-answer reducers next door in `effort-dimension.ts` are NOT
 * here, and that is the wall working rather than an omission — the sub-barrel
 * takes one named type from that unit and stars neither it nor the reducers,
 * which {@link WALLED_EXPORTS} independently pins absent.
 */
const SMART_MODEL_SUBBARREL_SURFACE = [
  // the classifier prompt template and its shape
  'buildClassifierSystemPrompt',
  'computeClassifierPromptOverhead',
  'ClassifierEligibleModel',
  'ClassifierPromptDimensions',
  // the prompt's own bounds and markers
  'MAX_CLASSIFIER_CONTEXT_CHARS',
  'CLASSIFIER_MAX_DESCRIPTION_CHARS',
  'CLASSIFIER_SYSTEM_PROMPT_MARKER',
  'CLASSIFIER_MODEL_DIMENSION_MARKER',
  'CLASSIFIER_EFFORT_DIMENSION_MARKER',
  // the classifier call's output cap
  'CLASSIFIER_OUTPUT_TOKEN_CAP',
  // the one name taken from the effort dimension; its reducers stay walled
  'ClassifierEffortLevel',
  // the axis's cheapest option — a query over the declared domain
  'cheapestClassifierEffort',
  // the effort plan that fits a completion cap; the ladder behind it stays walled
  'pickClassifiedEffortPlan',
  // one answer resolved against the presented ids; the parse and the matchers stay walled
  'ClassifierResolution',
  'resolveClassifierAnswer',
] as const;

/**
 * One pin per unenumerated star, parameterised rather than copied: the two
 * inventories differ, the assertions that give them their meaning do not, and a
 * second copy of those assertions could drift into gating one door more weakly
 * than the other (`docs/CODE-RULES.md` §One Implementation, Shared).
 *
 * `removal` names a statement the barrel really contains; the probe asserts the
 * name it publishes is gone, so a stale statement string fails loudly instead of
 * silently turning the removal probe into a no-op.
 */
interface SubBarrelPin {
  readonly label: string;
  readonly barrel: string;
  readonly inventory: readonly string[];
  readonly removal: { readonly statement: string; readonly name: string };
}

function pinSubBarrelInventory({ label, barrel, inventory, removal }: SubBarrelPin): void {
  /**
   * The chain is copied outside the tree before it is edited: `packages/shared`
   * resolves to source, so an in-tree probe is live to every workspace the
   * instant it is written.
   */
  const copyChain = (edit: (source: string) => string): string => {
    const directory = mkdtempSync(path.join(tmpdir(), 'sub-barrel-'));
    copies.push(directory);
    cpSync(path.dirname(barrel), directory, {
      recursive: true,
      filter: (source) => !source.endsWith('.test.ts'),
    });
    const copied = path.join(directory, path.basename(barrel));
    writeFileSync(copied, edit(readFileSync(copied, 'utf8')));
    return copied;
  };
  const copies: string[] = [];
  const expected = [...inventory].toSorted(byName);

  describe(label, () => {
    afterEach(() => {
      for (const directory of copies.splice(0)) rmSync(directory, { recursive: true, force: true });
    });

    it('publishes exactly its pinned inventory, so a new export cannot widen the surface', () => {
      expect([...publishedNames(barrel)].toSorted(byName)).toEqual(expected);
    });

    it('reads the same inventory off an unedited copy of the chain', () => {
      expect([...publishedNames(copyChain((source) => source))].toSorted(byName)).toEqual(expected);
    });

    it('rejects a copy that publishes one name more', () => {
      const names = publishedNames(copyChain((source) => `${source}export const widened = 1;\n`));

      expect(names.has('widened')).toBe(true);
      expect([...names].toSorted(byName)).not.toEqual(expected);
    });

    it('rejects a copy that publishes one name fewer', () => {
      const names = publishedNames(copyChain((source) => source.replace(removal.statement, '')));

      expect(names.has(removal.name)).toBe(false);
      expect([...names].toSorted(byName)).not.toEqual(expected);
    });
  });
}

describe('the set of unenumerated stars', () => {
  it('is exactly the two sub-barrels pinned below, so a third door cannot open unnoticed', () => {
    expect(unenumeratedStarBarrels(MODULE_BARREL)).toEqual([
      'estimate/index.ts',
      'smart-model/index.ts',
    ]);
  });

  it('adds no money door beyond those two at the package root', () => {
    const underMoneyLayer = unenumeratedStarBarrels(ROOT_BARREL).filter((file) =>
      file.includes('affordability/')
    );

    expect(underMoneyLayer).toEqual(['affordability/smart-model/index.ts']);
  });
});

pinSubBarrelInventory({
  label: 'the money layer barrel',
  barrel: MODULE_BARREL,
  inventory: MODULE_BARREL_SURFACE,
  removal: {
    statement: "export { levenshtein } from './levenshtein.ts';\n",
    name: 'levenshtein',
  },
});

pinSubBarrelInventory({
  label: 'the estimator sub-barrel',
  barrel: ESTIMATE_BARREL,
  inventory: ESTIMATE_SUBBARREL_SURFACE,
  removal: {
    statement: "export { textTurnBudget } from './text-turn-budget.ts';\n",
    name: 'textTurnBudget',
  },
});

pinSubBarrelInventory({
  label: 'the Smart Model sub-barrel',
  barrel: SMART_MODEL_BARREL,
  inventory: SMART_MODEL_SUBBARREL_SURFACE,
  removal: {
    statement: "export * from './prompts.ts';\n",
    name: 'buildClassifierSystemPrompt',
  },
});

describe('affordability subpath', () => {
  it('is declared in the package exports map and points at an existing barrel', () => {
    const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      exports: Record<string, string>;
    };

    expect(manifest.exports['./affordability']).toBe('./src/affordability/index.ts');
    expect(() =>
      readFileSync(fileURLToPath(new URL('../../src/affordability/index.ts', import.meta.url)))
    ).not.toThrow();
  });

  it('publishes exactly the enumerated interim unit subpaths beside it', () => {
    const declared = Object.keys(exportsMap()).filter((subpath) =>
      subpath.startsWith('./affordability/')
    );

    expect(declared.toSorted((a, b) => a.localeCompare(b))).toEqual(
      [...INTERIM_UNIT_SUBPATHS].toSorted((a, b) => a.localeCompare(b))
    );
  });

  it.each(INTERIM_UNIT_SUBPATHS)('resolves %s to an existing unit', (subpath) => {
    const target = `./src${subpath.slice(1)}.ts`;

    expect(exportsMap()[subpath]).toBe(target);
    expect(() =>
      readFileSync(fileURLToPath(new URL(`../../${target}`, import.meta.url)))
    ).not.toThrow();
  });
});

function exportsMap(): Record<string, string> {
  const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    exports: Record<string, string>;
  };
  return manifest.exports;
}
