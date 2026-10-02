import { Node, SyntaxKind } from 'ts-morph';
import { moduleReferences } from '../lib/module-references.js';
import { isTestFile, relativePath } from '../lib/paths.js';
import { handlerNode, routeRegistrations, unwrap } from '../lib/route-shapes.js';
import { TABLE_OWNER, ownersOf } from './single-writer-per-table.rule.js';
import type {
  CallExpression,
  Identifier,
  Project,
  SourceFile,
  VariableDeclaration,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The seam between the two halves of growth measurement, made structural.
 *
 * The anonymous half counts marketing visitors under a keyed hash that lives in
 * Redis and in no table, and how long a counting set holds it is
 * `addUnderCeiling`'s to say
 * (`apps/api/src/slices/growth/domain/ceiling-gate.ts`); the identified half
 * starts at the moment an account exists. The product promise is that the two
 * never join, and a promise that has to hold across every future edit holds as
 * a build failure or not at all.
 *
 * The subject set is every table the ownership map attributes to `growth`, read
 * from {@link TABLE_OWNER}, never from a name prefix or a file glob. That is
 * load-bearing rather than tidy: `campaigns` is growth-owned and carries no
 * growth prefix, and its relations block is exactly where a path into an account
 * would be opened, so a rule keyed on naming passes the one declaration it
 * exists to catch. The map is total in both directions against the schema
 * barrel — `single-writer-per-table` asserts that — so every growth table is a
 * subject and every subject has a declaration in the scanned tree.
 *
 * THE POSTURE EVERY CHECK HERE HOLDS TO. A symbol is resolved through the file's
 * renames rather than matched as written text; a declaration is unwrapped past
 * its type assertions and its call chain before it is read; and a construct the
 * walk cannot read is REPORTED rather than skipped. Patching one spelling at a
 * time does not converge — there is always another — so each check asks its
 * question of a property instead: {@link namingNodes} asks where a file names a
 * symbol at all, and the relation walk asks where a builder is read at all.
 * Every check that watches ONE WORD goes through {@link namingNodes}, the growth
 * doors included. A door check written instead as a list of declaration shapes
 * matches the name and misses the value: `export const h = visitorHash` on a
 * door publishes the hash under a name of its own, and was reported by nothing.
 *
 * The door's SECOND question is not about a word, and the same rule decides its
 * shape. A list of PUBLICATION shapes misses the value exactly as a list of
 * declaration shapes missed the name — `import * as vh from './visitor-hash.js';
 * export const hashing = vh` publishes the module under a name of its own, and a
 * check reading export clauses sees nothing. So {@link wholeModuleNodes} asks
 * where a whole module ENTERS the file instead: the ways in are the module
 * system's own and closed, while the ways it can then be published are not.
 *
 * Six exceptions are deliberate, and are the whole list. Each narrows a report
 * that would otherwise fire on ordinary code; nothing else here is skipped on
 * purpose.
 *
 * 1. A declaration the rule cannot read as a table is reported only inside the
 *    schema tree's own source, because reporting on a growth table's NAME
 *    anywhere would fire on a page's `const campaigns = [...]`
 *    ({@link accountColumnViolations}).
 * 2. A relations declaration whose SUBJECT does not resolve is reported wherever
 *    the factory is named directly, and under the member spelling
 *    (`orm.relations(…)`) only inside that same schema source — because
 *    `<anything>.relations(x)` elsewhere is ordinarily not a schema declaration
 *    at all, while inside the schema source it is
 *    ({@link relationDeclarationViolations}).
 * 3. A builder's name in a property-name position is a property rather than the
 *    builder ({@link isBuilderReference}).
 * 4. A name a file ASSEMBLES is reported in the keyed position and nowhere else
 *    ({@link computedNameNodes}), because the growth tree builds Redis keys and
 *    log lines out of templates constantly.
 * 5. Both arms confined to the schema tree are confined to its NON-TEST source
 *    ({@link declaresTables}), so an unreadable growth-table declaration, and a
 *    member-spelled relations declaration whose subject does not resolve, are
 *    each skipped inside a schema TEST file — where constants and fixtures carry
 *    table names constantly and none of them is a declaration.
 * 6. The route arm stands over the growth slice's NON-TEST source (the
 *    {@link isSliceSource} gate in {@link fileViolations}), so a growth route
 *    registered in a TEST file under a handler this rule cannot resolve is
 *    skipped. A test registers routes to exercise handlers the slice declares,
 *    and {@link principalViolations} reads those wherever in this tree they are
 *    written; the arm is for production wiring, where an unresolvable handler is
 *    the reach.
 *
 * Both of those last two skip a test file, and they are the only two that do.
 * Every other arm here stands over the growth tree's tests as it does over its
 * source, which {@link resolverMessage} says out loud to whoever it reports.
 *
 * Its blind spots, stated so nobody over-trusts it. It constrains what the
 * SCHEMA and the SLICE TREES declare: a growth read that joins to identity at
 * query time is legitimate, is how the funnel views are built, and is invisible
 * here. Two spellings of a name are invisible too — the word in a comment,
 * which is prose rather than a reach, and a name computed at runtime outside
 * the keyed position, which no syntactic walk closes in general.
 *
 * And every check reads ONE FILE, which bounds the door arms precisely: a name
 * is not a value. A module inside the slice may legally bind the hash to a name
 * of its own — `export const hash = visitorHash` in `domain/` is ordinary — and
 * a door re-exporting THAT name — `export { hash } from
 * './domain/record-beacon.js'`, or `export { default as hash } from` a module
 * that default-exports it — writes no name this walk matches and carries no
 * whole module. Closing that one means resolving a re-exported symbol to its
 * declaration in another module, which is value flow rather than a walk over
 * one file's syntax; this rule does not.
 *
 * It is a limit on what the walk REACHES, not a construct it skips — and its
 * cost is the binding as well as the re-export. Nothing under `apps/api/src`
 * binds the hash under a second name today, so the reach is two lines in two
 * files; the day some module binds one for its own reasons, it is one line on a
 * door.
 */

const GROWTH_SLICE = 'growth';
const IDENTITY_SLICE = 'identity';
const SLICES_TREE = 'apps/api/src/slices/';

/** Where the schema declares its tables — the one tree a table name is a table in. */
const SCHEMA_TREE = 'packages/db/src/schema/';

/** The one symbol the anonymous half is counted under. */
const VISITOR_HASH = 'visitorHash';

/** A slice's published doors: its barrels, and every module under `public/`. */
const BARREL_FILE = /(^|\/)index\.tsx?$/;
const PUBLIC_DOOR_SEGMENT = '/public/';

/**
 * The symbols that turn a request into an account. Named rather than described,
 * because a rule that matched "anything session-shaped" would be satisfied by
 * renaming.
 */
const PRINCIPAL_RESOLVERS: readonly string[] = [
  'derivePrincipal',
  'resolveConversationCaller',
  'resolveMediaCaller',
];
const PRINCIPAL_PROPERTY = 'principal';

/** The session middleware module, matched by basename however it is spelled. */
const SESSION_MIDDLEWARE = /(^|\/)pipeline-session(\.[cm]?[jt]s)?$/;

const ACCOUNT_TABLE = 'users';
const ACCOUNT_COLUMN_PROPERTY = 'userId';
const ACCOUNT_COLUMN_NAME = 'user_id';
const TABLE_FACTORY = 'pgTable';
const RELATIONS_FACTORY = 'relations';

/** Every table the ownership map attributes to the growth slice. */
function growthTables(): ReadonlySet<string> {
  const owned = new Set<string>();
  for (const [table, owner] of Object.entries(TABLE_OWNER)) {
    if (ownersOf(owner).includes(GROWTH_SLICE)) owned.add(table);
  }
  return owned;
}

/** A module inside one slice's tree, tests included. */
function isInSliceTree(filePath: string, slice: string): boolean {
  return filePath.includes(`${SLICES_TREE}${slice}/`);
}

/** A non-test module inside one slice's tree. */
function isSliceSource(filePath: string, slice: string): boolean {
  return isInSliceTree(filePath, slice) && !isTestFile(filePath);
}

function isPublishedDoor(filePath: string): boolean {
  return BARREL_FILE.test(filePath) || filePath.includes(PUBLIC_DOOR_SEGMENT);
}

/** Local name → imported name, for every named import the file renames. */
function importAliases(sourceFile: SourceFile): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    for (const named of declaration.getNamedImports()) {
      const alias = named.getAliasNode()?.getText();
      if (alias !== undefined) aliases.set(alias, named.getName());
    }
  }
  return aliases;
}

/**
 * The name a local identifier was imported under. Every comparison against a
 * table name goes through this, because a rename is a spelling of the same
 * table: `import { users as accounts }` makes `accounts.id` the account column
 * the seam forbids, under a name the map does not hold.
 */
function importedName(written: string, aliases: ReadonlyMap<string, string>): string {
  return aliases.get(written) ?? written;
}

/**
 * Every node in the file that names a symbol in a position syntax can see: the
 * identifier itself, and the string a computed access or a keyed getter spells
 * it with (`c.get('principal')`, `context['derivePrincipal']`). Naming rather
 * than shape, because the checks that watch a WORD — the principal, the session
 * resolvers, and the visitor hash in identity as on a growth door — all ask the
 * same question of a different one, and a per-check list of read shapes is what
 * stops converging. The table and relation checks watch a declaration rather
 * than a word, and ask their own question of it.
 *
 * A rename is already covered by this without resolving one: an import writes
 * the imported name in its own clause, so `import { derivePrincipal as dp }`
 * names the symbol at the import. Both written spellings of a string are read
 * ({@link writtenStrings}); a name the file assembles instead of writing is
 * read by nothing and is reported where it stands in a keyed position
 * ({@link computedNameNodes}). What remains unseen is the word in a comment,
 * which is prose rather than a reach.
 */
function namingNodes(sourceFile: SourceFile, symbol: string): Node[] {
  return [
    ...sourceFile
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .filter((identifier) => identifier.getText() === symbol),
    ...writtenStrings(sourceFile, symbol),
  ];
}

/**
 * Every literal under a node whose value is exactly this word, in BOTH spellings
 * an ordinary written string has: `'user_id'` and `` `user_id` ``. A backtick
 * string with no substitution is the same value, the same semantics and a
 * spelling the formatter never rewrites, so a walk reading only
 * `StringLiteral` was blind to it wherever a name is written as a string.
 */
function writtenStrings(node: Node, value: string): Node[] {
  return [
    ...node.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...node.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ].filter((literal) => literal.getLiteralValue() === value);
}

const COMPUTED_NAME_MESSAGE =
  'this lookup assembles the name it reaches, so no syntax here says which symbol it ' +
  'names — and the principal, the session resolvers and the visitor hash are each ' +
  'reached by name. Write the name out.';

/**
 * A name this file builds rather than writes: a template with a substitution
 * standing in a keyed position, `context[`derive${part}`]`. Its value is not in
 * the syntax, so {@link namingNodes} cannot read it and the reach is reported
 * instead.
 *
 * The keyed position is the narrowing, and it is deliberate: a growth module
 * builds Redis keys and log lines out of templates constantly, so reporting
 * every template would fire on ordinary code rather than on a reach. The cost
 * is stated rather than implied — a template handed to a keyed GETTER,
 * `c.get(`princ${x}`)`, stands in an argument position this does not report,
 * and no syntactic walk closes a name assembled at runtime in general.
 */
function computedNameNodes(sourceFile: SourceFile): Node[] {
  return sourceFile.getDescendantsOfKind(SyntaxKind.TemplateExpression).filter((template) => {
    const parent = template.getParent();
    if (Node.isElementAccessExpression(parent)) {
      return parent.getArgumentExpression() === template;
    }
    return Node.isComputedPropertyName(parent);
  });
}

function computedNameViolations(sourceFile: SourceFile, file: string): ArchViolation[] {
  return computedNameNodes(sourceFile).map((node) => ({
    file,
    line: node.getStartLineNumber(),
    message: COMPUTED_NAME_MESSAGE,
  }));
}

// ---------------------------------------------------------------------------
// No growth-owned table carries an account column.
// ---------------------------------------------------------------------------

const COLUMN_MESSAGE =
  'no growth-owned table carries an account column: the anonymous half counts under a ' +
  'hash that exists in Redis and in no table, so a column naming, or pointing at, an ' +
  'account is the join this design promises does not exist.';

const UNREADABLE_TABLE_MESSAGE =
  'this declaration carries a growth-owned table name in a shape this rule cannot read ' +
  'as a table definition, so it cannot see whether the table carries an account column. ' +
  "Declare the table as a direct 'pgTable(…)' call.";

const UNREADABLE_COLUMNS_MESSAGE =
  "part of this growth-owned table's column group is written in a shape this rule cannot " +
  'read — a spread it cannot follow, or a column name assembled from a template — so it ' +
  'cannot see whether an account column is among them. Spread a group declared in this ' +
  'file, and write column names out.';

const UNREADABLE_COLUMN_ARGUMENT_MESSAGE =
  'this growth-owned table takes its columns in a shape this rule cannot read at all — ' +
  'a call, a merge, anything but an object written here — so it cannot see whether an ' +
  'account column is among them. Write the columns as an object literal in the ' +
  'definition.';

/**
 * The argument position a table's columns are written in. Named rather than
 * written as a number at the read, because the read is what decides whether the
 * whole column group was seen.
 */
const COLUMNS_ARGUMENT = 1;

/**
 * The one tree a bare table name is a table in. Both arms that report a
 * construct they cannot read on a growth table's NAME are confined to it, since
 * outside it the name is ordinarily somebody's local constant.
 */
function declaresTables(file: string): boolean {
  return file.includes(SCHEMA_TREE) && !isTestFile(file);
}

/** Local name → the name it is exported under, for every renamed export. */
function exportAliases(sourceFile: SourceFile): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const declaration of sourceFile.getExportDeclarations()) {
    for (const named of declaration.getNamedExports()) {
      const alias = named.getAliasNode()?.getText();
      if (alias !== undefined) aliases.set(named.getName(), alias);
    }
  }
  return aliases;
}

/**
 * The names a declaration answers to: every name it binds, and the one each is
 * published under. A table reaches the ownership map by its exported name, so
 * `const rows = pgTable(…); export { rows as growthVisitors }` declares a
 * growth-owned table under a local name the map does not hold.
 */
function declaredNames(
  declaration: VariableDeclaration,
  exported: ReadonlyMap<string, string>
): string[] {
  const locals = boundNames(declaration);
  const published = locals
    .map((local) => exported.get(local))
    .filter((name): name is string => name !== undefined);
  return [...locals, ...published];
}

/**
 * Every name one variable declaration binds. A binding pattern binds its names
 * INSIDE the pattern rather than as the declaration's own name — a declaration's
 * `getName()` there is the pattern's text, which matches no table and no symbol
 * — so `export const { growthVisitors } = tables` was a declaration no walk
 * here had a name for.
 */
function boundNames(declaration: VariableDeclaration): string[] {
  const nameNode = declaration.getNameNode();
  if (Node.isIdentifier(nameNode)) return [nameNode.getText()];
  return nameNode.getDescendantsOfKind(SyntaxKind.Identifier).map((name) => name.getText());
}

/**
 * The call a declaration's initializer ultimately is: past any `as`/`satisfies`
 * wrapper, and at the root of a member chain, so `pgTable(…).enableRLS()` and
 * `pgTable(…) as unknown as never` are the same declaration as `pgTable(…)`.
 * `undefined` when the initializer is not a call at all.
 */
function definitionCall(initializer: Node | undefined): CallExpression | undefined {
  let current = unwrap(initializer);
  while (Node.isCallExpression(current)) {
    const callee = current.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) return current;
    const receiver = unwrap(callee.getExpression());
    if (!Node.isCallExpression(receiver)) return current;
    current = receiver;
  }
  return undefined;
}

/**
 * Whether a call is the table factory, under any name it is written with: the
 * imported name behind a rename (`import { pgTable as table }`), or the member
 * of a namespace import (`pg.pgTable(…)`). A renamed factory is the same
 * factory, and matching the written text made it a different one.
 */
function isTableFactory(call: CallExpression, aliases: ReadonlyMap<string, string>): boolean {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return importedName(callee.getText(), aliases) === TABLE_FACTORY;
  return Node.isPropertyAccessExpression(callee) && callee.getName() === TABLE_FACTORY;
}

/** The nodes a table's columns are written in, and whether all of them were read. */
interface ColumnSources {
  readonly nodes: readonly Node[];
  readonly resolved: boolean;
}

/**
 * Every node a table's columns can be written in: the columns object itself,
 * and each same-file group it spreads into the body, transitively. Rooted at
 * the columns rather than at the whole definition, because whether the COLUMNS
 * were all read is the question, and a table's constraint callback is full of
 * `sql` templates that say nothing about them. A column group is
 * a column: `{ ...owner }` puts whatever `owner` declares into the table, so a
 * walk over the definition alone reads a table's columns only when nobody
 * factored them out. A spread this rule cannot follow leaves `resolved` false
 * rather than passing the table as column-free, and so does a template with a
 * substitution anywhere among the columns, whose value is not in the syntax. A
 * group is followed once, so two groups spreading each other terminate rather
 * than spin.
 *
 * {@link spreadGroups} reads one node's own spreads; {@link columnSources} is
 * that walked to a fixed point.
 */
function spreadGroups(node: Node, sourceFile: SourceFile, seen: Set<string>): ColumnSources {
  const nodes: Node[] = [];
  let resolved = true;
  for (const spread of node.getDescendantsOfKind(SyntaxKind.SpreadAssignment)) {
    const expression = unwrap(spread.getExpression());
    if (!Node.isIdentifier(expression)) {
      resolved = false;
      continue;
    }
    const name = expression.getText();
    if (seen.has(name)) continue;
    seen.add(name);
    const group = unwrap(sourceFile.getVariableDeclaration(name)?.getInitializer());
    if (group === undefined) resolved = false;
    else nodes.push(group);
  }
  return { nodes, resolved };
}

function columnSources(definition: Node, sourceFile: SourceFile): ColumnSources {
  const nodes: Node[] = [];
  const pending: Node[] = [definition];
  const seen = new Set<string>();
  let resolved = true;
  let node = pending.pop();
  while (node !== undefined) {
    nodes.push(node);
    resolved &&= node.getDescendantsOfKind(SyntaxKind.TemplateExpression).length === 0;
    const spread = spreadGroups(node, sourceFile, seen);
    resolved &&= spread.resolved;
    pending.push(...spread.nodes);
    node = pending.pop();
  }
  return { nodes, resolved };
}

/**
 * Whether a table's columns carry an account column, in each of the three
 * spellings one is written in: the property name, the database column name, and
 * the foreign key the column declares. The foreign key is read through the
 * file's renames, so the account table under an import alias is the same column.
 */
function carriesAccountColumn(
  sources: readonly Node[],
  aliases: ReadonlyMap<string, string>
): boolean {
  return sources.some((node) => {
    const namesProperty = node
      .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
      .some((property) => property.getName() === ACCOUNT_COLUMN_PROPERTY);
    const namesColumn = writtenStrings(node, ACCOUNT_COLUMN_NAME).length > 0;
    const namesAccountTable = node
      .getDescendantsOfKind(SyntaxKind.Identifier)
      .some((identifier) => importedName(identifier.getText(), aliases) === ACCOUNT_TABLE);
    return namesProperty || namesColumn || namesAccountTable;
  });
}

/**
 * What one declaration carrying a growth-owned table's name violates, or
 * `undefined` when it is a table with no account column.
 *
 * Three unreadable shapes are each a violation rather than a pass: a
 * declaration this rule cannot read as a table at all, which is the one arm
 * narrowed to the schema's own source; a columns argument that is not an object
 * written here, which is the whole group unread; and, inside that object, a
 * spread the rule cannot follow or a template it cannot evaluate, each of which
 * is part of the group unread.
 *
 * Detection reads the whole definition while resolution reads only the columns:
 * a foreign key declared in the constraint callback names the account table as
 * surely as a column does, so the call stays in the detection set.
 */
function tableMessage(
  declaration: VariableDeclaration,
  sourceFile: SourceFile,
  aliases: ReadonlyMap<string, string>,
  schemaSource: boolean
): string | undefined {
  const call = definitionCall(declaration.getInitializer());
  if (call === undefined || !isTableFactory(call, aliases)) {
    return schemaSource ? UNREADABLE_TABLE_MESSAGE : undefined;
  }
  const argument = unwrap(call.getArguments()[COLUMNS_ARGUMENT]);
  if (argument === undefined || !Node.isObjectLiteralExpression(argument)) {
    return UNREADABLE_COLUMN_ARGUMENT_MESSAGE;
  }
  const columns = columnSources(argument, sourceFile);
  if (!columns.resolved) return UNREADABLE_COLUMNS_MESSAGE;
  return carriesAccountColumn([call, ...columns.nodes], aliases) ? COLUMN_MESSAGE : undefined;
}

/**
 * No growth-owned table carries an account column.
 *
 * The posture: the factory, the account table and the declaration's published
 * name are all resolved through the file's renames rather than matched as
 * source text; the names a binding pattern binds count as declared names;
 * assertions and call chains are unwrapped before the initializer is read; the
 * column name is read in both written spellings; a spread column group is
 * followed; and a declaration carrying a growth-owned table's name in a shape
 * this rule cannot read as a table — or a table whose columns it cannot read —
 * is reported rather than skipped.
 *
 * That last arm is confined to the schema tree's own source, which is the one
 * deliberate exception. Reporting on the name alone anywhere would fire on any
 * module that happens to declare a local constant sharing a table's name — an
 * admin page's `const campaigns = listCampaigns()` is not a table declaration —
 * while inside the schema tree the name is the table's.
 */
function accountColumnViolations(
  sourceFile: SourceFile,
  growth: ReadonlySet<string>
): ArchViolation[] {
  const file = relativePath(sourceFile);
  const aliases = importAliases(sourceFile);
  const exported = exportAliases(sourceFile);
  const schemaSource = declaresTables(file);
  const violations: ArchViolation[] = [];
  for (const declaration of sourceFile.getVariableDeclarations()) {
    const name = declaredNames(declaration, exported).find((candidate) => growth.has(candidate));
    if (name === undefined) continue;
    const message = tableMessage(declaration, sourceFile, aliases, schemaSource);
    if (message === undefined) continue;
    violations.push({
      file,
      line: declaration.getStartLineNumber(),
      message: `table '${name}' — ${message}`,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// No module in the growth slice resolves a principal.
// ---------------------------------------------------------------------------

const PRINCIPAL_MESSAGE =
  'the growth slice resolves no principal: the beacon is the one public write path of ' +
  'the anonymous half, and what it counts under exists in Redis and in no table. ' +
  'Reaching a principal anywhere in this tree is what would make the count ' +
  'attributable, so the whole tree is the subject rather than the handler alone — a ' +
  'helper one call away from the handler resolves the same principal.';

const UNRESOLVED_HANDLER_MESSAGE =
  'the terminal handler of this growth route cannot be resolved in its own file, so ' +
  'this rule cannot see whether it resolves a principal. Keep the handler inline, or ' +
  'declared beside its registration.';

/**
 * Where a growth module names the principal, one report per line.
 *
 * Every module in the tree is the subject, tests included, rather than the
 * terminal handler alone: the claim is that the beacon cannot become
 * attributable, and a helper one call away from the handler resolves the same
 * principal. The walk is {@link namingNodes}, so the property read
 * (`c.var.principal`), either half of a destructuring, the string a context is
 * asked by in either written spelling, and any name declared or imported as it
 * all read alike.
 */
function principalViolations(sourceFile: SourceFile, file: string): ArchViolation[] {
  const reported = new Set<number>();
  const violations: ArchViolation[] = [];
  for (const node of namingNodes(sourceFile, PRINCIPAL_PROPERTY)) {
    const line = node.getStartLineNumber();
    if (reported.has(line)) continue;
    reported.add(line);
    violations.push({ file, line, message: PRINCIPAL_MESSAGE });
  }
  return violations;
}

/**
 * A growth route whose terminal handler this rule cannot read.
 *
 * {@link principalViolations} covers every module in the growth tree, so a
 * handler written anywhere in that tree is checked wherever it sits. This arm is
 * what keeps that true of a handler written OUTSIDE it: an identifier declared in
 * another file names a body no syntactic rule can follow, so the registration is
 * reported rather than passed.
 */
function routeHandlerViolations(sourceFile: SourceFile): ArchViolation[] {
  const file = relativePath(sourceFile);
  const violations: ArchViolation[] = [];
  for (const registration of routeRegistrations(sourceFile)) {
    if (handlerNode(registration) !== undefined) continue;
    violations.push({
      file,
      line: registration.call.getStartLineNumber(),
      message: UNRESOLVED_HANDLER_MESSAGE,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Growth reaches no session resolver and no session middleware.
// ---------------------------------------------------------------------------

function resolverMessage(symbol: string): string {
  return (
    `naming '${symbol}' inside the growth slice reaches a principal, and the anonymous ` +
    'half has none to reach: what it counts under lives in Redis and in no table. ' +
    'Growth tests are in scope too — a seam that holds only in production code is one ' +
    'edit from holding nowhere.'
  );
}

const SESSION_MIDDLEWARE_MESSAGE =
  "the growth slice reaches 'pipeline-session': the beacon is the one public write path " +
  'of the anonymous half, and a resolved session is exactly what would make its counts ' +
  'attributable.';

const OPAQUE_SPECIFIER_MESSAGE =
  'a module specifier inside the growth slice is not written out, so this rule cannot ' +
  'see which module it reaches. Write the specifier, or the seam holds only as far as ' +
  'the resolver happens to see.';

/** Growth naming a principal resolver, each distinct symbol reported once. */
function resolverNameViolations(sourceFile: SourceFile, file: string): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const resolver of PRINCIPAL_RESOLVERS) {
    const named = namingNodes(sourceFile, resolver)[0];
    if (named === undefined) continue;
    violations.push({
      file,
      line: named.getStartLineNumber(),
      message: resolverMessage(resolver),
    });
  }
  return violations;
}

/** Growth reaching the session middleware, or a specifier that names nothing. */
function sessionModuleViolations(sourceFile: SourceFile, file: string): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const { specifier, line } of moduleReferences(sourceFile.compilerNode)) {
    if (specifier === undefined) {
      violations.push({ file, line, message: OPAQUE_SPECIFIER_MESSAGE });
    } else if (SESSION_MIDDLEWARE.test(specifier)) {
      violations.push({ file, line, message: SESSION_MIDDLEWARE_MESSAGE });
    }
  }
  return violations;
}

/**
 * Growth naming a principal resolver or reaching the session middleware.
 *
 * The resolvers are read through {@link namingNodes} rather than through import
 * clauses, so a namespace member (`context.derivePrincipal`), a keyed access in
 * either written spelling (`context['derivePrincipal']`, and the backtick form)
 * and a rename all read the same as a named import. The middleware is matched on the module specifier by basename, and a
 * specifier the source does not write out is reported rather than passed over,
 * since past that point no syntax says which module it loads.
 *
 * All three resolvers are named exports, so no default import can reach one
 * under a name of its own; if one ever gains a default export, this check reads
 * the specifier and not the binding, and would need the module matched the way
 * the middleware is.
 */
function sessionReachViolations(sourceFile: SourceFile, file: string): ArchViolation[] {
  return [
    ...resolverNameViolations(sourceFile, file),
    ...sessionModuleViolations(sourceFile, file),
  ];
}

// ---------------------------------------------------------------------------
// The visitor hash reaches neither identity nor a growth door.
// ---------------------------------------------------------------------------

const HASH_IN_IDENTITY_MESSAGE =
  `naming '${VISITOR_HASH}' inside the identity slice is the join this design promises ` +
  'does not exist: the hash identifies a marketing visitor, identity identifies an ' +
  "account, and the campaign tag is the only thing that crosses between them. Growth's " +
  'published door is what identity reaches through, for counters that carry no hash.';

const HASH_ON_A_DOOR_MESSAGE =
  `'${VISITOR_HASH}' is published from a growth door, which is what would let a module ` +
  'that resolves a principal reach the anonymous half. Naming it on a door is publishing ' +
  'it: a door is the surface another slice reaches, and a name there is one edit from an ' +
  'export under any spelling. It stays inside the slice, exported from nothing.';

const WHOLE_MODULE_ON_A_DOOR_MESSAGE =
  'a growth door reaches a whole module rather than named symbols, so this rule cannot ' +
  `see whether '${VISITOR_HASH}' is among what travels with it — and past this line the ` +
  'surface is publishable under any spelling, none of which need name the hash. Name ' +
  'what the door reaches, and name what it publishes.';

/**
 * A tree that must not name the hash, reported at its first mention. One walk
 * serves the identity slice and the growth doors because they forbid the same
 * word for the same reason, and two copies of the question could answer it
 * differently — which is how the door arm came to read a list of declaration
 * shapes while this one read the name.
 *
 * On a door that is wider than publication on purpose: a door naming the hash
 * at all is reported, whether it re-exports it, declares it, binds it to
 * another name, or merely imports it for its own use. Publication has no closed
 * set of shapes, so the narrower question cannot be asked without becoming the
 * shape list again — and a door has no legitimate reason to name the hash,
 * which the shipped doors confirm. What this does NOT reach is a name it never
 * sees: the file-header blind spot on a value re-exported out of another module.
 */
function hashMentionViolations(
  sourceFile: SourceFile,
  file: string,
  message: string
): ArchViolation[] {
  const named = namingNodes(sourceFile, VISITOR_HASH)[0];
  if (named === undefined) return [];
  return [{ file, line: named.getStartLineNumber(), message }];
}

/**
 * Every construct that brings a WHOLE MODULE into this file as one value. A
 * module's surface is the set of names IT exports, written there and not here,
 * so anything carrying that surface is opaque to a walk over this file, and
 * `visitorHash` may be among what it carries.
 *
 * These four are the module system's own, which is what makes the set closed
 * where a list of publication shapes was not: a namespace import binding, a
 * star re-export in either spelling, a dynamic `import(…)`, and TypeScript's
 * import assignment. What a door then DOES with one is unbounded — bind it,
 * rename it, default-export it, spread it into an object, hand it to a call —
 * so the ENTRY is what is reported, and every publication shape falls out of
 * that instead of being listed.
 *
 * A CommonJS `require(…)` is not among them: it is an ordinary call rather than
 * module syntax, and nothing here reads it. It is also not a reach that could
 * ship — the app this rule stands over compiles against the Workers runtime,
 * where `require` is not declared at all.
 *
 * A type-only namespace import is reported with the rest rather than excused.
 * It publishes no value, so it is not a reach; but a door that needs a
 * module's types names them, and an exception is a narrowing bought for code
 * that does not exist.
 */
function wholeModuleNodes(sourceFile: SourceFile): Node[] {
  return [
    ...sourceFile.getExportDeclarations().filter((declaration) => declaration.isNamespaceExport()),
    ...sourceFile
      .getImportDeclarations()
      .filter((declaration) => declaration.getNamespaceImport() !== undefined),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration),
    ...sourceFile
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((call) => call.getExpression().getKind() === SyntaxKind.ImportKeyword),
  ];
}

/**
 * A growth door reaching a whole module, reported where the module enters.
 * That line is the last thing this file writes about what is reached; past it
 * the surface travels under names declared somewhere else.
 */
function wholeModuleViolations(sourceFile: SourceFile, file: string): ArchViolation[] {
  return wholeModuleNodes(sourceFile).map((node) => ({
    file,
    line: node.getStartLineNumber(),
    message: WHOLE_MODULE_ON_A_DOOR_MESSAGE,
  }));
}

// ---------------------------------------------------------------------------
// No growth-owned relation declares a path into another slice's rows.
// ---------------------------------------------------------------------------

/**
 * Why the ban runs one way. Stated in the violation itself, because the
 * asymmetry is mechanical and reads as an oversight without it — which is the
 * same failure as leaving the seam to a comment, one level up.
 */
const DIRECTION_REASON =
  'This ban is one-directional on purpose: an identity-owned table naming a growth ' +
  'target is legitimate and shipped, because in the relations API the owning side is ' +
  'self-sufficient while its counterpart is an independent optional declaration. The ' +
  'growth-to-account traversal exists only if that counterpart is declared, so ' +
  'forbidding the counterpart forbids exactly that traversal and nothing else.';

const UNRESOLVED_SUBJECT_MESSAGE =
  'this relations declaration names a subject table this rule cannot resolve to an ' +
  'owner, so it cannot tell whether the growth seam applies. Name the table directly.';

const UNRESOLVED_BUILDERS_MESSAGE =
  'this growth-owned relations declaration takes its builders in a shape this rule ' +
  'cannot resolve, so it cannot see which tables the relations target. Destructure the ' +
  'builders in the callback parameter.';

const UNRESOLVED_TARGET_MESSAGE =
  'this growth-owned relation names a target this rule cannot resolve to an owner. A ' +
  'seam whose coverage depends on how far the resolver reaches is not a seam. Name the ' +
  'table directly.';

const ESCAPED_BUILDER_MESSAGE =
  'a relation builder escapes this callback — bound to another name, handed to another ' +
  'function, or reached through a member — so this rule cannot see which table the ' +
  'relation it builds points at, and the growth seam holds only as far as the walk ' +
  'reaches. Call the builder on the table it relates, in the callback that binds it.';

/** A table resolved to its name and its owning slices. */
interface OwnedTable {
  readonly name: string;
  readonly owners: readonly string[];
}

/** The body of a relations callback, with the names its parameter binds to builders. */
interface RelationCallback {
  readonly body: Node;
  readonly builders: ReadonlySet<string>;
}

function seamMessage(subject: string, target: OwnedTable): string {
  return (
    `the growth-owned table '${subject}' declares a relation to '${target.name}', owned ` +
    `by '${target.owners.join("' or '")}' — growth-owned schema declares no path into ` +
    `another slice's rows. ${DIRECTION_REASON}`
  );
}

/** The table an argument names, read through any rename the file applied. */
function tableNamed(
  node: Node | undefined,
  aliases: ReadonlyMap<string, string>
): OwnedTable | undefined {
  if (node === undefined || !Node.isIdentifier(node)) return undefined;
  const name = importedName(node.getText(), aliases);
  const owner = TABLE_OWNER[name];
  return owner === undefined ? undefined : { name, owners: ownersOf(owner) };
}

/**
 * The body of the declaration's callback and the local names its parameter binds
 * to builders, or `undefined` when the second argument is written in a shape
 * this rule cannot read — a parameter that is not an object binding pattern, or
 * one whose elements bind patterns of their own, since a nested binding names
 * no builder this walk can then follow. The body rather than the whole
 * function, so the parameter's own binding is not read as a use of the builder
 * it introduces. A callback taking no parameter binds no builder and so
 * declares no relation, which is a resolved answer rather than an unreadable
 * one.
 */
function relationCallback(argument: Node | undefined): RelationCallback | undefined {
  if (argument === undefined) return undefined;
  if (!Node.isArrowFunction(argument) && !Node.isFunctionExpression(argument)) return undefined;
  const parameter = argument.getParameters()[0];
  if (parameter === undefined) return { body: argument.getBody(), builders: new Set<string>() };
  const binding = parameter.getNameNode();
  if (!Node.isObjectBindingPattern(binding)) return undefined;
  const elements = binding.getElements();
  if (elements.some((element) => !Node.isIdentifier(element.getNameNode()))) return undefined;
  const builders = new Set(elements.map((element) => element.getName()));
  return { body: argument.getBody(), builders };
}

/**
 * Whether an occurrence of a builder's name reads the builder. The name half of
 * a member access or of a property assignment names a property of something
 * else, so `cardinalities.many` and the key of `{ many: … }` are occurrences of
 * the word rather than reads of the binding.
 */
function isBuilderReference(use: Identifier): boolean {
  const parent = use.getParent();
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() !== use;
  if (Node.isPropertyAssignment(parent)) return parent.getNameNode() !== use;
  return true;
}

/**
 * Where each relation the callback builds points — and what it does with the
 * builders it does not call.
 *
 * The walk is over every read of a builder's name rather than over calls,
 * because a builder is a value: bound to another name, handed to a helper, or
 * invoked through a member, it still declares a relation, and a walk that
 * recognised only `many(table)` passed those over in silence. A read that is not
 * the callee of its own call is reported for that reason.
 */
function relationUsageViolations(
  callback: RelationCallback,
  subject: string,
  aliases: ReadonlyMap<string, string>,
  file: string
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const use of callback.body.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (!callback.builders.has(use.getText()) || !isBuilderReference(use)) continue;
    const line = use.getStartLineNumber();
    const call = use.getParent();
    if (!Node.isCallExpression(call) || call.getExpression() !== use) {
      violations.push({ file, line, message: ESCAPED_BUILDER_MESSAGE });
      continue;
    }
    const target = tableNamed(call.getArguments()[0], aliases);
    if (target === undefined) {
      violations.push({ file, line, message: UNRESOLVED_TARGET_MESSAGE });
    } else if (!target.owners.includes(GROWTH_SLICE)) {
      violations.push({ file, line, message: seamMessage(subject, target) });
    }
  }
  return violations;
}

/**
 * How a call spells the relations factory, or `undefined` for a call that is not
 * one. `named` is the factory as an identifier, resolved through the file's
 * renames so that `import { relations as defineRelations }` is the same factory
 * rather than a call this walk never sees. `member` is a call to a member of
 * that name — written with a dot (`orm.relations(…)`) or with a key
 * (`orm['relations'](…)`, and the backtick form) — which reads identically but
 * which no syntax distinguishes from an unrelated method sharing the name.
 */
type FactorySpelling = 'named' | 'member';

function relationsSpelling(
  call: CallExpression,
  aliases: ReadonlyMap<string, string>
): FactorySpelling | undefined {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) {
    return importedName(callee.getText(), aliases) === RELATIONS_FACTORY ? 'named' : undefined;
  }
  if (Node.isPropertyAccessExpression(callee)) {
    return callee.getName() === RELATIONS_FACTORY ? 'member' : undefined;
  }
  if (!Node.isElementAccessExpression(callee)) return undefined;
  return writtenStrings(callee, RELATIONS_FACTORY).length > 0 ? 'member' : undefined;
}

/**
 * One `relations(…)` declaration. The subject set comes from
 * {@link TABLE_OWNER}, so `campaigns` — growth-owned, growth-prefix-free, and
 * the declaration this check exists for — is a subject.
 *
 * What the walk reads is a builder call whose target is a bare table name; every
 * other shape a builder appears in is reported rather than passed over — an
 * unresolvable subject, a parameter that does not destructure its builders, a
 * target that is not a bare name, and a builder read anywhere but as the callee
 * of its own call. Two occurrences are deliberately left unreported: the word in
 * a property-name position ({@link isBuilderReference}), which names a property
 * rather than the builder; and, OUTSIDE the schema's own source, an
 * unresolvable subject under the `member` spelling, because reporting one there
 * would fire on every `<anything>.relations(x)` call in the repository, whose
 * subject is ordinarily not a table at all. Inside that source the same call is
 * a schema declaration, so it is reported there — a namespace-qualified factory
 * over a namespace-qualified subject would otherwise remove this check from the
 * one file it was written for.
 */
function relationDeclarationViolations(
  call: CallExpression,
  spelling: FactorySpelling,
  aliases: ReadonlyMap<string, string>,
  file: string
): ArchViolation[] {
  const line = call.getStartLineNumber();
  const [subjectNode, builderNode] = call.getArguments();
  const subject = tableNamed(subjectNode, aliases);
  if (subject === undefined) {
    return spelling === 'named' || declaresTables(file)
      ? [{ file, line, message: UNRESOLVED_SUBJECT_MESSAGE }]
      : [];
  }
  if (!subject.owners.includes(GROWTH_SLICE)) return [];
  const callback = relationCallback(builderNode);
  if (callback === undefined) return [{ file, line, message: UNRESOLVED_BUILDERS_MESSAGE }];
  return relationUsageViolations(callback, subject.name, aliases, file);
}

function relationViolations(sourceFile: SourceFile): ArchViolation[] {
  const file = relativePath(sourceFile);
  const aliases = importAliases(sourceFile);
  const violations: ArchViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const spelling = relationsSpelling(call, aliases);
    if (spelling === undefined) continue;
    violations.push(...relationDeclarationViolations(call, spelling, aliases, file));
  }
  return violations;
}

// ---------------------------------------------------------------------------

/** The checks that watch the growth slice's own tree. */
function growthModuleViolations(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const doors = isPublishedDoor(filePath)
    ? [
        ...wholeModuleViolations(sourceFile, filePath),
        ...hashMentionViolations(sourceFile, filePath, HASH_ON_A_DOOR_MESSAGE),
      ]
    : [];
  return [
    ...principalViolations(sourceFile, filePath),
    ...sessionReachViolations(sourceFile, filePath),
    ...computedNameViolations(sourceFile, filePath),
    ...doors,
  ];
}

function fileViolations(sourceFile: SourceFile, growth: ReadonlySet<string>): ArchViolation[] {
  const filePath = relativePath(sourceFile);
  return [
    ...accountColumnViolations(sourceFile, growth),
    ...relationViolations(sourceFile),
    ...(isSliceSource(filePath, GROWTH_SLICE) ? routeHandlerViolations(sourceFile) : []),
    ...(isInSliceTree(filePath, GROWTH_SLICE) ? growthModuleViolations(sourceFile, filePath) : []),
    ...(isInSliceTree(filePath, IDENTITY_SLICE)
      ? [
          ...hashMentionViolations(sourceFile, filePath, HASH_IN_IDENTITY_MESSAGE),
          ...computedNameViolations(sourceFile, filePath),
        ]
      : []),
  ];
}

const rule: ArchRule = {
  name: 'growth-seam',
  check(project: Project): ArchViolation[] {
    const growth = growthTables();
    return project.getSourceFiles().flatMap((sourceFile) => fileViolations(sourceFile, growth));
  },
};

export default rule;
