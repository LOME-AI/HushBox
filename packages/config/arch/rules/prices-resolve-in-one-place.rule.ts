import path from 'node:path';
import { ts } from 'ts-morph';
import {
  assertNamedPathsExist,
  failWith,
  isRepoPath,
  isTestFile,
  relativePath,
  sourceFileAt,
} from '../lib/paths.js';
import {
  REPO_ROOT,
  WEB_SOURCE_TREE,
  discoverSourceTrees,
  workspaceSourceTree,
} from '../lib/source-scope.js';
import { webProgram } from '../lib/web-program.js';
import type { SourceFile, Project } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Pricing has ONE home. The price core holds the typed schedule, the only tier
 * resolver and the two characters-per-token ratios; every display, hold, fit and
 * estimated charge prices through it. A consumer that reads a rate, builds a rate
 * object, resolves a tier or converts characters by its own ratio is a second
 * pricing engine, and the hold stops covering the bill the moment the two drift.
 *
 * It refuses, each clause in its own scope:
 *
 * - READS, outside the home ({@link PRICE_HOME}): a property read, element read
 *   or destructured field whose declaration is a member of `TokenRates`,
 *   `PriceTier`, `TokenPriceSchedule` or a `ModelPricing` variant. A price's
 *   `kind` is exempt: it names which variant a value is, carries no rate, and is
 *   how a consumer narrows a price to hand it back to the core.
 * - CONSTRUCTION, outside the home: an object literal contextually typed as one
 *   of those rate types, or spreading one.
 * - MINTING: a `ModelPricing` built by spread or literal, a zod schema branded
 *   `'ModelPricing'`, `Object.assign` producing one, `z.custom` of one, or a
 *   user-defined type guard narrowing to one, anywhere but the schedule module
 *   and the pricing fixture module ({@link MINT_PLACES}). Parsing is the only
 *   other way to obtain one; the brand already refuses a literal written field
 *   by field, and this closes what the brand cannot see. In a test file, a literal
 *   on the line a `@ts-expect-error` directive governs is that refusal's proof,
 *   not a mint ({@link isCompileErrorProof}). Anywhere else it is a mint: the
 *   directive suppresses the error and the object is still emitted.
 * - ONE RESOLVER: any identifier spelled `resolveTier` outside the price core,
 *   whether it references the core's resolver or declares another.
 * - RATIOS: a reference to one of the two ratio constants outside the
 *   quantities module, and any other declaration whose name spells a
 *   characters-per-token ratio.
 * - RETIRED NAMES: any occurrence under {@link RETIRED_NAME_TREES}, comments,
 *   strings and tests included, of a name the price core replaced
 *   ({@link RETIRED_NAMES}).
 * - SERVED WIRE: in the web and marketing trees, a read of a key of the served
 *   pricing schemas, or of a served row's pool bounds.
 *
 * REACH. Every clause but the retired names and the served wire reads every file
 * the arch scan reads, whatever its tree. The retired names are swept in the four
 * trees the price core's retirement named, and the rule throws when the scan holds
 * no file under one of them. The served wire is read where a served price is
 * shown.
 *
 * WHICH CLAUSES REACH TESTS. Minting, the resolver and the retired names reach
 * test files; reads, construction, ratio references and declarations, and the
 * served wire do not. A test that reads a rate, or spells a ratio, to compute
 * its own expected figure is an independent oracle, not a second
 * implementation; a test that mints a price unparsed, or calls the resolver
 * directly from outside the core, skips the one path the code under test takes.
 *
 * RESOLVED DECLARATIONS, NEVER RECEIVER NAMES. A read is judged on the
 * declaration the checker resolves the field to, so a structurally identical
 * local type is not a price type and a field reached through any number of
 * aliases still is. The web package's `@/` alias resolves to nothing in the
 * layer's shared project, so its files are read through a program built with
 * that package's own compiler options (`lib/web-program.ts`). The walk is the
 * compiler's own, unwrapped: the layer's shared project already holds most of
 * its heap ceiling, and wrapping every node in every scanned file does not fit.
 *
 * Known limits: a rate laundered through `any`, a computed key or a cast escapes;
 * byte-based context guards are out of scope, since a byte bound is not a price.
 * The arch scan reads `.ts` and `.tsx` files only: it reads no `.astro` file and
 * no `.mjs` file, so a served price read in one is never seen. Packages other
 * than the web package that resolve an `@/` alias are read without it, so a type
 * reached through that alias reads as unknown. A parsed price mutated through a
 * mutable alias is not seen.
 */

const RULE = 'prices-resolve-in-one-place';

const fail: (message: string) => never = failWith(RULE);

const PRICE_CORE = 'packages/shared/src/affordability/price/';

export const SCHEDULE_MODULE = `${PRICE_CORE}schedule.ts`;

export const QUANTITIES_MODULE = `${PRICE_CORE}quantities.ts`;

export const PRICING_FIXTURE = 'packages/shared/src/testing/pricing-fixture.ts';

/** The module declaring the served catalog row and its pricing schemas. */
export const WIRE_MODULE = 'packages/shared/src/schemas/api/models.ts';

/**
 * Where a rate may be read or a rate object built: where rates are priced or
 * baked. That is the core, catalog ingestion (the module that selects an
 * anchor's listed rates and the module that bakes them billable at the fee
 * seam), and billing's money module, which converts provider cost at the other.
 */
export const PRICE_HOME: readonly string[] = [
  PRICE_CORE,
  'apps/api/src/slices/models/domain/catalog/price-schedule.ts',
  'apps/api/src/slices/models/domain/catalog/normalize.ts',
  'apps/api/src/slices/billing/domain/money.ts',
];

const MINT_PLACES: readonly string[] = [SCHEDULE_MODULE, PRICING_FIXTURE];

/** The trees the retired names are swept in, as the price core's retirement named them. */
const RETIRED_NAME_TREES: readonly string[] = ['apps', 'packages', 'scripts', 'e2e'];

/** The trees whose code shows served prices, and so may read them only through a producer. */
const SERVED_WIRE_TREES: readonly string[] = [
  WEB_SOURCE_TREE,
  workspaceSourceTree(discoverSourceTrees(REPO_ROOT), 'apps/marketing'),
];

/** The rate types, each reported under its own name. */
const RATE_TYPES: ReadonlySet<string> = new Set(['TokenRates', 'PriceTier', 'TokenPriceSchedule']);

/**
 * The union of a `ModelPricing`'s variants. Every field of every narrowing of a
 * `ModelPricing` is declared inside it; the brand is zod's, not the schedule
 * module's.
 */
const PRICING_SHAPES = 'PricingShapes';

/** The name a variant field, a minted value or a guard is reported under. */
const MODEL_PRICING = 'ModelPricing';

/** What the schedule module must still declare for every clause to stand over something. */
const SCHEDULE_DECLARATIONS: readonly string[] = [
  'TokenRates',
  'PriceTier',
  'TokenPriceSchedule',
  MODEL_PRICING,
  PRICING_SHAPES,
  'resolveTier',
];

/** The field naming a price's variant; reading it reads no rate. */
const DISCRIMINANT = 'kind';

const RESOLVER = 'resolveTier';

const RATIOS: readonly string[] = ['INPUT_CHARS_PER_TOKEN', 'STORED_CHARS_PER_OUTPUT_TOKEN'];

const RATIO_NAME = /chars?_?per_?(output_?)?token/i;

/** The names the price core replaced; each is a second ratio or resolver under its old name. */
export const RETIRED_NAMES: readonly string[] = [
  'charsPerTokenForTier',
  'estimateTokensForTier',
  'outputCharsPerTokenForTier',
  'estimateTokenCount',
  'CHARS_PER_TOKEN_CONSERVATIVE',
  'CHARS_PER_TOKEN_STANDARD',
  'CLASSIFIER_CHARS_PER_TOKEN',
  'ratesFromPricing',
  'callCostBasisForTier',
];

/** The served pricing schemas, by their declared names in {@link WIRE_MODULE}. */
const WIRE_SCHEMAS: readonly string[] = ['wireModelPricingSchema', 'wireLongContextRateSchema'];

/** A served Smart Model row's pool bounds, each a served pricing in its own right. */
const POOL_BOUNDS: readonly string[] = ['minPricing', 'maxPricing'];

const SHARED_PACKAGE = /^@hushbox\/shared(\/|$)/;

/** Declarations that bind a name a ratio could be spelled with. */
const NAMED_DECLARATIONS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.EnumMember,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.ShorthandPropertyAssignment,
  ts.SyntaxKind.PropertyDeclaration,
  ts.SyntaxKind.PropertySignature,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.MethodSignature,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.BindingElement,
]);

/** The text every minting call carries, so a file without any is not searched for calls. */
const MINTING_CALLS: readonly string[] = ['brand', 'Object.assign', 'custom'];

/** Whether a compiler file name is the repo-relative path named. */
function isFileName(fileName: string, repoPath: string): boolean {
  return isRepoPath(fileName.replace(/^\//, ''), repoPath);
}

function isFile(sourceFile: SourceFile, repoPath: string): boolean {
  return isRepoPath(relativePath(sourceFile), repoPath);
}

/** Whether a file sits under a repo-relative tree, written with or without its trailing slash. */
function isInTree(sourceFile: SourceFile, tree: string): boolean {
  const root = path.join(REPO_ROOT, tree.replace(/\/$/, ''));
  return sourceFile.getFilePath() === root || sourceFile.getFilePath().startsWith(`${root}/`);
}

function isInHome(sourceFile: SourceFile): boolean {
  return PRICE_HOME.some((home) =>
    home.endsWith('/') ? isInTree(sourceFile, home) : isFile(sourceFile, home)
  );
}

function isMintPlace(sourceFile: SourceFile): boolean {
  return MINT_PLACES.some((place) => isFile(sourceFile, place));
}

/** A property name as written: an identifier, or a string or template key. */
function keyText(name: ts.Node | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

/**
 * The price type a declaration belongs to, read off the nearest named type that
 * encloses it in the schedule module: a rate type by its own name, any piece of
 * a `ModelPricing` as `ModelPricing`.
 */
function priceTypeOf(declaration: ts.Node): string | undefined {
  if (!isFileName(declaration.getSourceFile().fileName, SCHEDULE_MODULE)) return undefined;
  const named = ts.findAncestor(
    declaration,
    (node): node is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
  );
  if (named === undefined) return undefined;
  const name = named.name.text;
  if (RATE_TYPES.has(name)) return name;
  return name === PRICING_SHAPES ? MODEL_PRICING : undefined;
}

/** A symbol's declarations; an unresolved symbol, or one the compiler synthesized, has none. */
function declarationsOf(symbol: ts.Symbol | undefined): readonly ts.Declaration[] {
  return symbol?.declarations ?? [];
}

function symbolOwner(symbol: ts.Symbol | undefined): string | undefined {
  for (const declaration of declarationsOf(symbol)) {
    const owner = priceTypeOf(declaration);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

/** The price type a type names, itself or through any union or intersection member. */
function typeOwner(type: ts.Type): string | undefined {
  const named = symbolOwner(type.aliasSymbol) ?? symbolOwner(type.getSymbol());
  if (named !== undefined) return named;
  const parts = type.isUnionOrIntersection() ? type.types : [];
  for (const part of parts) {
    const owner = typeOwner(part);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

/** Whether a declaration is a key of a served pricing schema, or a served row's pool bound. */
function isWireDeclaration(declaration: ts.Node, name: string): boolean {
  if (!isFileName(declaration.getSourceFile().fileName, WIRE_MODULE)) return false;
  if (POOL_BOUNDS.includes(name)) return true;
  const schema = ts.findAncestor(
    declaration,
    (node) => ts.isVariableDeclaration(node) && WIRE_SCHEMAS.includes(node.name.getText())
  );
  return schema !== undefined;
}

/** The facts each clause matches against, read off the declarations rather than listed. */
interface PriceFacts {
  /** Every field a price type declares; only a read of one of these can be a rate read. */
  readonly memberNames: ReadonlySet<string>;
  /** Every key a served pricing schema declares, plus the pool bounds. */
  readonly wireNames: ReadonlySet<string>;
}

function propertyNamesUnder(node: ts.Node, into: Set<string>): void {
  if (
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node)
  ) {
    const name = keyText(node.name);
    if (name !== undefined) into.add(name);
  }
  ts.forEachChild(node, (child) => {
    propertyNamesUnder(child, into);
  });
}

function readPriceFacts(schedule: SourceFile, wire: SourceFile): PriceFacts {
  const memberNames = new Set<string>();
  for (const statement of schedule.compilerNode.statements) {
    if (priceTypeOf(statement) !== undefined) propertyNamesUnder(statement, memberNames);
  }
  const wireNames = new Set<string>(POOL_BOUNDS);
  for (const schema of WIRE_SCHEMAS) {
    propertyNamesUnder(wire.getVariableDeclarationOrThrow(schema).compilerNode, wireNames);
  }
  return { memberNames, wireNames };
}

/** One scanned file, read through the compiler that owns it. */
interface FileContext {
  readonly sourceFile: SourceFile;
  readonly node: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly facts: PriceFacts;
  readonly violations: ArchViolation[];
}

function report(context: FileContext, node: ts.Node, message: string): void {
  const { line } = context.node.getLineAndCharacterOfPosition(node.getStart(context.node));
  context.violations.push({ file: relativePath(context.sourceFile), line: line + 1, message });
}

/** One field read, whatever its syntax: the node to report, its name, and the fields it may read. */
interface FieldRead {
  readonly node: ts.Node;
  readonly name: string;
  readonly fields: () => readonly ts.Symbol[];
}

function present(symbol: ts.Symbol | undefined): ts.Symbol[] {
  return symbol === undefined ? [] : [symbol];
}

/** The fields `name` may read off a destructured value, one per union member when it is a union. */
function fieldsOf(checker: ts.TypeChecker, type: ts.Type, name: string): ts.Symbol[] {
  const members = type.isUnion() ? [type, ...type.types] : [type];
  return members.flatMap((member) => present(checker.getPropertyOfType(member, name)));
}

/**
 * The field reads a node makes, across the three syntaxes. Only a read whose
 * name some clause watches is returned, and nothing is resolved until a clause
 * asks, because resolving every read in the repository does not fit.
 */
function fieldReadsAt(context: FileContext, node: ts.Node): FieldRead[] {
  const { checker, facts } = context;
  const watched = (name: string | undefined): name is string =>
    name !== undefined && (facts.memberNames.has(name) || facts.wireNames.has(name));
  if (ts.isPropertyAccessExpression(node)) {
    const name = keyText(node.name);
    return watched(name)
      ? [{ node, name, fields: () => present(checker.getSymbolAtLocation(node.name)) }]
      : [];
  }
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    const name = keyText(key);
    return watched(name)
      ? [{ node, name, fields: () => present(checker.getSymbolAtLocation(key)) }]
      : [];
  }
  if (!ts.isObjectBindingPattern(node)) return [];
  return node.elements.flatMap((element) => {
    if (element.dotDotDotToken !== undefined) return [];
    const name = keyText(element.propertyName ?? element.name);
    if (!watched(name)) return [];
    return [
      {
        node: element,
        name,
        fields: () => fieldsOf(checker, checker.getTypeAtLocation(node), name),
      },
    ];
  });
}

function readOwner(read: FieldRead): string | undefined {
  for (const field of read.fields()) {
    const owner = symbolOwner(field);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

function checkRateRead(context: FileContext, read: FieldRead): void {
  if (read.name === DISCRIMINANT || !context.facts.memberNames.has(read.name)) return;
  const owner = readOwner(read);
  if (owner === undefined) return;
  report(
    context,
    read.node,
    `reads '${read.name}' off ${owner}, a price type, outside the price home ` +
      `(${PRICE_HOME.join(', ')}). Ask the price core for the figure, by use, rather ` +
      'than reading its rates.'
  );
}

function checkServedWireRead(context: FileContext, read: FieldRead): void {
  if (!context.facts.wireNames.has(read.name)) return;
  const served = read
    .fields()
    .some((field) =>
      declarationsOf(field).some((declaration) => isWireDeclaration(declaration, read.name))
    );
  if (!served) return;
  report(
    context,
    read.node,
    `reads '${read.name}' off the served pricing row (${WIRE_MODULE}). A served price ` +
      'is parsed by pricingFromWire and shown by a producer; read the answer, not the rate.'
  );
}

function hasKey(literal: ts.ObjectLiteralExpression, names: ReadonlySet<string>): boolean {
  return literal.properties.some((property) => {
    const name = keyText(property.name);
    return name !== undefined && names.has(name);
  });
}

/** The price type a spread copies into a literal, read off the spread value's own type. */
function spreadOwner(
  checker: ts.TypeChecker,
  literal: ts.ObjectLiteralExpression
): string | undefined {
  for (const property of literal.properties) {
    if (!ts.isSpreadAssignment(property)) continue;
    const owner = typeOwner(checker.getTypeAtLocation(property.expression));
    if (owner !== undefined) return owner;
  }
  return undefined;
}

/**
 * The price type a literal is built as: its contextual type, or the price a
 * spread copies in. The contextual type is asked only of a literal that could
 * type as a price without a spread, because asking it of every literal in the
 * repository does not fit: a rate object names a rate field, and a
 * `ModelPricing` names its `kind`.
 */
function literalOwner(
  checker: ts.TypeChecker,
  literal: ts.ObjectLiteralExpression,
  candidates: ReadonlySet<string>
): string | undefined {
  if (hasKey(literal, candidates)) {
    const contextual = checker.getContextualType(literal);
    const owner = contextual === undefined ? undefined : typeOwner(contextual);
    if (owner !== undefined) return owner;
  }
  return spreadOwner(checker, literal);
}

function mintMessage(how: string): string {
  return (
    `${how} outside ${MINT_PLACES.join(' and ')}. A ModelPricing is minted only by ` +
    'parsing it through ModelPricingSchema; a test builds one through the pricing fixture.'
  );
}

interface Clauses {
  readonly ownRules: boolean;
  readonly mint: boolean;
  readonly mintCalls: boolean;
  readonly servedWire: boolean;
  readonly resolver: boolean;
  readonly ratioReferences: boolean;
  readonly ratioDeclarations: boolean;
  readonly inQuantities: boolean;
  /** A test file, where a `@ts-expect-error` literal proves the brand rather than minting. */
  readonly proofsExempt: boolean;
}

/** The key a literal must carry to type as a `ModelPricing` without a spread. */
const MINT_KEYS: ReadonlySet<string> = new Set([DISCRIMINANT]);

/** A line that starts with a `@ts-expect-error` directive comment. */
const EXPECT_ERROR_DIRECTIVE = /^(?:\/\/|\/\*+)\s*@ts-expect-error\b/;

/**
 * Whether a literal starts on the line a `@ts-expect-error` directive governs:
 * the line after the directive's own. Such a literal is a proof that the brand
 * refuses a hand-built price. It is exempt only in a test file: the directive
 * suppresses the error, the object is still emitted, and only a test's proof is
 * never run as production. The exemption is that directive alone; `@ts-ignore`
 * suppresses without proving, and a cast compiles.
 */
function isCompileErrorProof(context: FileContext, literal: ts.Node): boolean {
  const { line } = context.node.getLineAndCharacterOfPosition(literal.getStart(context.node));
  const above = context.node.text.slice(
    context.node.getPositionOfLineAndCharacter(Math.max(line - 1, 0), 0),
    context.node.getPositionOfLineAndCharacter(line, 0)
  );
  return EXPECT_ERROR_DIRECTIVE.test(above.trim());
}

function checkLiteral(
  context: FileContext,
  clauses: Clauses,
  literal: ts.ObjectLiteralExpression
): void {
  if (!(clauses.mint || clauses.ownRules)) return;
  const candidates = clauses.ownRules ? context.facts.memberNames : MINT_KEYS;
  const owner = literalOwner(context.checker, literal, candidates);
  if (owner === MODEL_PRICING) {
    if (clauses.mint && !(clauses.proofsExempt && isCompileErrorProof(context, literal))) {
      report(context, literal, mintMessage('builds a ModelPricing by spread or literal'));
    }
    return;
  }
  if (owner === undefined || !clauses.ownRules) return;
  report(
    context,
    literal,
    `builds a ${owner} by hand outside the price home (${PRICE_HOME.join(', ')}). ` +
      'Rate objects come from the price core; a test binds its prices through the ' +
      'pricing fixture.'
  );
}

function namesModelPricing(checker: ts.TypeChecker, typeNode: ts.TypeNode | undefined): boolean {
  return (
    typeNode !== undefined && typeOwner(checker.getTypeFromTypeNode(typeNode)) === MODEL_PRICING
  );
}

function isBrandedModelPricing(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'brand') return false;
  return (call.typeArguments ?? []).some(
    (argument) =>
      ts.isLiteralTypeNode(argument) &&
      ts.isStringLiteral(argument.literal) &&
      argument.literal.text === MODEL_PRICING
  );
}

function checkMintCall(context: FileContext, call: ts.CallExpression): void {
  const { checker } = context;
  const callee = call.expression;
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : keyText(callee);
  const receiver = ts.isPropertyAccessExpression(callee) ? keyText(callee.expression) : undefined;
  if (isBrandedModelPricing(call)) {
    report(context, call, mintMessage("declares a schema with brand<'ModelPricing'>"));
  } else if (
    receiver === 'Object' &&
    name === 'assign' &&
    typeOwner(checker.getTypeAtLocation(call)) === MODEL_PRICING
  ) {
    report(context, call, mintMessage('produces a ModelPricing with Object.assign'));
  } else if (
    name === 'custom' &&
    (call.typeArguments ?? []).some((argument) => namesModelPricing(checker, argument))
  ) {
    report(context, call, mintMessage('declares z.custom of a ModelPricing'));
  }
}

/** Whether an identifier resolves, through any import, to one of the two ratio constants. */
function referencedRatio(checker: ts.TypeChecker, identifier: ts.Identifier): string | undefined {
  if (!RATIOS.includes(identifier.text)) return undefined;
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined) return undefined;
  const target =
    (symbol.flags & ts.SymbolFlags.Alias) === 0 ? symbol : checker.getAliasedSymbol(symbol);
  const declared = declarationsOf(target).some(
    (declaration) =>
      ts.isVariableDeclaration(declaration) &&
      isFileName(declaration.getSourceFile().fileName, QUANTITIES_MODULE)
  );
  return declared ? identifier.text : undefined;
}

function checkIdentifier(context: FileContext, clauses: Clauses, identifier: ts.Identifier): void {
  if (clauses.resolver && identifier.text === RESOLVER) {
    report(
      context,
      identifier,
      `references ${RESOLVER} outside ${PRICE_CORE}. There is one tier resolver and ` +
        'only the price core calls it; ask the core for the priced figure instead.'
    );
  }
  if (!clauses.ratioReferences) return;
  const ratio = referencedRatio(context.checker, identifier);
  if (ratio === undefined) return;
  report(
    context,
    identifier,
    `references the ratio ${ratio} outside ${QUANTITIES_MODULE}. Convert through the ` +
      'conversions that module exports, which are the only readers of a ratio.'
  );
}

function checkRatioDeclaration(context: FileContext, clauses: Clauses, node: ts.Node): void {
  const name = keyText((node as ts.NamedDeclaration).name);
  if (name === undefined || !RATIO_NAME.test(name)) return;
  if (clauses.inQuantities && ts.isVariableDeclaration(node) && RATIOS.includes(name)) return;
  report(
    context,
    node,
    `declares '${name}', a characters-per-token ratio, outside the two in ` +
      `${QUANTITIES_MODULE}. There is one input ratio and one stored-output ratio.`
  );
}

/**
 * The served-wire clause rides on the reads clause, test exemption included: no web
 * or marketing file is in the home.
 */
function checkReads(context: FileContext, clauses: Clauses, node: ts.Node): void {
  if (!clauses.ownRules) return;
  for (const read of fieldReadsAt(context, node)) {
    checkRateRead(context, read);
    if (clauses.servedWire) checkServedWireRead(context, read);
  }
}

function checkMint(context: FileContext, clauses: Clauses, node: ts.Node): void {
  if (ts.isObjectLiteralExpression(node)) checkLiteral(context, clauses, node);
  if (clauses.mintCalls && ts.isCallExpression(node)) checkMintCall(context, node);
  if (
    clauses.mint &&
    ts.isTypePredicateNode(node) &&
    namesModelPricing(context.checker, node.type)
  ) {
    report(context, node, mintMessage('narrows to a ModelPricing with a type guard'));
  }
}

function checkNames(context: FileContext, clauses: Clauses, node: ts.Node): void {
  if (ts.isIdentifier(node)) checkIdentifier(context, clauses, node);
  if (clauses.ratioDeclarations && NAMED_DECLARATIONS.has(node.kind)) {
    checkRatioDeclaration(context, clauses, node);
  }
}

/** Every type-reading and syntax clause, in one walk of the file's own tree. */
function walk(context: FileContext, clauses: Clauses, node: ts.Node): void {
  checkReads(context, clauses, node);
  checkMint(context, clauses, node);
  checkNames(context, clauses, node);
  ts.forEachChild(node, (child) => {
    walk(context, clauses, child);
  });
}

function clausesFor(sourceFile: SourceFile): Clauses {
  const text = sourceFile.getFullText();
  const isTest = isTestFile(sourceFile.getFilePath());
  const mint = !isMintPlace(sourceFile);
  return {
    ownRules: !isTest && !isInHome(sourceFile),
    mint,
    mintCalls: mint && MINTING_CALLS.some((call) => text.includes(call)),
    servedWire: SERVED_WIRE_TREES.some((tree) => isInTree(sourceFile, tree)),
    resolver: !isInTree(sourceFile, PRICE_CORE) && text.includes(RESOLVER),
    ratioReferences:
      !isTest &&
      !isFile(sourceFile, QUANTITIES_MODULE) &&
      RATIOS.some((ratio) => text.includes(ratio)),
    ratioDeclarations: !isTest && RATIO_NAME.test(text),
    inQuantities: isFile(sourceFile, QUANTITIES_MODULE),
    proofsExempt: isTest,
  };
}

function retiredNameViolations(sourceFile: SourceFile): ArchViolation[] {
  if (!RETIRED_NAME_TREES.some((tree) => isInTree(sourceFile, tree))) return [];
  const text = sourceFile.getFullText();
  const violations: ArchViolation[] = [];
  for (const name of RETIRED_NAMES) {
    for (const match of text.matchAll(new RegExp(String.raw`\b${name}\b`, 'g'))) {
      violations.push({
        file: relativePath(sourceFile),
        line: sourceFile.getLineAndColumnAtPos(match.index).line,
        message:
          `names the retired '${name}'. The price core replaced it; its quantities and ` +
          'schedule modules hold the one conversion and the one resolver.',
      });
    }
  }
  return violations;
}

/** One violation per line and message, so a name read twice on one line reports once. */
function perLine(violations: readonly ArchViolation[]): ArchViolation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.file}:${String(violation.line)}:${violation.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Every clause, over one scanned file. */
function fileViolations(
  sourceFile: SourceFile,
  checker: ts.TypeChecker,
  facts: PriceFacts
): ArchViolation[] {
  const context: FileContext = {
    sourceFile,
    node: sourceFile.compilerNode,
    checker,
    facts,
    violations: retiredNameViolations(sourceFile),
  };
  walk(context, clausesFor(sourceFile), context.node);
  return perLine(context.violations);
}

/**
 * Every `@hushbox/shared` import in a scanned file resolves. Each clause judges a
 * resolved declaration, and a resolution that fails reads exactly like a clean
 * repository, so an import that resolves nowhere makes this rule blind rather
 * than satisfied.
 */
function assertSharedImportsResolve(sourceFile: SourceFile): void {
  for (const declaration of [
    ...sourceFile.getImportDeclarations(),
    ...sourceFile.getExportDeclarations(),
  ]) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === undefined || !SHARED_PACKAGE.test(specifier)) continue;
    if (declaration.getModuleSpecifierSourceFile() !== undefined) continue;
    fail(
      `cannot resolve '${specifier}' from ${relativePath(sourceFile)}, so no price ` +
        'declaration it reaches can be judged. The rule is blind rather than satisfied.'
    );
  }
}

function moduleOrFail(project: Project, repoPath: string): SourceFile {
  const module = sourceFileAt(project, repoPath);
  if (module === undefined) return fail(`'${repoPath}' names no file in the scanned tree.`);
  return module;
}

function standsOverNothing(module: string, name: string): never {
  return fail(
    `'${module}' no longer declares '${name}', so the clauses naming it stand over ` +
      'nothing. Point the rule at its new home.'
  );
}

/** The schedule, quantities and served schema modules still declare what each clause names. */
function assertDeclarationsStand(
  schedule: SourceFile,
  quantities: SourceFile,
  wire: SourceFile
): void {
  for (const name of SCHEDULE_DECLARATIONS) {
    const declared =
      schedule.getInterface(name) ?? schedule.getTypeAlias(name) ?? schedule.getFunction(name);
    if (declared === undefined) standsOverNothing(SCHEDULE_MODULE, name);
  }
  for (const name of RATIOS) {
    if (quantities.getVariableDeclaration(name) === undefined) {
      standsOverNothing(QUANTITIES_MODULE, name);
    }
  }
  assertWireStands(wire);
  assertKindDiscriminates(schedule);
}

/** The served schema module still declares both pricing schemas and both pool bounds. */
function assertWireStands(wire: SourceFile): void {
  for (const name of WIRE_SCHEMAS) {
    if (wire.getVariableDeclaration(name) === undefined) standsOverNothing(WIRE_MODULE, name);
  }
  const wireKeys = new Set<string>();
  propertyNamesUnder(wire.compilerNode, wireKeys);
  for (const name of POOL_BOUNDS) {
    if (!wireKeys.has(name)) standsOverNothing(WIRE_MODULE, name);
  }
}

/**
 * Every variant of `PricingShapes` still declares `kind`: the reads clause exempts
 * that field as the discriminant, and a literal is asked its contextual type
 * because it names it.
 */
function assertKindDiscriminates(schedule: SourceFile): void {
  const shapes = schedule.getTypeAliasOrThrow(PRICING_SHAPES).getTypeNodeOrThrow().compilerNode;
  const variants = ts.isUnionTypeNode(shapes) ? shapes.types : [shapes];
  const discriminated = variants.every(
    (variant) =>
      ts.isTypeLiteralNode(variant) &&
      variant.members.some((member) => keyText(member.name) === DISCRIMINANT)
  );
  if (!discriminated) {
    fail(
      `a variant of ${PRICING_SHAPES} in '${SCHEDULE_MODULE}' no longer declares ` +
        `'${DISCRIMINANT}', so the reads clause exempts a field that no longer names the ` +
        'variant. Point the rule at the discriminant the price now carries.'
    );
  }
}

/** Every clause over the files a project judges, read through that project's own checker. */
function projectViolations(
  project: Project,
  judged: readonly SourceFile[],
  facts: PriceFacts
): ArchViolation[] {
  const checker = project.getTypeChecker().compilerObject;
  return judged.flatMap((sourceFile) => {
    assertSharedImportsResolve(sourceFile);
    return fileViolations(sourceFile, checker, facts);
  });
}

function isWebFile(sourceFile: SourceFile): boolean {
  return isInTree(sourceFile, WEB_SOURCE_TREE);
}

/**
 * The web tree's violations, judged before the rest so that a program built for
 * the web package is garbage by the time the shared project's own checker grows.
 */
function webTreeViolations(
  project: Project,
  web: readonly SourceFile[],
  facts: PriceFacts
): ArchViolation[] {
  const webProject = webProgram(project, web);
  const judged = webProject.getSourceFiles().filter((sourceFile) => isWebFile(sourceFile));
  return projectViolations(webProject, judged, facts);
}

/**
 * Every tree the retired names are swept in holds a scanned file. A tree that
 * moved or left the scan reads exactly like a tree with no retired name in it.
 */
function assertRetiredNameTreesPopulated(project: Project): void {
  const files = project.getSourceFiles();
  for (const tree of RETIRED_NAME_TREES) {
    if (files.some((sourceFile) => isInTree(sourceFile, tree))) continue;
    fail(
      `no scanned file lives under '${tree}/', so the retired names are swept over ` +
        'a tree the scan no longer reads. Point the sweep at where that source lives now.'
    );
  }
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    assertRetiredNameTreesPopulated(project);
    assertNamedPathsExist(
      RULE,
      project,
      [PRICING_FIXTURE, ...PRICE_HOME.filter((home) => !home.endsWith('/'))],
      'Point the rule at where the price home lives now.'
    );
    const schedule = moduleOrFail(project, SCHEDULE_MODULE);
    const quantities = moduleOrFail(project, QUANTITIES_MODULE);
    const wire = moduleOrFail(project, WIRE_MODULE);
    assertDeclarationsStand(schedule, quantities, wire);
    const facts = readPriceFacts(schedule, wire);
    const scanned = project.getSourceFiles();
    const webViolations = webTreeViolations(
      project,
      scanned.filter((sourceFile) => isWebFile(sourceFile)),
      facts
    );
    return [
      ...webViolations,
      ...projectViolations(
        project,
        scanned.filter((sourceFile) => !isWebFile(sourceFile)),
        facts
      ),
    ];
  },
};

export default rule;
