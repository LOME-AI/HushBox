import { ts } from 'ts-morph';

/**
 * Every form that LINKS one module into another, plus the one form that links
 * without naming anything: a module loader that has escaped into a value —
 * through an expression ({@link isRequireValue}) or through a name the source
 * writes ({@link readsRequire}) — reported with no specifier because past that
 * point no syntax says which module it loads.
 *
 * Rules used to carry a walk of their own, and each was found blind to a form a
 * sibling already read — a computed dynamic specifier, a type-position
 * `import(…)`, a type-only import assignment, a backtick-quoted specifier taken
 * for computed. They were never careless walks; they were one mechanism written
 * once per rule, which is the shape CODE-RULES §One Implementation, Shared
 * forbids. The value of one walk is that a form learned once is known
 * everywhere, so this module owns the FORMS and nothing else.
 *
 * What it deliberately does NOT own, because it differs per rule and flattening
 * it would trade one narrow rule per adopter for a single rule wrong in each of
 * their ways:
 *
 * - RESOLUTION. An adopter asks the checker, walks an exports map by hand, or
 *   never resolves at all. The literal node travels with each reference so a
 *   caller can resolve it whichever way it must.
 * - WHAT TO DO ABOUT A SPECIFIER THAT IS NOT WRITTEN OUT. The dispositions are
 *   to throw (where the verdict is a reachability closure, so one dropped edge
 *   silently drops the whole subtree behind it and reads as a clean pass), to
 *   report it as an ordinary violation, or to pass over it, having argued that
 *   a computed specifier cannot reach that subject. Every disposition needs the
 *   same thing from the walk: to be TOLD. So such a form is enumerated with
 *   `specifier: undefined` rather than skipped — a caller may pass over it, but
 *   never without seeing it.
 * - SCOPE and MESSAGE TEXT, which are the rule's own subject.
 *
 * A form that names a module without LINKING one is no reference here — linking
 * being the module system binding the named module into this one, in the type
 * graph or at runtime, which resolving the name is not: a linking form's
 * resolve-only spelling (`import.meta.resolve`, `require.resolve`, and the
 * `createRequire(…).resolve` that is `require.resolve` under ESM — each hands
 * back a resolved name and loads nothing), `new URL(…, import.meta.url)`, a
 * `declare module` augmentation (resolved, and it merges this file's
 * declarations into its target rather than binding the target here), a
 * triple-slash reference (resolved, and it adds a file to the program, binding
 * nothing into the module that names it). What a BUNDLER does with the name is
 * deliberately not the test, and would answer wrongly here: Vite bundles a
 * worker referenced via `new URL(…, import.meta.url)` as a chunk of its own
 * (`packages/ui/src/components/accessibility/lib/tts-engine.ts`), yet nothing
 * links that chunk to the module naming it — it loads as a fresh root off a URL
 * string. So a caller asking which modules reach another gets the right answer
 * from this walk, while a caller asking what bytes a dist SHIPS has to guard
 * emitted assets by some other means.
 */

/** The syntactic form a reference is written in. */
export type ModuleReferenceForm =
  | 'import-declaration'
  | 'export-declaration'
  | 'import-equals'
  | 'import-type'
  | 'dynamic-import'
  | 'require'
  | 'require-escape'
  | 'jsdoc-import';

export interface ModuleReference {
  readonly form: ModuleReferenceForm;
  /**
   * The module named, or `undefined` when the specifier is not written out — as
   * a `require-escape`, which names no module at all, never is.
   */
  readonly specifier: string | undefined;
  /** The node carrying the specifier, for a caller that resolves it. */
  readonly literal: ts.StringLiteralLike | undefined;
  /** True when the form binds types alone, so `@types` or erasure covers it. */
  readonly typeOnly: boolean;
  /** The single name the form takes off the module, when it takes one. */
  readonly member: string | undefined;
  /** The form as written, for a caller that renders or resolves against it. */
  readonly node: ts.Node;
  /** One-based line the form starts on. */
  readonly line: number;
}

/** What one node contributes, before the walk adds the node's own position. */
type Contribution = Omit<ModuleReference, 'node' | 'line'>;

/**
 * Where a substitution-free template is the specifier and where it is not.
 *
 * A bundler reads `` import(`m`) `` exactly as `import('m')`, so quoting style is
 * not the question — whether the specifier IS a string-literal node is, and
 * fixed text does not make one: `require('m' as const)`, `require((0, 'm'))`
 * and `require('a' + 'b')` all fix their text at compile time and are each
 * reported with no specifier. A template counts as one in the CALL position
 * alone. Asked as a declaration it counts nowhere, and in no declaration does
 * the token reach the module it spells: where the grammar admits a string
 * literal alone it is TS1141 "String literal expected", and where it parses,
 * nothing resolves through it.
 */
function writtenIn(
  position: 'call' | 'declaration',
  node: ts.Node
): ts.StringLiteralLike | undefined {
  if (position === 'call') return ts.isStringLiteralLike(node) ? node : undefined;
  return ts.isStringLiteral(node) ? node : undefined;
}

/** The leftmost identifier of `A.B.C` — where a qualified name starts. */
function leftmostIdentifier(name: ts.EntityName): ts.Identifier {
  return ts.isIdentifier(name) ? name : leftmostIdentifier(name.left);
}

function contribution(
  form: ModuleReferenceForm,
  literal: ts.StringLiteralLike | undefined,
  typeOnly: boolean,
  member?: string
): Contribution {
  return { form, specifier: literal?.text, literal, typeOnly, member };
}

function fromImportDeclaration(node: ts.ImportDeclaration): Contribution {
  return contribution(
    'import-declaration',
    writtenIn('declaration', node.moduleSpecifier),
    node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
  );
}

function fromExportDeclaration(node: ts.ExportDeclaration): Contribution | undefined {
  const moduleSpecifier = node.moduleSpecifier;
  if (moduleSpecifier === undefined) return undefined;
  return contribution(
    'export-declaration',
    writtenIn('declaration', moduleSpecifier),
    node.isTypeOnly
  );
}

function fromImportEquals(node: ts.ImportEqualsDeclaration): Contribution | undefined {
  const reference = node.moduleReference;
  if (!ts.isExternalModuleReference(reference)) return undefined;
  return contribution(
    'import-equals',
    writtenIn('declaration', reference.expression),
    node.isTypeOnly
  );
}

/**
 * A JSDoc `@import` tag, which is no `ImportDeclaration` and so reaches none of
 * the arms above. It is always type-only: the tag exists so a JavaScript file
 * can name a type without emitting an import, and TypeScript parses its clause
 * with `isTypeOnly` set whatever the source writes.
 */
function fromCommentImportTag(node: ts.JSDocImportTag): Contribution {
  return contribution('jsdoc-import', writtenIn('declaration', node.moduleSpecifier), true);
}

/** An `import('…')` type node: always type-only, and able to qualify one name. */
function fromImportType(node: ts.ImportTypeNode): Contribution {
  const argument = node.argument;
  const literal = ts.isLiteralTypeNode(argument)
    ? writtenIn('declaration', argument.literal)
    : undefined;
  return contribution(
    'import-type',
    literal,
    true,
    node.qualifier === undefined ? undefined : leftmostIdentifier(node.qualifier).text
  );
}

/**
 * The callee with every node that hands its operand straight back stripped
 * off: parentheses, the operators that erase at emit (`as`, `satisfies`, an
 * angle-bracket assertion, `!`), and a comma sequence, whose value is its
 * last operand. Each spells the same value, so `(0, require)` and `require!`
 * call exactly what `require` calls.
 */
function calleeValue(node: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return calleeValue(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return calleeValue(node.right);
  }
  return node;
}

/** The member an access names, whichever of the two ways the source writes it. */
function memberOf(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : undefined;
}

/**
 * The two words this walk reads as naming a module loader: `require`, which
 * loads a module, and `createRequire`, which MINTS a `require`. Both are read
 * in the same positions and refused on the same terms, because a reach that
 * renames the minter is the same reach one step earlier as one that renames the
 * loader: reading only the second leaves every route the first closes open
 * again a word out.
 *
 * The one place they part is a CALL, and the invocation arms below are where
 * that is asked: `require('m')` links `m`, while `createRequire('m')` links no
 * module at all and hands back a loader rooted there. Everything that asks only
 * whether the source wrote a loader down goes through {@link namesLoader}.
 */
const REQUIRE_NAME = 'require';
const MINT_NAME = 'createRequire';
const LOADER_NAMES: ReadonlySet<string> = new Set([REQUIRE_NAME, MINT_NAME]);

/** Whether a name the source writes is one of the two the walk reads as a loader. */
function namesLoader(name: string | undefined): boolean {
  return name !== undefined && LOADER_NAMES.has(name);
}

/**
 * The name an expression READS a value out of, in either spelling one is read
 * by: an identifier, or the member an access takes off something else. An
 * expression naming no value this way — a call, a literal, an operator — reads
 * no name.
 */
function nameRead(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return memberOf(node);
  }
  return undefined;
}

/**
 * How a module with no `require` in scope mints one: a call of the minter under
 * any callee wrapper, whether the source writes the name outright or takes it
 * off the namespace the module system was imported as.
 */
function isCreateRequireCall(node: ts.Node): boolean {
  return ts.isCallExpression(node) && nameRead(calleeValue(node.expression)) === MINT_NAME;
}

/**
 * Whether the source writes the callee AS the require function: the `require`
 * identifier, or a `createRequire(…)` call, each callee first read through the
 * nodes that hand their operand straight back ({@link calleeValue}).
 *
 * A callee that only becomes require once something is EVALUATED is outside
 * this test — a binding (`const req = require`), a member taken off another
 * object (`module.require`, `require.main.require`), an invocation through
 * `call`/`apply`, an element read out of a container, a value an operator
 * chooses. Every one of them links at runtime, and every one asks something
 * this walk does not answer: what a name is bound to, what an object holds,
 * what an expression comes out as. So the walk answers the question it can —
 * that the function escaped ({@link isRequireValue}) — rather than passing the
 * reach over.
 */
function isRequireFunction(node: ts.Expression): boolean {
  const value = calleeValue(node);
  return ts.isIdentifier(value) ? value.text === REQUIRE_NAME : isCreateRequireCall(value);
}

/**
 * A module loader that has ESCAPED INTO A VALUE, which is the point past which
 * no syntax says which module it goes on to load: either loader word
 * ({@link LOADER_NAMES}) read as a value or taken off another object as a
 * member, or a `createRequire(…)` result. `import` cannot escape, being a
 * keyword rather than a value.
 *
 * What is reportable is the escape; the module is not, and chasing it is the
 * fix that must not be made. By NAME, a list is blind to the next alias and to
 * shadowing. By BINDING, it cannot complete — an element read and an
 * operator-chosen callee are not statically resolvable, so the unread state
 * would reappear one alias deeper and undocumented — and where it does
 * complete it is measured to give a true reference on a false account of the
 * code: the realm-crossing requires under `scripts/lib/` bind a `createRequire`
 * result precisely so a transitive dependency resolves through another
 * package's realm, so an edge on each would arrive at
 * `imports-declared-in-manifest` as an import of a package that workspace's
 * manifest declares nowhere.
 *
 * So the escape is enumerated with no specifier, like every other form whose
 * module is not written out, and the disposition is the caller's.
 *
 * The residue follows from the reading rather than being a list beside it: this
 * matches a fixed set of words in a fixed set of positions, so it draws a
 * reference on anything of one's own that happens to write one of those words
 * in one of those positions — an object carrying a `require` member, say —
 * and it reads nothing at all where a reach lands outside that pairing, whether
 * because the word goes unwritten (a key computed at runtime) or because it is
 * written where this does not look (a name handed to a reflective read). The
 * first half is loud and fail-closed, and is the price of seeing
 * `module.require` at all; the second is silent, and is stated where a reader
 * acts on it — the browser-safety rule's own refusal for a declared door with
 * no read edge
 * (`packages/config/arch/rules/published-doors-stay-browser-safe.rule.ts`).
 */
function isRequireValue(node: ts.Node): boolean {
  return namesLoader(nameRead(node)) || isCreateRequireCall(node);
}

/**
 * Records the names a node WRITES, each naming something rather than reading a
 * value: the binding a declaration introduces, the member an access spells out,
 * and — on the node kinds carrying both slots — the pair, since a written name
 * left over would then be read as a value. An import or export specifier's
 * `propertyName` names something in another module rather than reading a value
 * here, so it is written here too.
 *
 * A slot can be a property READ and a written name at once — the key a
 * destructuring opens, an import clause included. Recording it is still right:
 * {@link readsRequire} reports the read on the node that writes it, so the
 * reach is enumerated once rather than twice.
 */
function consumeWrittenNames(node: ts.Node, consumed: Set<ts.Node>): void {
  const { name, propertyName } = node as ts.Node & {
    readonly name?: ts.Node;
    readonly propertyName?: ts.Node;
  };
  if (name !== undefined) consumed.add(name);
  if (propertyName !== undefined) consumed.add(propertyName);
}

/**
 * Records the loader value one node reads in a position that already says what
 * it links, or writes where it reads no value at all: the callee of an
 * invocation {@link isRequireFunction} accepts, the callee of a mint call —
 * which the call itself is reported for, so recording it here is what keeps one
 * escape from being enumerated twice — the object of a `.resolve` that hands
 * back a name and loads nothing, the operand of a `typeof`, and the names of
 * whatever declares or accesses it ({@link consumeWrittenNames}). Each is
 * taken through {@link calleeValue}, so the wrappers that hand their operand
 * straight back travel with it and `(0, require)('m')` consumes the same node
 * `require('m')` does.
 *
 * The walk visits a node before its descendants, so a consumer is always
 * recorded before the value it consumes is asked about. It writes into the set
 * rather than answering with one: this runs on every node of every scanned
 * file, and a walk that allocates per node is the cost this one exists to
 * avoid.
 */
function consume(node: ts.Node, consumed: Set<ts.Node>): void {
  if (
    (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
    (isRequireFunction(node.expression) || isCreateRequireCall(node))
  ) {
    consumed.add(calleeValue(node.expression));
    return;
  }
  if (
    (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    memberOf(node) === 'resolve'
  ) {
    consumed.add(calleeValue(node.expression));
    return;
  }
  if (ts.isTypeQueryNode(node)) {
    consumed.add(leftmostIdentifier(node.exprName));
    return;
  }
  consumeWrittenNames(node, consumed);
}

/**
 * The name a property key writes, in each spelling that fixes it at compile
 * time: an identifier, a quoted key, and a computed key holding a string —
 * `['require']` being to a key what `globalThis['require']` is to a member
 * access. A key computed from anything else names whatever it evaluates to,
 * which no syntactic walk reads.
 */
function keyOf(name: ts.Node): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return undefined;
}

/** The nodes a nested assignment target is written inside. */
const ENCLOSING_TARGETS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.PropertyAssignment,
  ts.SyntaxKind.SpreadAssignment,
  ts.SyntaxKind.SpreadElement,
  ts.SyntaxKind.ObjectLiteralExpression,
  ts.SyntaxKind.ArrayLiteralExpression,
]);

/**
 * Whether an object literal is being DESTRUCTURED rather than built — the one
 * position where its keys are property READS off the value assigned into it.
 * TypeScript parses the two into the same node, so the tell is position alone:
 * the left of an `=`, or the variable of a `for…of`/`for…in`, reached through
 * the literals a nested target is written inside.
 */
function destructures(literal: ts.Node): boolean {
  let target = literal;
  let parent = target.parent;
  while (ENCLOSING_TARGETS.has(parent.kind)) {
    target = parent;
    parent = target.parent;
  }
  if (ts.isBinaryExpression(parent)) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === target;
  }
  return (
    (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === target
  );
}

/** Whether an import specifier binds a type alone, in either spelling of it. */
function importsTypeOnly(node: ts.ImportSpecifier): boolean {
  return node.isTypeOnly || node.parent.parent.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

/** Whether an export specifier binds a type alone, in either spelling of it. */
function exportsTypeOnly(node: ts.ExportSpecifier): boolean {
  return node.isTypeOnly || node.parent.parent.isTypeOnly;
}

/**
 * Whether a specifier names a module loader ({@link LOADER_NAMES}) in the module
 * it reads that name out of: an import clause destructuring another module's
 * namespace, or an export handing a name on — a local of this module's, or, in
 * a re-export, one taken straight out of the module named there and bound
 * nowhere here.
 *
 * The `as` is required on the import side and not on the export side, which
 * looks asymmetric and is not. An import written without one binds the function
 * under the word it was read by, so every later use of it is one this walk
 * still reads. An export written without one hands the local to importers that
 * rename it at will, and no later use of it is this module's to read.
 *
 * A specifier binding a type alone binds no value to read or to hand on, so it
 * names nothing here.
 */
function specifierReadsRequire(node: ts.ImportSpecifier | ts.ExportSpecifier): boolean {
  if (ts.isImportSpecifier(node)) {
    return !importsTypeOnly(node) && namesLoader(node.propertyName?.text);
  }
  return !exportsTypeOnly(node) && namesLoader((node.propertyName ?? node.name).text);
}

/**
 * A module loader read through a name the source WRITES rather than through an
 * expression, which is the other half of {@link isRequireValue}: the
 * property a destructuring takes off the value it opens, the shorthand that is
 * a key and a read at once, and the name a specifier reads out of another
 * module ({@link specifierReadsRequire}). Every one of them occupies a slot
 * {@link consumeWrittenNames} records, so it is reported here — on the node
 * that writes it — or it is reported nowhere.
 *
 * A shorthand under destructuring reads as no escape, for the reason an import
 * written with no `as` does: it binds what it reads under the same word, so
 * every later use of it is one this walk still reads — an ordinary require with
 * its specifier, or a mint call it reports for itself — and refusing there
 * would trade an answer for a refusal. The mirror of that is the key of a BUILT
 * literal, which names no value at all.
 *
 * The reading is by NAME throughout, so a module of one's own importing or
 * exporting an unrelated binding called by either loader word draws a reference
 * — loud, fail-closed, and the same price {@link isRequireValue} pays for
 * reading `module.require`.
 */
function readsRequire(node: ts.Node): boolean {
  if (ts.isBindingElement(node)) {
    return node.propertyName !== undefined && namesLoader(keyOf(node.propertyName));
  }
  if (ts.isPropertyAssignment(node)) {
    return namesLoader(keyOf(node.name)) && destructures(node.parent);
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    return namesLoader(node.name.text) && !destructures(node.parent);
  }
  if (ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) {
    return specifierReadsRequire(node);
  }
  return false;
}

/**
 * The invocation forms this walk reads as linking a module: `import(…)`,
 * including the phase-modified spellings `"module": "ESNext"` accepts
 * (`import.defer` today, whichever meta-property keyword a later compiler
 * adds), and an invocation of the require function under any callee
 * {@link isRequireFunction} accepts — called or constructed alike, `new
 * require('m')` loading and evaluating the named module exactly as
 * `require('m')` does, whatever `new` then hands back.
 *
 * The `import(…)` arm is asked of a call alone, the parser refusing `import`
 * after `new`: `new import('m')` is TS1109 "Expression expected", and the tree
 * it recovers from that carries an identifier where the callee belongs, never
 * the import keyword.
 *
 * A resolve-only spelling stays edgeless under every one of those callees,
 * `.resolve` being a member call rather than an invocation of the require
 * function.
 */
function fromInvocation(node: ts.CallExpression | ts.NewExpression): Contribution | undefined {
  const callee = node.expression;
  const isDynamicImport =
    ts.isCallExpression(node) &&
    (callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isMetaProperty(callee) && callee.keywordToken === ts.SyntaxKind.ImportKeyword));
  const isRequire = isRequireFunction(callee);
  if (!isDynamicImport && !isRequire) return undefined;
  const argument = node.arguments?.[0];
  return contribution(
    isDynamicImport ? 'dynamic-import' : 'require',
    argument === undefined ? undefined : writtenIn('call', argument),
    false
  );
}

/**
 * What an expression contributes: the invocation forms {@link fromInvocation}
 * reads as a link, or — where no invocation reads it — a require function that
 * got away into a value with no invocation naming what it loads.
 */
function fromExpression(node: ts.Node, consumed: ReadonlySet<ts.Node>): Contribution | undefined {
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const invocation = fromInvocation(node);
    if (invocation !== undefined) return invocation;
  }
  if (isRequireValue(node) && !consumed.has(node)) {
    return contribution('require-escape', undefined, false);
  }
  return undefined;
}

function contributionOf(node: ts.Node, consumed: ReadonlySet<ts.Node>): Contribution | undefined {
  if (ts.isImportDeclaration(node)) return fromImportDeclaration(node);
  if (ts.isExportDeclaration(node)) return fromExportDeclaration(node);
  if (ts.isImportEqualsDeclaration(node)) return fromImportEquals(node);
  if (ts.isImportTypeNode(node)) return fromImportType(node);
  if (ts.isJSDocImportTag(node)) return fromCommentImportTag(node);
  if (readsRequire(node)) return contribution('require-escape', undefined, false);
  return fromExpression(node, consumed);
}

/**
 * The JSDoc comments attached to one node, which its children do not include.
 *
 * Read off the `jsDoc` property, which the compiler's public declarations omit,
 * rather than through the public `ts.getJSDocTags`: that helper answers with the
 * tags a node INHERITS as well as the ones written on it, so a single `@type`
 * above a statement comes back three times over — from the statement, from the
 * declaration inside it, and from that declaration's name — and a walk built on
 * it enumerates one reference once per node that can claim the comment. The
 * property carries each comment exactly once, on the node it was written above.
 */
function commentsOf(node: ts.Node): readonly ts.JSDoc[] {
  return (node as ts.Node & { readonly jsDoc?: readonly ts.JSDoc[] }).jsDoc ?? [];
}

/**
 * Every module reference in one file, in source order.
 *
 * Walked over compiler nodes rather than ts-morph wrappers: wrapping every node
 * of a scanned tree to find these costs seconds where the raw walk costs
 * milliseconds. A ts-morph caller passes `sourceFile.compilerNode`.
 *
 * The tree has to carry parent pointers — ts-morph sets them, and a hand-built
 * `ts.createSourceFile` must pass `setParentNodes`. Position is part of what
 * this walk reads: whether an object literal is being destructured or built,
 * and whether a specifier's clause binds types alone, are answered by reading
 * upwards from the node. A tree without them throws where it would otherwise
 * have answered.
 *
 * A form written in a JSDoc comment is among them, `ts.forEachChild` never
 * descending into JSDoc, so the walk descends {@link commentsOf} itself — before
 * the node's own contribution, a comment standing ahead of what it documents.
 * The tags that bind are `@import { X } from 'm'` and an `import(…)` written
 * inside a `@type`, a `@param` or any other type position: in checked
 * JavaScript the target joins the program and a deliberate mistype through the
 * bound name is reported. `imports-declared-in-manifest` is the caller this
 * reaches, its scope being whole workspaces with `.js`, `.cjs`, `.mjs` and
 * `.jsx` among the extensions it parses; a caller reading the layer's shared
 * scope (`arch/lib/source-scope.ts`) is handed `.ts` and `.tsx` alone, where
 * such a tag binds nothing and its target joins no program.
 */
export function moduleReferences(file: ts.SourceFile): ModuleReference[] {
  const references: ModuleReference[] = [];
  const consumed = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    consume(node, consumed);
    for (const comment of commentsOf(node)) visit(comment);
    const found = contributionOf(node, consumed);
    if (found !== undefined) {
      references.push({
        ...found,
        node,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return references;
}
