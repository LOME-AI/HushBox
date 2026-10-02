import { Node, SyntaxKind } from 'ts-morph';
import { isRepoPath, relativePath } from '../lib/paths.js';
import type {
  CallExpression,
  CaseOrDefaultClause,
  Project,
  PropertyAssignment,
  SourceFile,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The domain-error-code → HTTP-status mapping has exactly ONE home; any second
 * location that carries it, in any syntactic shape, is a violation.
 *
 * Why a structural rule and not a lint or a duplication check: the thing
 * duplicated is knowledge, not text. Eight short pairs are below jscpd's
 * minimum token count, so thirteen verbatim copies stayed green for months; a
 * fourteenth written as a ts-pattern chain shared almost no tokens with them
 * and was invisible by construction. TypeScript checked the wrong property —
 * each copy was annotated against the closed code set, so the compiler proved
 * every copy COMPLETE and never that the copies AGREED, and one saying 504
 * where twelve said 408 compiled cleanly from its first commit.
 *
 * Two clauses. The first is structural, not co-occurrence: it needs a code name
 * and a status literal joined by one syntactic construct — object keys,
 * `switch` cases, `.with()` arms, `Map` entries and `.set()` calls, ternary
 * branches, and sibling properties of a single object literal, the shape a
 * per-decision constant takes (`{ status: 403, code: 'forbidden' }`, the code
 * name in VALUE position). A file merely holding code names beside status
 * numbers (a route test asserting both) pairs nothing and passes. The second
 * catches what the first cannot see: a carrier built by iterating the closed
 * set and zipping statuses positionally spells no code name at all, so a value
 * import of the set plus a 4xx/5xx literal in expression position is enough.
 *
 * The first clause counts its pairs at two strengths, because a count of
 * coinciding NAMES is the wrong evidence on its own — the base taxonomy's names
 * are ordinary refusal words, and another closed vocabulary in this repo draws
 * from the same well, so names coincide in a file that maps nothing. What
 * separates them is what the values ARE: a status mapping VALUES a code name at
 * a status ({@link yieldsStatus}), while the coinciding file values the same
 * names at wire-refusal objects. Three status-valued pairs are therefore a
 * carrier, and it takes four of the weaker kind — a status merely present
 * alongside — to say the same thing. This is why the fix for a missed
 * three-code carrier is a sharper pair and not a lower threshold: the lower
 * threshold alone was measured, and it convicts the coinciding file.
 *
 * The key vocabulary is READ from the taxonomy's own declaration, never copied
 * here: a copy would be a sync contract whose failure mode is silent narrowing
 * — a ninth base code shrinking the rule's reach with nothing to say so, which
 * is the defect this rule exists to close, one level up. Reading it inverts
 * that: a ninth code widens the rule on its own, and a taxonomy that moves or
 * is renamed fails the run loudly because the rule cannot find what it needs.
 *
 * Known limits, so they are recorded rather than discovered. It catches a
 * second LOCATION, never a wrong VALUE — it closes the drift class, not the
 * correctness class. It misses a carrier naming codes indirectly through
 * aliased constants, one keyed on the WIRE code (an independent vocabulary, and
 * one such near-miss correctly is not a carrier), and one assembled from data at
 * runtime. Below four names it needs the status to be the value, so a
 * three-code carrier that wraps its statuses in objects goes on being missed.
 * A `case` that assigns its status to a variable instead of returning it is the
 * weaker pair, not the sharper one. Comments and prose are not nodes, so they
 * are never evidence. Materially better net, not a proof.
 */

/** Where the closed base taxonomy is declared, and the export that holds it. */
const TAXONOMY_MODULE = 'apps/api/src/lib/errors/domain-error.ts';
const CLOSED_SET_EXPORT = 'DOMAIN_ERROR_CODES';

/** How many paired names make a file a carrier rather than a coincidence. */
const PAIR_THRESHOLD = 4;

/**
 * How many STATUS-VALUED pairs make a carrier. Lower, because the pair is
 * sharper: the construct's value for that code name is the status itself, which
 * is what a status mapping is. Three is below the coincidence threshold and
 * safely so — the vocabulary collision this guards against pairs code names with
 * values of some other type, never with a status.
 */
const STATUS_VALUED_THRESHOLD = 3;

const STATUS_MIN = 400;
const STATUS_MAX = 599;

const CANONICAL_HOME = 'apps/api/src/lib/context/domain-error-status.ts';

/**
 * Repo-relative paths this rule does not judge, each with the reason it is out.
 * The canonical home and its test are the mapping's one location; anything else
 * here is a file whose ingredients the clauses see but whose content is not the
 * mapping, and it says so in one line.
 */
export const ALLOWED_CARRIERS: Readonly<Record<string, string>> = {
  [CANONICAL_HOME]: 'The one home — the mapping is supposed to be written here.',
  'apps/api/src/lib/context/domain-error-status.test.ts':
    "The home's own test, which has to restate the pairs to pin them.",
  'apps/api/src/slices/chat/routes-refusal-status.integration.test.ts':
    'Keyed on wire codes, an independent vocabulary; it imports the closed set only to enumerate refusal parity and pairs no domain code with a status.',
};

const REMEDY = `import STATUS_BY_DOMAIN_CODE from ${CANONICAL_HOME} instead`;

function isAllowed(filePath: string): boolean {
  return Object.keys(ALLOWED_CARRIERS).some((allowed) => isRepoPath(filePath, allowed));
}

/** Strips the wrappers that sit between a value position and its literal. */
function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/** A 4xx/5xx numeric literal in expression position — never a type literal. */
function isStatusLiteral(node: Node | undefined): boolean {
  if (node === undefined) return false;
  const inner = unwrap(node);
  if (!Node.isNumericLiteral(inner)) return false;
  if (Node.isLiteralTypeNode(inner.getParent())) return false;
  const value = inner.getLiteralValue();
  return value >= STATUS_MIN && value <= STATUS_MAX;
}

function containsStatusLiteral(node: Node): boolean {
  return isStatusLiteral(node) || node.getDescendants().some((child) => isStatusLiteral(child));
}

function anyContainsStatusLiteral(nodes: readonly Node[]): boolean {
  return nodes.some((node) => containsStatusLiteral(node));
}

/**
 * The value slot IS a status — the node resolves to a status literal and to
 * nothing else, through the indirections a mapping is written with: a `.with()`
 * arm's callback, a `case` label's `return`, a wrapped literal.
 *
 * This is the rule's discriminant, and it reads what the mapping's values ARE
 * rather than how many code names a file happens to spell. A status mapping's
 * values are statuses; a file from an independent vocabulary that pairs the same
 * names with values of some other type — a wire-refusal object, a per-decision
 * constant — resolves here to false however many names coincide. Syntactic on
 * purpose.
 */
function yieldsStatus(node: Node): boolean {
  const inner = unwrap(node);
  if (isStatusLiteral(inner)) return true;
  if (Node.isArrowFunction(inner)) return yieldsStatus(inner.getBody());
  if (Node.isReturnStatement(inner)) {
    const returned = inner.getExpression();
    return returned !== undefined && yieldsStatus(returned);
  }
  return false;
}

/**
 * Any of these nodes values a code name at a status — the node itself, or a
 * `return` anywhere beneath it, which is how a braced body (a `case` that
 * returns, an arm callback written with a block) states the value it yields.
 */
function anyYieldsStatus(nodes: readonly Node[]): boolean {
  return nodes.some(
    (node) =>
      yieldsStatus(node) ||
      node
        .getDescendantsOfKind(SyntaxKind.ReturnStatement)
        .some((statement) => yieldsStatus(statement))
  );
}

/** The string a node spells, when it spells one literally. */
function stringValue(node: Node): string | undefined {
  const inner = unwrap(node);
  if (Node.isStringLiteral(inner) || Node.isNoSubstitutionTemplateLiteral(inner)) {
    return inner.getLiteralValue();
  }
  return undefined;
}

/** The elements of the closed set's array literal, however it is wrapped. */
function closedSetElements(taxonomy: SourceFile): readonly Node[] {
  const initializer = taxonomy.getVariableDeclaration(CLOSED_SET_EXPORT)?.getInitializer();
  if (initializer === undefined) return [];
  const literal = unwrap(initializer);
  return Node.isArrayLiteralExpression(literal) ? literal.getElements() : [];
}

/**
 * The mapping's key vocabulary, as the taxonomy declares it. Every way of
 * failing to read it throws: a rule that fell back to a narrower set would go
 * on matching, which is precisely the silent narrowing it exists to prevent.
 */
function declaredCodeNames(project: Project): ReadonlySet<string> {
  const taxonomy = project
    .getSourceFiles()
    .find((sourceFile) => isRepoPath(relativePath(sourceFile), TAXONOMY_MODULE));
  if (taxonomy === undefined) {
    throw new Error(
      `domain-error-status-map-has-one-home: ${TAXONOMY_MODULE} is not in the scanned tree, so the closed code set cannot be read. Point this rule at the taxonomy's new home.`
    );
  }

  const elements = closedSetElements(taxonomy);
  const names = elements
    .map((element) => stringValue(element))
    .filter((name) => name !== undefined);
  if (names.length === 0 || names.length !== elements.length) {
    throw new Error(
      `domain-error-status-map-has-one-home: ${CLOSED_SET_EXPORT} in ${TAXONOMY_MODULE} is no longer an array of string literals, so the closed code set cannot be read.`
    );
  }
  return new Set(names);
}

function codeNameOf(node: Node, codes: ReadonlySet<string>): string | undefined {
  const value = stringValue(node);
  return value !== undefined && codes.has(value) ? value : undefined;
}

/** Every code name spelled literally anywhere inside a node. */
function codeNamesIn(node: Node, codes: ReadonlySet<string>): string[] {
  const own = codeNameOf(node, codes);
  const names = own === undefined ? [] : [own];
  for (const descendant of node.getDescendants()) {
    const name = codeNameOf(descendant, codes);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** The name a property is written under, whether bare or quoted. */
function propertyKeyName(node: Node): string | undefined {
  if (Node.isIdentifier(node)) return node.getText();
  return stringValue(node);
}

type Pairs = Map<string, number>;

/**
 * One file's scan. `pairs` is every code name joined to a status literal by one
 * construct; `statusValued` is the subset whose construct VALUES that name with
 * the status, which is the sharper evidence and carries the lower threshold.
 */
interface Scan {
  readonly codes: ReadonlySet<string>;
  readonly pairs: Pairs;
  readonly statusValued: Pairs;
}

function remember(pairs: Pairs, name: string, line: number): void {
  const known = pairs.get(name);
  if (known === undefined || line < known) pairs.set(name, line);
}

function record(scan: Scan, name: string, at: Node, statusValued: boolean): void {
  const line = at.getStartLineNumber();
  remember(scan.pairs, name, line);
  if (statusValued) remember(scan.statusValued, name, line);
}

/** `{ validation: 400 }` — a code name in key position over a status value. */
function collectObjectKeys(sourceFile: SourceFile, scan: Scan): void {
  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = propertyKeyName(property.getNameNode());
    if (name === undefined || !scan.codes.has(name)) continue;
    if (isStatusLiteral(property.getInitializer())) record(scan, name, property, true);
  }
}

/** The statements a label reaches, following empty labels through fallthrough. */
function reachedStatements(
  clauses: readonly CaseOrDefaultClause[],
  index: number
): readonly Node[] {
  for (const clause of clauses.slice(index)) {
    const statements = clause.getStatements();
    if (statements.length > 0) return statements;
  }
  return [];
}

function collectCaseBlock(clauses: readonly CaseOrDefaultClause[], scan: Scan): void {
  for (const [index, clause] of clauses.entries()) {
    if (!Node.isCaseClause(clause)) continue;
    const name = codeNameOf(clause.getExpression(), scan.codes);
    if (name === undefined) continue;
    const reached = reachedStatements(clauses, index);
    if (anyContainsStatusLiteral(reached)) record(scan, name, clause, anyYieldsStatus(reached));
  }
}

/** `case 'validation': return 400;`, fallthrough labels included. */
function collectSwitchCases(sourceFile: SourceFile, scan: Scan): void {
  for (const block of sourceFile.getDescendantsOfKind(SyntaxKind.CaseBlock)) {
    collectCaseBlock(block.getClauses(), scan);
  }
}

function collectWithArm(
  call: CallExpression,
  pattern: Node,
  rest: readonly Node[],
  scan: Scan
): void {
  if (!anyContainsStatusLiteral(rest)) return;
  const statusValued = anyYieldsStatus(rest);
  for (const name of codeNamesIn(pattern, scan.codes)) record(scan, name, call, statusValued);
}

function collectSetEntry(call: CallExpression, pattern: Node, value: Node, scan: Scan): void {
  const name = codeNameOf(pattern, scan.codes);
  if (name !== undefined && isStatusLiteral(value)) record(scan, name, call, true);
}

/** `.with({ code: 'validation' }, () => 400)` and `.set('validation', 400)`. */
function collectArmCalls(sourceFile: SourceFile, scan: Scan): void {
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const [pattern, ...rest] = call.getArguments();
    const second = rest[0];
    if (pattern === undefined || second === undefined) continue;
    const method = callee.getName();
    if (method === 'with') collectWithArm(call, pattern, rest, scan);
    if (method === 'set' && rest.length === 1) collectSetEntry(call, pattern, second, scan);
  }
}

/** `['validation', 400]` — the entry shape a `Map` or lookup table is built from. */
function collectEntryTuples(sourceFile: SourceFile, scan: Scan): void {
  for (const array of sourceFile.getDescendantsOfKind(SyntaxKind.ArrayLiteralExpression)) {
    const [key, value, extra] = array.getElements();
    if (key === undefined || value === undefined || extra !== undefined) continue;
    const name = codeNameOf(key, scan.codes);
    if (name !== undefined && isStatusLiteral(value)) record(scan, name, array, true);
  }
}

/**
 * `{ status: 403, code: 'forbidden' }` — the pair split across sibling
 * properties of one literal, where the code name sits in VALUE position rather
 * than key or arm position. Scoped to the literal's own properties: a nested
 * literal is judged on its own, so a status and a code name that never share an
 * object are never paired by this collector.
 *
 * Never status-valued: the code name is the value here, and the status is a
 * sibling of it rather than what it maps to. The pair is real but weaker, so it
 * stays on the coincidence threshold.
 */
function collectCodeValuedProperties(properties: readonly PropertyAssignment[], scan: Scan): void {
  for (const property of properties) {
    const initializer = property.getInitializer();
    const name = initializer === undefined ? undefined : codeNameOf(initializer, scan.codes);
    if (name !== undefined) record(scan, name, property, false);
  }
}

function collectSiblingProperties(sourceFile: SourceFile, scan: Scan): void {
  for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const properties = literal
      .getProperties()
      .filter((property): property is PropertyAssignment => Node.isPropertyAssignment(property));
    if (properties.some((property) => isStatusLiteral(property.getInitializer()))) {
      collectCodeValuedProperties(properties, scan);
    }
  }
}

/** `code === 'validation' ? 400 : …` — the chained-ternary spelling. */
function collectTernaryBranches(sourceFile: SourceFile, scan: Scan): void {
  for (const conditional of sourceFile.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    const names = codeNamesIn(conditional.getCondition(), scan.codes);
    if (names.length === 0) continue;
    if (!isStatusLiteral(conditional.getWhenTrue()) && !isStatusLiteral(conditional.getWhenFalse()))
      continue;
    for (const name of names) record(scan, name, conditional, true);
  }
}

function scanFile(sourceFile: SourceFile, codes: ReadonlySet<string>): Scan {
  const scan: Scan = { codes, pairs: new Map(), statusValued: new Map() };
  collectObjectKeys(sourceFile, scan);
  collectSwitchCases(sourceFile, scan);
  collectArmCalls(sourceFile, scan);
  collectEntryTuples(sourceFile, scan);
  collectSiblingProperties(sourceFile, scan);
  collectTernaryBranches(sourceFile, scan);
  return scan;
}

/** A value import of the closed set — the only handle a positional carrier has. */
function importsClosedSet(sourceFile: SourceFile): boolean {
  return sourceFile
    .getImportDeclarations()
    .filter((declaration) => !declaration.isTypeOnly())
    .flatMap((declaration) => declaration.getNamedImports())
    .some((named) => !named.isTypeOnly() && named.getName() === CLOSED_SET_EXPORT);
}

function firstStatusLiteralLine(sourceFile: SourceFile): number | undefined {
  for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.NumericLiteral)) {
    if (isStatusLiteral(literal)) return literal.getStartLineNumber();
  }
  return undefined;
}

function carrierViolation(filePath: string, pairs: Pairs, evidence: string): ArchViolation {
  const names = [...pairs.keys()].toSorted((a, b) => a.localeCompare(b));
  return {
    file: filePath,
    line: Math.min(...pairs.values()),
    message: `Second home for the domain-error-code → HTTP-status mapping: ${String(pairs.size)} codes ${evidence} (${names.join(', ')}) — ${REMEDY}.`,
  };
}

function violationFor(
  sourceFile: SourceFile,
  filePath: string,
  codes: ReadonlySet<string>
): ArchViolation | undefined {
  const { pairs, statusValued } = scanFile(sourceFile, codes);
  if (statusValued.size >= STATUS_VALUED_THRESHOLD) {
    return carrierViolation(filePath, statusValued, 'valued at a status literal');
  }
  if (pairs.size >= PAIR_THRESHOLD) {
    return carrierViolation(filePath, pairs, 'paired with a status literal');
  }

  if (!importsClosedSet(sourceFile)) return undefined;
  const statusLine = firstStatusLiteralLine(sourceFile);
  if (statusLine === undefined) return undefined;
  return {
    file: filePath,
    line: statusLine,
    message: `Imports ${CLOSED_SET_EXPORT} and holds a 4xx/5xx literal, the shape a positionally-zipped status mapping takes — ${REMEDY}.`,
  };
}

const rule: ArchRule = {
  name: 'domain-error-status-map-has-one-home',
  check(project) {
    const codes = declaredCodeNames(project);
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (isAllowed(filePath)) continue;
      const violation = violationFor(sourceFile, filePath, codes);
      if (violation !== undefined) violations.push(violation);
    }
    return violations;
  },
};

export default rule;
