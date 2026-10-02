import { Node, SyntaxKind } from 'ts-morph';
import {
  assertNamedPathsExist,
  isRepoPath,
  isTestFile,
  relativePath,
  sourceFileAt,
} from '../lib/paths.js';
import { WEB_SOURCE_TREE } from '../lib/source-scope.js';
import type { ExportSpecifier, ImportSpecifier, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * `apps/web` prices through PRODUCERS, never through the machinery behind
 * them. `docs/BILLING.md` §What is enforced has claimed this since the module
 * was written; nothing enforced it, and 30 non-test web files reached past it.
 *
 * THREE TIERS, because one line over-collects and the narrow reading is
 * backwards:
 *
 * - PRODUCERS return a decision. Two surfaces asking the same producer get the
 *   same answer; two surfaces COMPOSING one are how a second verdict engine
 *   ships. So each producer has ONE publisher under `apps/web`, and the
 *   publisher is a file rather than a hook — `lib/api/api.ts`'s request-body type,
 *   the stores, the demo mock backend and a boundary validator structurally
 *   cannot have a React hook as a terminus.
 * - MACHINERY is everything the producers are built from: rates, ladders,
 *   thresholds, constants, solvers, reducers. `apps/web` may not import it at
 *   all. A consumer that needs one is evidence a producer is missing, which is
 *   the wall's own test (§The public surface).
 * - PRIMITIVES — money conversion and formatting, the `NanoUSD` schema, notice
 *   copy, labels — are legal anywhere, because re-implementing THOSE is what
 *   the duplication rules actually ban. Walling them would push each surface
 *   into its own copy of the thing that must not be copied.
 *
 * MACHINERY IS THE DEFAULT, not a list. A new export under the money module is
 * walled from web the moment it exists; reaching it takes a visible edit here.
 * The two allow-tiers below are enumerated, so drift fails closed.
 *
 * RESOLVED SYMBOLS, NEVER NAMES. Three star re-exports feed the barrel, so a
 * name allowlist reads nothing about where a symbol lives and drifts on any
 * rename; an import renamed on the way in (`getUserTier as tierOf`) defeats it
 * outright. Every judgement here is made on the file the symbol is DECLARED
 * in, reached through the compiler's own alias chain, which also follows
 * type-only imports and aliased `export … from` re-exports.
 *
 * RESOLUTION IS GATED, NOT ASSUMED. A judgement made on a resolved symbol is
 * only as live as the resolution, and a resolution that fails returns
 * `undefined` — which reads exactly like a clean repository. Two guards turn
 * that silence into noise: {@link assertResolvable} for a specifier that
 * resolves nowhere, {@link assertDoorsReachMoneyModule} for one that resolves
 * somewhere other than the money module.
 *
 * TYPE-ONLY SPECIFIERS ARE EXEMPT. A type computes no verdict, and banning
 * them would force each surface to re-declare the wire types — a
 * single-source-of-truth violation traded for nothing.
 *
 * TEST FILES ARE EXEMPT. A web test that drives a machinery function directly
 * is asserting on the module's own arithmetic, not shipping a second verdict.
 *
 * TWO CLOSURE CLAUSES, because the tier check reads NAMED specifiers and
 * laundering is exactly the syntax that has none — see
 * {@link wholeModuleHandles} and {@link sharedReExports}.
 */

/** Where the money module lives; a symbol declared under it is in scope. */
const MONEY_MODULE = 'packages/shared/src/affordability/';

/**
 * The tree this wall stands over. Which tree that is stays this rule's own
 * decision; WHERE the web tree is comes from the scope layer, so no rule can
 * narrow its own root by retyping it — see `lib/source-scope.ts`.
 */
const WEB_ROOT = WEB_SOURCE_TREE;

/** The package the closure clauses watch, barrel and subpaths alike. */
const SHARED_PACKAGE = /^@hushbox\/shared(\/|$)/;

/**
 * The two money specifiers `apps/web` opens today, and the whole scope
 * {@link assertDoorsReachMoneyModule} watches. The package publishes deeper
 * `@hushbox/shared/affordability/*` subpaths that land inside
 * {@link MONEY_MODULE} too; no web file imports one, so a deep money import
 * arriving here must be added to this set — and that premise is asserted by
 * {@link assertNoUnwatchedMoneyDoor} rather than left for a reader to notice.
 * Leaving one out costs only the WHERE check — an unresolvable specifier still
 * fails {@link assertResolvable}, a misresolved one goes unwatched.
 */
const MONEY_DOORS = new Set(['@hushbox/shared', '@hushbox/shared/affordability']);

/** A deeper money specifier than either door — the shape the set must grow for. */
const DEEP_MONEY_DOOR = /^@hushbox\/shared\/affordability\/./;

/**
 * The machinery symbol {@link assertDoorsReachMoneyModule} proves a door still
 * opens onto the money module with. A composed fee rate declared in the
 * module's constants: `packages/shared/src/affordability/index.test.ts` already
 * pins it on BOTH doors as the representative of its unit, so a rename that
 * would strand this check fails that test first and louder.
 */
const LIVENESS_ANCHOR = 'TOTAL_FEE_RATE';

const WHOLE_MODULE_HANDLE =
  'A whole-module handle on @hushbox/shared hides which money symbols apps/web ' +
  'reaches, so every tier judgement in this rule stops here. Import the named ' +
  'symbols instead.';

const RE_EXPORT =
  'Re-exporting @hushbox/shared from apps/web launders money symbols past this ' +
  "wall: a consumer importing the result through '@/…' resolves to this file " +
  'rather than to the money module. Import what you need directly.';

/**
 * Every money symbol that returns a DECISION, and the one `apps/web` file each
 * may be imported by.
 *
 * It opens with the producers of `docs/BILLING.md` §The public surface, less
 * `notices`, and continues past them: that section enumerates what FEATURE code
 * touches, while this tier answers a narrower question — which symbols return an
 * answer rather than the apparatus behind one. A projection of a served catalog
 * row, the doorless trial's own snapshot and the free tier's declared allowance
 * are all answers a surface must not compose for itself, and none of them is a
 * feature-facing producer. Membership here is therefore read off what the symbol
 * RETURNS, never off the doc's list, and each entry names the single file that
 * holds the verdict.
 *
 * `notices` is listed there as a producer and is tiered as a PRIMITIVE here:
 * it takes a typed reason and returns copy, so it produces no money verdict,
 * two callers cannot disagree, and the tier ruling puts notice copy in the
 * legal-anywhere tier by name. It is the one symbol the two descriptions
 * split on.
 *
 * A publisher is the file that HOLDS the verdict, so the set is read off the
 * repository rather than invented: every entry that existed when the wall went
 * up had exactly one non-test web importer, and the producers added since were
 * each extracted FROM their one caller. `undefined` means no web surface
 * publishes that verdict yet — the reach is refused rather than defaulted, so
 * the first one is a visible edit here.
 */
interface Producer {
  readonly module: string;
  readonly name: string;
  readonly publisher: string | undefined;
  /**
   * A fake backend serving this verdict. It stands on the SERVER side of a
   * boundary the demo collapses into one bundle, so it is not a second client
   * surface and does not make the publisher a second one either.
   */
  readonly serverStandIn?: string;
}

const PRODUCERS: readonly Producer[] = [
  {
    module: 'turn/turn-options.ts',
    name: 'getTurnOptions',
    publisher: 'apps/web/src/hooks/billing/use-turn-options.ts',
  },
  {
    module: 'turn/turn-options.ts',
    name: 'getMediaTurnOptions',
    publisher: 'apps/web/src/hooks/billing/use-media-turn-options.ts',
  },
  {
    module: 'estimate/text-turn-budget.ts',
    name: 'textTurnBudget',
    publisher: 'apps/web/src/hooks/billing/use-budget-calculation.ts',
  },
  {
    module: 'estimate/media-turn-cost.ts',
    name: 'mediaTurnCostNanoUsd',
    publisher: 'apps/web/src/hooks/billing/use-media-cost-estimate.ts',
  },
  {
    module: 'estimate/effort-options.ts',
    name: 'effortSelectionForTurn',
    publisher: 'apps/web/src/hooks/chat/use-reasoning-effort.ts',
  },
  { module: 'money/min-turn-cost.ts', name: 'minTurnCostNanoUsd', publisher: undefined },
  { module: 'billing/funding-decision.ts', name: 'resolveFunding', publisher: undefined },
  // The turn's reasoning budget, reduced across every model it draws on. Which
  // model's budget sizes a multi-model turn is the decision.
  {
    module: 'estimate/reasoning-budget-turn.ts',
    name: 'reasoningBudgetForTurn',
    publisher: 'apps/web/src/hooks/billing/use-prompt-budget.ts',
  },
  // A funding verdict turned into the notices a composer shows.
  {
    module: 'budget.ts',
    name: 'generateNotifications',
    publisher: 'apps/web/src/hooks/billing/use-prompt-budget.ts',
  },
  // Who pays, at what tier, with the client-only affordability vocabulary on top.
  {
    module: 'billing/client-billing.ts',
    name: 'resolveClientBilling',
    publisher: 'apps/web/src/hooks/billing/use-resolve-billing.ts',
  },
  // The payer's tier, and what that tier reaches. Both are verdicts a second
  // surface deriving for itself would eventually disagree with the first about.
  {
    module: 'money/tiers.ts',
    name: 'getUserTier',
    publisher: 'apps/web/src/hooks/billing/use-user-tier-info.ts',
    serverStandIn: 'apps/web/src/demo/mock-backend/store.ts',
  },
  {
    module: 'money/tiers.ts',
    name: 'tierCanAccessPremium',
    publisher: 'apps/web/src/hooks/models/use-payer-premium-access.ts',
  },
  // The two served-catalog-row projections. They decide which rows are priceable
  // at all — a row left out of the pool is a row nothing can charge for — and
  // each fails closed on a missing rate rather than pricing a turn free.
  {
    module: 'model/wire-pool-row.ts',
    name: 'poolModelFromWire',
    publisher: 'apps/web/src/hooks/billing/use-turn-options.ts',
  },
  {
    module: 'model/wire-media-row.ts',
    name: 'mediaModelFromWire',
    publisher: 'apps/web/src/hooks/billing/use-media-turn-options.ts',
  },
  // The funding snapshot of the one payer with no funding door.
  {
    module: 'trial-funding.ts',
    name: 'trialFundingSnapshot',
    publisher: 'apps/web/src/hooks/billing/use-turn-options.ts',
  },
  // The free tier's daily allowance as an amount. Its publisher is the demo mock
  // backend — a SERVER stand-in, which is why the verdict lands in a store
  // rather than a hook.
  {
    module: 'free-allowance.ts',
    name: 'freeDailyAllowanceNanoUsd',
    publisher: 'apps/web/src/demo/mock-backend/store.ts',
  },
  // The trial's daily message allowance. The publisher compares the served
  // remainder against it and hands its SURFACE the verdict — a surface holding
  // the allowance would be a second place the day's boundary is decided.
  {
    module: 'trial-allowance.ts',
    name: 'trialDailyMessageAllowance',
    publisher: 'apps/web/src/hooks/chat/use-trial-remaining.ts',
  },
  // The pair's prompt-independent half, for a surface that grades rows before a
  // prompt exists. It is the one read a basis-less caller may take: the pair
  // asked with the empty basis answers the send gate from a zero prompt, which
  // is strictly more permissive than the gate itself.
  {
    module: 'turn/turn-options.ts',
    name: 'getAffordableOptions',
    publisher: 'apps/web/src/hooks/billing/use-turn-options.ts',
  },
  // Which band a context window's fill is in. The composer's bar and the
  // pre-send near-capacity notice both read it, and while each compared the
  // thresholds for itself they disagreed in the fraction the bar rounds up.
  {
    module: 'capacity-band.ts',
    name: 'contextFillBand',
    publisher: 'apps/web/src/hooks/billing/use-prompt-budget.ts',
  },
  // Whether the prompt still fits the window at all — the verdict that blocks
  // the send, which the composer's gate and the notice that explains it both
  // read. While each compared for itself, a drift between them was a send
  // refused with nothing on screen saying why.
  {
    module: 'capacity-band.ts',
    name: 'isOverContextCapacity',
    publisher: 'apps/web/src/hooks/billing/use-prompt-budget.ts',
  },
  // One media option's verdict, read off the produced set. Its publisher is the
  // panel that renders the options: the verdict is a pure read of a set the
  // panel already holds, so there is no server state for a hook to own.
  {
    module: 'media-option-availability.ts',
    name: 'dimensionOptionAvailability',
    publisher: 'apps/web/src/components/chat/media/modality-config-panel.tsx',
  },
  // Which send refusals survive into a re-run of a model the turn already used.
  // Its publisher composes that verdict with the funding state the composer
  // holds. What this entry buys is ONE client-side home for the exemption, not
  // agreement with the server: the API grants its own by skipping the premium
  // check, and the producer's own comment records why the two can still drift.
  {
    module: 'notices.ts',
    name: 'refusesRegenerate',
    publisher: 'apps/web/src/lib/chat/message-actions.ts',
  },
  // What a surface shows of a served row's price, read off its anchor: the
  // rates, the expensive warning and the figures a price sort and the picks
  // compare.
  // Its publisher is a plain module rather than a hook: the verdict is a pure
  // synchronous read of a row the caller already holds, so there is no server
  // state for a hook to own.
  {
    module: 'price/display.ts',
    name: 'modelPriceDisplay',
    publisher: 'apps/web/src/lib/chat/model-info-facts.ts',
  },
];

/**
 * The distinct files the producer tier designates, which is the only part of
 * that tier shaped like a path. Derived rather than listed, and exported so the
 * colocated test seeds its web tree from it rather than from a copy.
 */
export const PUBLISHERS: readonly string[] = [
  ...new Set(
    PRODUCERS.flatMap((producer) => (producer.publisher === undefined ? [] : [producer.publisher]))
  ),
];

/**
 * The legal-anywhere tier, by declaring module. Enumerated rather than taken
 * whole-module, because a whole module fails OPEN: a rate added to a
 * conversion module would inherit the tier. Naming each export makes a new one
 * machinery until someone says otherwise.
 *
 * `estimate/format.ts` and `money.ts` are split deliberately.
 * `isExpensiveModelNano` reads a threshold off two rates a caller composed, and
 * `applyMarkup*` apply a fee — neither renders a number, so both stay machinery
 * beside their formatting neighbours. The warning web actually asks for ships
 * inside `modelPriceDisplay` in the producer tier, taking the wire row whole:
 * composing the pair is where the unvalidated coercion and the absent-rate
 * default lived, so the tier follows the argument rather than the threshold.
 * `model-id.ts` is here as a schema for the same reason `NanoUSD` is:
 * web parses ids at its boundaries, and the alternative to importing the brand
 * is re-declaring it.
 */
const PRIMITIVES: Readonly<Record<string, readonly string[]>> = {
  'money/nano-usd.ts': [
    'NANO_USD_PER_CENT',
    'NANO_USD_PER_DOLLAR',
    'NanoUSD',
    'PRICEABLE_AMOUNT',
    'centsToNanoUsd',
    'dollarsToCents',
    'dollarsToNanoUsd',
    'nanoUSD',
    'nanoUsdToCents',
    'nanoUsdToDollarString',
    'nanoUsdToFullDollarString',
    'parseNanoUSD',
    'serializeNanoUSD',
  ],
  'notices.ts': [
    'BudgetError',
    'MessageSegment',
    'NOTICE_COPY',
    'NOTICE_REASONS',
    'Notice',
    'NoticeCopy',
    'NoticeReason',
    'TRIAL_REMAINING_MESSAGE_ID',
    'isTransientBlock',
    'noticeText',
    'notices',
  ],
  'reasoning-effort.ts': [
    'CANONICAL_REASONING_EFFORTS',
    'CanonicalReasoningEffort',
    'REASONING_EFFORT_DESCRIPTIONS',
    'REASONING_EFFORT_LABELS',
    'REASONING_EFFORT_SELECTIONS',
    'REASONING_OFF',
    'RESOLVED_REASONING_EFFORTS',
    'ReasoningEffortSelection',
    'ReasoningOff',
    'ResolvedReasoningEffort',
  ],
  'model/model-id.ts': ['ModelId', 'modelId'],
  'estimate/format.ts': [
    'nanoPricePer1k',
    'nanoPriceRangePer1k',
    'nanoRateCompactPer1k',
    'nanoUnitPriceUsd',
  ],
  'money/money.ts': ['roundHalfEvenDiv', 'usdToNanoUsd'],
  'money/fixed-place-dollars.ts': [
    'nanoUsdToFourPlaceDollarString',
    'nanoUsdToTwoPlaceDollarString',
  ],
};

/** The module a symbol is declared in, relative to the money module, or undefined. */
function moneyModuleOf(specifier: ImportSpecifier | ExportSpecifier): string | undefined {
  const symbol = specifier.getNameNode().getSymbol();
  const declaration = (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations()[0];
  if (declaration === undefined) return undefined;
  const declaredIn = relativePath(declaration.getSourceFile());
  const at = declaredIn.indexOf(MONEY_MODULE);
  return at === -1 ? undefined : declaredIn.slice(at + MONEY_MODULE.length);
}

function producerFor(module: string, name: string): Producer | undefined {
  return PRODUCERS.find((producer) => producer.module === module && producer.name === name);
}

function isPrimitive(module: string, name: string): boolean {
  return PRIMITIVES[module]?.includes(name) === true;
}

/**
 * Why this reach is refused, or undefined when it is allowed. A producer is
 * allowed in exactly one file; everything left over is machinery.
 */
function tierMessage(filePath: string, module: string, name: string): string | undefined {
  const producer = producerFor(module, name);
  if (producer === undefined) {
    return (
      `'${name}' is money-layer machinery — rates, ladders, thresholds, constants, ` +
      'solvers and reducers are not importable by apps/web at all. Needing one is ' +
      'evidence the money module is missing a producer that answers the question ' +
      '(docs/BILLING.md §The public surface).'
    );
  }
  if (producer.publisher === undefined) {
    return (
      `'${name}' is a money producer and no apps/web publisher is designated for it. ` +
      'Designate the one file that holds this verdict in ' +
      'web-prices-through-producers.rule.ts rather than reaching for it here.'
    );
  }
  if (isRepoPath(filePath, producer.publisher)) return undefined;
  if (producer.serverStandIn !== undefined && isRepoPath(filePath, producer.serverStandIn)) {
    return undefined;
  }
  return (
    `'${name}' is a money producer: under apps/web only ${producer.publisher} may ` +
    'import it — one publisher per produced verdict, because two surfaces composing ' +
    'one verdict is how a second pricing engine ships. Read the answer from that ' +
    'publisher instead.'
  );
}

/**
 * Every declared producer still exists where it is declared to.
 *
 * The check is asymmetric on purpose, and only the producers need it. A
 * producer renamed or moved would fall out of the tier tables into MACHINERY
 * and its publisher would start failing loudly — but the rename could equally
 * land it on a name nobody claims, leaving the wall standing over nothing. A
 * primitive that drifts fails closed all by itself: it becomes machinery and
 * the first reach reports.
 *
 * A module the project does not hold is not checked, so a fixture may model
 * one corner of the money module without restating the rest of it.
 */
function assertProducersExist(project: Project): void {
  for (const producer of PRODUCERS) {
    const module = sourceFileAt(project, MONEY_MODULE + producer.module);
    if (module === undefined) continue;
    if (!module.getExportedDeclarations().has(producer.name)) {
      throw new Error(
        `web-prices-through-producers: '${producer.name}' is no longer exported by ` +
          `${MONEY_MODULE}${producer.module}. Point the producer tier at its new home; ` +
          'until then the wall stands over a name nothing declares.'
      );
    }
  }
}

/**
 * The publisher paths and the watched root still name the tree they were
 * written against.
 *
 * These two say WHERE, and a where that stops naming anything fails in the one
 * direction this rule cannot see: the publisher check goes quiet because no
 * file claims the path, and the scan goes quiet because it collected no files.
 * Both read exactly like a repository with nothing to report.
 *
 * The root is asserted NON-EMPTY rather than merely present, because the
 * failure that matters is a scope that resolves and collects nothing — a tree
 * that moved, a web app renamed, or a file-name convention widening until every
 * file under the root reads as a test. A directory check passes all three.
 */
function assertScopeIsPopulated(project: Project, scanned: readonly SourceFile[]): void {
  if (scanned.length === 0) {
    throw new Error(
      `web-prices-through-producers: no scanned file lives under '${WEB_ROOT}', so this ` +
        'wall stands over an empty scope and reports a clean repository having read ' +
        'nothing. Point the watched root at the web tree, or widen what counts as ' +
        'source under it.'
    );
  }
  assertNamedPathsExist(
    'web-prices-through-producers',
    project,
    PUBLISHERS,
    'A designated publisher that names no file cannot be reached by anyone, so the ' +
      'producer it holds is walled from the whole app rather than from all but one ' +
      'file. Point the producer tier at the file that publishes the verdict now.'
  );
}

/**
 * No scanned file opens a money door outside {@link MONEY_DOORS}.
 *
 * {@link assertDoorsReachMoneyModule} watches the doors that set names, so a
 * web file reaching the module through a deeper subpath is tiered but never
 * checked for WHERE it landed — the premise that keeps the two-door scope
 * honest is that no web file does. That premise is about what `apps/web`
 * happens to import, which is exactly the kind of fact that stops being true
 * without anyone deciding to change it.
 *
 * Only import declarations are read, because that is what the doors set is
 * matched against; a deep re-export is reported by {@link sharedReExports}
 * whatever its specifier.
 */
function assertNoUnwatchedMoneyDoor(scanned: readonly SourceFile[]): void {
  for (const sourceFile of scanned) {
    for (const declaration of sourceFile.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (!DEEP_MONEY_DOOR.test(specifier)) continue;
      throw new Error(
        `web-prices-through-producers: ${relativePath(sourceFile)} imports '${specifier}', ` +
          'which reaches the money module through a door MONEY_DOORS does not watch. Add ' +
          'it to MONEY_DOORS so the liveness guard covers it; until then a specifier that ' +
          'resolves somewhere other than the money module leaves this rule blind on that ' +
          'file rather than satisfied.'
      );
    }
  }
}

/**
 * Every `@hushbox/shared` import in a scanned web file resolves.
 *
 * Symbol resolution is what every tier judgement rests on, and a resolution
 * that fails returns undefined rather than raising — so a harness that stopped
 * resolving the package would leave this rule reporting a clean repository
 * forever. Turning that silence into noise is the whole point.
 */
function assertResolvable(sourceFile: SourceFile): void {
  for (const declaration of sourceFile.getImportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (!SHARED_PACKAGE.test(specifier)) continue;
    if (declaration.getModuleSpecifierSourceFile() !== undefined) continue;
    throw new Error(
      `web-prices-through-producers: cannot resolve '${specifier}' from ` +
        `${relativePath(sourceFile)}, so no money symbol in this file can be tiered. ` +
        'The rule is blind rather than satisfied.'
    );
  }
}

/** Every money door the scanned files open, against the specifier that opened it. */
function openedDoors(scanned: readonly SourceFile[]): Map<SourceFile, string> {
  const doors = new Map<SourceFile, string>();
  for (const sourceFile of scanned) {
    for (const declaration of sourceFile.getImportDeclarations()) {
      const specifier = declaration.getModuleSpecifierValue();
      if (!MONEY_DOORS.has(specifier)) continue;
      const resolved = declaration.getModuleSpecifierSourceFile();
      if (resolved !== undefined) doors.set(resolved, specifier);
    }
  }
  return doors;
}

/**
 * Every door a scanned file opens leads INTO the money module.
 *
 * {@link assertResolvable} proves a specifier resolved; it cannot prove WHERE.
 * A door that resolved to a built declaration file — or to anything else
 * outside {@link MONEY_MODULE} — still resolves, and every tier judgement below
 * then reads `undefined` and reports nothing: a wall standing over a repository
 * it can no longer see, green forever. The anchor is a
 * machinery symbol, so a door that publishes it from its declared home is a
 * door this rule can still refuse a reach through.
 */
function assertDoorsReachMoneyModule(scanned: readonly SourceFile[]): void {
  for (const [door, specifier] of openedDoors(scanned)) {
    const anchored = door.getExportedDeclarations().get(LIVENESS_ANCHOR) ?? [];
    const declaredInModule = anchored.some((declaration) =>
      relativePath(declaration.getSourceFile()).includes(MONEY_MODULE)
    );
    if (declaredInModule) continue;
    throw new Error(
      `web-prices-through-producers: '${specifier}' resolves to ${relativePath(door)}, ` +
        `which publishes no '${LIVENESS_ANCHOR}' declared under ${MONEY_MODULE}. Either ` +
        'the door no longer opens onto the money module, in which case every tier ' +
        'judgement here reads undefined and the rule is blind rather than satisfied; or ' +
        'the anchor moved, in which case point this check at another machinery symbol ' +
        'the door publishes.'
    );
  }
}

/**
 * Lines where a web file takes a handle on the whole shared package instead of
 * naming what it wants: a namespace import, a default import, or a dynamic
 * `import(…)`, which are one capability under three spellings. The tier check
 * reads NAMED specifiers, and none of these has any, so without this clause a
 * money symbol reached off a module object is invisible to every other clause.
 */
function wholeModuleHandles(sourceFile: SourceFile): number[] {
  const lines: number[] = [];
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (!SHARED_PACKAGE.test(declaration.getModuleSpecifierValue())) continue;
    const handle = declaration.getNamespaceImport() ?? declaration.getDefaultImport();
    if (handle !== undefined) lines.push(declaration.getStartLineNumber());
  }
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const [argument] = call.getArguments();
    if (argument === undefined || !Node.isStringLiteral(argument)) continue;
    if (SHARED_PACKAGE.test(argument.getLiteralValue())) lines.push(call.getStartLineNumber());
  }
  return lines;
}

/**
 * Lines where a web file re-exports the shared package. The re-export itself is
 * the offence, whatever tier the named symbols are: a consumer importing the
 * result through the `@/…` alias resolves to the web file, not to the money
 * module, so every judgement in this rule stops at that hop. `export * from`
 * additionally names no symbol at all.
 *
 * Type-only re-exports pass for the same reason type-only imports do.
 */
function sharedReExports(sourceFile: SourceFile): number[] {
  const lines: number[] = [];
  for (const declaration of sourceFile.getExportDeclarations()) {
    if (declaration.isTypeOnly()) continue;
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === undefined || !SHARED_PACKAGE.test(specifier)) continue;
    const named = declaration.getNamedExports();
    if (named.length > 0 && named.every((name) => name.isTypeOnly())) continue;
    lines.push(declaration.getStartLineNumber());
  }
  return lines;
}

/** Every named binding a file imports or re-exports, minus the type-only ones. */
function valueBindings(sourceFile: SourceFile): (ImportSpecifier | ExportSpecifier)[] {
  const bindings: (ImportSpecifier | ExportSpecifier)[] = [];
  for (const declaration of [
    ...sourceFile.getImportDeclarations(),
    ...sourceFile.getExportDeclarations(),
  ]) {
    if (declaration.isTypeOnly()) continue;
    const specifiers =
      'getNamedImports' in declaration
        ? declaration.getNamedImports()
        : declaration.getNamedExports();
    for (const specifier of specifiers) {
      if (!specifier.isTypeOnly()) bindings.push(specifier);
    }
  }
  return bindings;
}

/** Every reach one scanned web file earns, across all three clauses. */
function violationsIn(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  assertResolvable(sourceFile);
  const file = sourceFile.getFilePath();
  const violations: ArchViolation[] = wholeModuleHandles(sourceFile).map((line) => ({
    file,
    line,
    message: WHOLE_MODULE_HANDLE,
  }));
  violations.push(
    ...sharedReExports(sourceFile).map((line) => ({ file, line, message: RE_EXPORT }))
  );
  for (const binding of valueBindings(sourceFile)) {
    const module = moneyModuleOf(binding);
    if (module === undefined) continue;
    const name = binding.getName();
    if (isPrimitive(module, name)) continue;
    const message = tierMessage(filePath, module, name);
    if (message !== undefined) {
      violations.push({ file, line: binding.getStartLineNumber(), message });
    }
  }
  return violations;
}

const rule: ArchRule = {
  name: 'web-prices-through-producers',
  check(project) {
    const scanned = project.getSourceFiles().filter((sourceFile) => {
      const filePath = relativePath(sourceFile);
      return filePath.includes(WEB_ROOT) && !isTestFile(filePath);
    });
    assertScopeIsPopulated(project, scanned);
    assertProducersExist(project);
    assertNoUnwatchedMoneyDoor(scanned);
    assertDoorsReachMoneyModule(scanned);
    const violations: ArchViolation[] = [];
    for (const sourceFile of scanned) {
      violations.push(...violationsIn(sourceFile, relativePath(sourceFile)));
    }
    return violations;
  },
};

export default rule;
