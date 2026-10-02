import { Node, SyntaxKind } from 'ts-morph';
import { isRepoPath, isTestFile, relativePath } from '../lib/paths.js';
import type { CallExpression, Identifier, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The effort-availability channel has ONE writer and ONE call site, and both
 * halves are load-bearing rather than tidy.
 *
 * The publisher grades the effort ladder against the payer whose funding the
 * calling instance happens to hold, and several budget instances are live at
 * once against DIFFERENT payers — the regenerate gate scopes to the first
 * message's conversation, which on an empty list is no conversation at all, so
 * it grades a full verdict against another wallet and tier. Two publishers
 * therefore do not agree and do not converge: each write wakes the other, and
 * the render loop ends in React's update-depth abort. That was reached and
 * reproduced, not theorised.
 *
 * The fix that shipped is structural: the publisher is called from inside the
 * composer's own effort control, so a surface that renders no control cannot
 * publish. Structure is not enforcement, though — nothing stopped a second
 * caller being added, and the invariant was carried only by two doc comments.
 * This rule is the enforcement.
 *
 * TWO CLAUSES, because there are two ways to become a second writer. The first
 * counts CALLS of the publisher: exactly one, in the composer's effort control.
 * The second refuses the bypass the first cannot see — a surface that skips the
 * publisher and takes the store's setter itself, whether by naming it, by
 * destructuring it out, or by writing the field through `setState`. Either
 * shape is a second writer; only both clauses together say so.
 *
 * THE SECOND CLAUSE'S EXEMPTIONS ARE DECLARATIONS, NOT FILES, and the clause has
 * none of the second kind left. Sharing an owning module used to buy silence from
 * the writer clause, which let a second exported publisher declared beside the
 * first escape both clauses at once — the writer clause skipped its file, and the
 * call-site clause counts calls to a name it is given, so a publisher under a
 * second name goes uncounted however many surfaces call it. The channel is
 * declared in exactly two modules, and in each the exemption now covers only the
 * declaration: in the publisher's module the publisher's own body, and in the
 * store's module the `create(...)` initializer that implements the store plus the
 * type that spells its shape. Both are context questions asked identically of
 * every spelling, so neither splits a syntactic family across a fire and a pass.
 *
 * WHY NOT LINT. The invariant is a property of the repository — how many call
 * sites exist — which a per-file rule cannot count. It is also not textual, so
 * the duplication gate sees nothing: a second publisher shares no tokens with
 * the first.
 *
 * TEST FILES ARE OUT OF SCOPE, and that is a decision rather than an oversight.
 * The regression test that pins this defect renders TWO publisher instances on
 * purpose — that is how it fails when the second writer returns — so a rule
 * that judged tests would refuse the very test that proves the bug.
 *
 * WHY THE WRITER CLAUSE IS COMPLETE, and it is not because a list was long
 * enough. Two earlier versions enumerated the syntactic positions a setter can
 * be obtained in, argued completeness from the enumeration, and were each one
 * position short. The argument that replaces it is a closure over CAPABILITIES:
 * writing this channel needs the setter or zustand's `setState`, nothing else
 * writes it, and neither can be held by a file that does not spell its name. The
 * clause therefore matches those two names in every token position rather than
 * in a chosen set of node kinds, and the field's key wherever a key can be
 * spelled without a variable.
 *
 * That argument is checkable, and it was checked rather than asserted: every
 * reference the compiler resolves to the setter and to this store's `setState`,
 * over the arch layer's real scanned scope, lands in a file that owns the
 * channel, in an excluded test file, or on a line this rule reports. The sweep
 * was first shown able to detect an open reference — the earlier rule leaves the
 * assignment-destructuring shape unaccounted for on the same instrument — so its
 * silence is a result rather than a blind spot.
 *
 * WHAT THAT ARGUMENT STILL DOES NOT REACH, stated as the residual it is:
 * - A capability that arrives in a file already bound to a name of its own: the
 *   setter or the store handed over as an argument, stored in an object, or
 *   re-exported under a new name by a third module. A direct import alias IS
 *   followed; a value hop is not, by either the rule or the reference sweep.
 * - A member name that exists only at runtime — a key built from a variable, or
 *   reflection over the state object. The name is not in the source to match.
 * - A future write API added to the store under a third name — including a second
 *   action declared inside the store's own `create(...)` initializer, which is the
 *   one region of that module left exempt. The rule throws when the publisher's
 *   module or export moves, but a new store action is not self-announcing: it must
 *   be added to the capability set here.
 *
 * No WHOLE-FILE exemption remains: every exemption above is a region of a file,
 * asked of a token by where it sits. Test files are excluded, and that is the
 * separate decision recorded above rather than a residual.
 */

/** Where the publisher is declared, and the export that is it. */
const PUBLISHER_MODULE = 'apps/web/src/hooks/chat/use-reasoning-effort.ts';
const PUBLISHER_EXPORT = 'useEffortAvailabilityPublisher';

/** The composer's effort control — the one call site. */
const CALL_SITE = 'apps/web/src/components/chat/input/reasoning-effort-menu.tsx';

/** The store the channel lives in, and the two names a direct write spells. */
const STORE_MODULE = 'apps/web/src/stores/reasoning-effort.ts';
const STORE_EXPORT = 'useReasoningEffortStore';
const STORE_SETTER = 'setEnabledEffortChoices';
const STORE_FIELD = 'enabledEffortChoices';

/**
 * Zustand's generic write API. It is a capability, not a channel: it names no
 * field, so it counts only in a file that also has the effort store in hand.
 */
const STORE_WRITE_API = 'setState';

const REMEDY = `Read the graded set with useReasoningEffort() instead of publishing it; a surface that must lower effort routes through the composer's effort control at ${CALL_SITE}, which is the one call site`;

const SECOND_CALL_SITE = `A second call site for the effort-availability publisher. ${PUBLISHER_EXPORT} publishes ONE payer's grading of the effort ladder, and budget instances are live at once against different payers, so a second caller publishes a rival verdict and the two alternate until React aborts the render. ${REMEDY}.`;

const NO_CALL_SITE = `${PUBLISHER_EXPORT} is called from nowhere, so the graded set is never published and the whole ladder greys against a verdict that never arrives. Restore the single call in the composer's effort control at ${CALL_SITE}; if that control has moved, point this rule at its new home.`;

const SECOND_WRITER = `Writes the effort store's ${STORE_FIELD} outside ${PUBLISHER_MODULE}. The publisher is the channel's sole writer, and a second one publishes whichever payer this instance happens to be scoped to — a verdict about a different wallet and tier. Publish through ${PUBLISHER_EXPORT} from the composer's effort control at ${CALL_SITE}, and read the graded set with useReasoningEffort().`;

const SECOND_WRITER_IN_MODULE = `Writes the effort store's ${STORE_FIELD} inside ${PUBLISHER_MODULE} but outside ${PUBLISHER_EXPORT}, so it is a second publisher no clause can otherwise see: the call-site clause counts calls to ${PUBLISHER_EXPORT} and a publisher under a second name is uncounted however many surfaces call it. This module's exemption belongs to ${PUBLISHER_EXPORT}, not to the file. ${REMEDY}.`;

const SECOND_WRITER_IN_STORE = `Writes the effort store's ${STORE_FIELD} inside ${STORE_MODULE} but outside the store's own declaration, so it is a second publisher no clause can otherwise see: the call-site clause counts calls to ${PUBLISHER_EXPORT} and a publisher under a second name is uncounted however many surfaces call it. This module's exemption belongs to the ${STORE_EXPORT} initializer and the type that declares its shape, not to the file. ${REMEDY}.`;

/**
 * The publisher's declaration, read rather than assumed. Every way of failing
 * to find it throws: a rule that fell back to "no calls anywhere" would report
 * a clean repository forever the moment the export was renamed, which is the
 * silent narrowing it exists to prevent.
 */
function publisherDeclaration(project: Project): Node {
  const module = project
    .getSourceFiles()
    .find((sourceFile) => isRepoPath(relativePath(sourceFile), PUBLISHER_MODULE));
  if (module === undefined) {
    throw new Error(
      `effort-availability-has-one-publisher: ${PUBLISHER_MODULE} is not in the scanned tree, so the publisher cannot be located. Point this rule at its new home.`
    );
  }
  const declaration = module.getFunction(PUBLISHER_EXPORT);
  if (declaration === undefined) {
    throw new Error(
      `effort-availability-has-one-publisher: ${PUBLISHER_EXPORT} is no longer declared in ${PUBLISHER_MODULE}, so its call sites cannot be counted. Point this rule at its new name.`
    );
  }
  return declaration;
}

/** The name a call spells for its callee, bare or through a namespace. */
function calleeName(call: CallExpression): string | undefined {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return undefined;
}

/** Every local name this file binds an export to, the export's own name included. */
function localNamesFor(sourceFile: SourceFile, exportName: string): ReadonlySet<string> {
  const names = new Set<string>([exportName]);
  for (const declaration of sourceFile.getImportDeclarations()) {
    for (const named of declaration.getNamedImports()) {
      if (named.getName() !== exportName) continue;
      const alias = named.getAliasNode();
      if (alias !== undefined) names.add(alias.getText());
    }
  }
  return names;
}

/** Lines on which this file calls the publisher, in source order. */
function publisherCallLines(sourceFile: SourceFile): number[] {
  const names = localNamesFor(sourceFile, PUBLISHER_EXPORT);
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => {
      const name = calleeName(call);
      return name !== undefined && names.has(name);
    })
    .map((call) => call.getStartLineNumber())
    .toSorted((a, b) => a - b);
}

/** The string a literal token spells, whichever of the two literal forms it uses. */
function literalText(node: Node): string | undefined {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  return undefined;
}

/** The name a property is written under: bare, quoted, or computed from a literal. */
function propertyKeyName(node: Node): string | undefined {
  if (Node.isComputedPropertyName(node)) return literalText(node.getExpression());
  if (Node.isIdentifier(node)) return node.getText();
  return literalText(node);
}

/**
 * The write capabilities this file could be holding, by name. `setState` counts
 * only where the store is also named, because on its own it names no channel.
 */
function heldCapabilities(
  sourceFile: SourceFile,
  identifiers: readonly Identifier[]
): ReadonlySet<string> {
  const storeNames = localNamesFor(sourceFile, STORE_EXPORT);
  const holdsTheStore = identifiers.some((identifier) => storeNames.has(identifier.getText()));
  return new Set(holdsTheStore ? [STORE_SETTER, STORE_WRITE_API] : [STORE_SETTER]);
}

/** Tokens with which this file spells a write capability, in any token position. */
function capabilityTokens(sourceFile: SourceFile): Node[] {
  const identifiers = sourceFile.getDescendantsOfKind(SyntaxKind.Identifier);
  const capabilities = heldCapabilities(sourceFile, identifiers);
  const tokens: Node[] = identifiers.filter((identifier) => capabilities.has(identifier.getText()));
  for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    if (capabilities.has(literal.getLiteralValue())) tokens.push(literal);
  }
  for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    if (capabilities.has(literal.getLiteralValue())) tokens.push(literal);
  }
  return tokens;
}

/** Lines on which this file spells a write capability, in any token position. */
function capabilityLines(sourceFile: SourceFile): number[] {
  return capabilityTokens(sourceFile).map((token) => token.getStartLineNumber());
}

/**
 * Lines on which an OWNING module spells a write capability outside the regions that
 * DECLARE the channel — that is, a SECOND publisher sharing a declaring file.
 *
 * The channel's exemption belongs to the declaration, not to the file that holds it. A
 * second exported hook declared beside one would be invisible to both other clauses at
 * once: the writer clause used to skip an owning module whole, and the call-site clause
 * counts calls to a name it is given, so a publisher under a second name is uncounted
 * however many surfaces call it.
 *
 * Only capabilities are judged here, never the field in an object literal. Inside an
 * owning module the store is in hand, so a write still has to spell the setter or
 * `setState`; the field in a literal is the module's own shape — the publisher module's
 * reader return value, the store's initial state — rather than a patch from outside.
 */
function capabilityLinesOutside(sourceFile: SourceFile, declarations: readonly Node[]): number[] {
  const lines = capabilityTokens(sourceFile)
    .filter(
      (token) =>
        !declarations.some(
          (declaration) =>
            token.getStart() >= declaration.getStart() && token.getEnd() <= declaration.getEnd()
        )
    )
    .map((token) => token.getStartLineNumber());
  return [...new Set(lines)].toSorted((a, b) => a - b);
}

/**
 * The regions of the store's module that DECLARE the channel rather than write it: the
 * `create(...)` initializer that implements the store, and every type declaration in the
 * file, because the state type spells the setter's signature outside that initializer.
 *
 * Both are context questions, asked identically of every spelling, so this narrows the
 * store module's exemption without narrowing what counts as a capability.
 *
 * Losing the store's declaration makes the initializer's own spellings FIRE rather than
 * pass — the store cannot be renamed into silence, only into noise, which is the
 * direction a rule may fail in.
 */
function storeDeclarations(sourceFile: SourceFile): Node[] {
  const initializer = sourceFile.getVariableDeclaration(STORE_EXPORT)?.getInitializer();
  return [
    ...(initializer === undefined ? [] : [initializer]),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.InterfaceDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.TypeAliasDeclaration),
  ];
}

/**
 * The nodes an object literal can be nested under while still being read as a
 * destructuring pattern rather than as a value.
 */
const PATTERN_LINKS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ObjectLiteralExpression,
  SyntaxKind.ArrayLiteralExpression,
  SyntaxKind.PropertyAssignment,
  SyntaxKind.ShorthandPropertyAssignment,
  SyntaxKind.SpreadAssignment,
  SyntaxKind.SpreadElement,
  SyntaxKind.ParenthesizedExpression,
]);

/**
 * Whether this property sits in a destructuring TARGET — `({ field } = source)` — where
 * the surrounding braces take the value OUT rather than putting one in.
 *
 * This is a question about context, not about spelling: it is asked the same way of a
 * bare, a quoted and a computed key, and of any nesting depth, so it splits no
 * syntactic family across a fire and a pass. The grammar reinterprets an object literal
 * as a pattern in exactly two places — the left of an assignment, and a for-in/of
 * initializer — and both are answered here.
 *
 * A pattern still holds VALUES as well as targets: `({ patch = { field: x } } = src)`
 * puts a real literal inside the braces as a default. The walk stops there, because
 * from that point up the answer would be about the enclosing pattern rather than about
 * the literal being asked after.
 */
function isDestructuringTarget(property: Node): boolean {
  let child = property;
  let parent = property.getParent();
  while (parent !== undefined && PATTERN_LINKS.has(parent.getKind())) {
    const defaultValue: Node | undefined = Node.isShorthandPropertyAssignment(parent)
      ? parent.getObjectAssignmentInitializer()
      : undefined;
    if (defaultValue === child) return false;
    child = parent;
    parent = parent.getParent();
  }
  if (parent === undefined) return false;
  if (Node.isBinaryExpression(parent)) {
    return (
      parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken && parent.getLeft() === child
    );
  }
  if (Node.isForOfStatement(parent) || Node.isForInStatement(parent)) {
    return parent.getInitializer() === child;
  }
  return false;
}

/** Lines on which this file puts the graded field into an object as a property. */
function fieldWriteLines(sourceFile: SourceFile): number[] {
  const lines: number[] = [];
  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (propertyKeyName(property.getNameNode()) !== STORE_FIELD) continue;
    if (!isDestructuringTarget(property)) lines.push(property.getStartLineNumber());
  }
  for (const shorthand of sourceFile.getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)) {
    if (shorthand.getName() !== STORE_FIELD) continue;
    if (!isDestructuringTarget(shorthand)) lines.push(shorthand.getStartLineNumber());
  }
  return lines;
}

/**
 * Lines on which this file writes the channel without the publisher.
 *
 * The clause closes over NAMES, not over node kinds, and that is the whole of its
 * completeness argument. Two earlier versions enumerated the syntactic positions a
 * setter can be obtained in, and each was one position short — the first missed
 * declaration destructuring, the second missed assignment destructuring, and both
 * split one syntactic family across a fire and a pass on an incidental node kind.
 *
 * Writing this channel needs one of exactly two capabilities, and a file cannot
 * hold either without spelling its name:
 *
 * - The setter. Every token spelling it counts, in every position — property
 *   access, element access, either destructuring form, a property key, a bare local
 *   of that name. There is no read meaning to weigh against: the setter IS the
 *   write.
 * - Zustand's generic `setState`. Its payload is deliberately not inspected, so a
 *   spread, a pre-built patch or a variable key cannot slip past it. It counts only
 *   in a file that also names the store, because `setState` alone names no channel.
 *
 * The FIELD is a writer only where a property PUTS a value in: destructuring it,
 * like reading it off a selector's state, takes one out. Both destructuring forms
 * are answered the same way, by asking whether the braces around the key are an
 * assignment target rather than by which node kind the parser produced — the
 * declaration form yields a binding element and the assignment form an object
 * literal, and reading only the first left the second firing on a read. Its key is
 * matched bare, quoted or computed-from-a-literal, which is every key a file can
 * spell without going through a variable — and the variable case is a `setState`
 * payload, which the capability above already refuses to inspect.
 */
function writerLines(sourceFile: SourceFile): number[] {
  const lines = new Set([...capabilityLines(sourceFile), ...fieldWriteLines(sourceFile)]);
  return [...lines].toSorted((a, b) => a - b);
}

/** The writer-clause violations a file earns, which depends on whose file it is. */
function writerViolations(
  sourceFile: SourceFile,
  filePath: string,
  publisher: Node
): ArchViolation[] {
  if (isRepoPath(filePath, STORE_MODULE)) {
    return capabilityLinesOutside(sourceFile, storeDeclarations(sourceFile)).map((line) => ({
      file: filePath,
      line,
      message: SECOND_WRITER_IN_STORE,
    }));
  }
  if (isRepoPath(filePath, PUBLISHER_MODULE)) {
    return capabilityLinesOutside(sourceFile, [publisher]).map((line) => ({
      file: filePath,
      line,
      message: SECOND_WRITER_IN_MODULE,
    }));
  }
  return writerLines(sourceFile).map((line) => ({
    file: filePath,
    line,
    message: SECOND_WRITER,
  }));
}

const rule: ArchRule = {
  name: 'effort-availability-has-one-publisher',
  check(project) {
    const declaration = publisherDeclaration(project);
    const violations: ArchViolation[] = [];
    const sites: ArchViolation[] = [];

    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (isTestFile(filePath)) continue;

      for (const line of publisherCallLines(sourceFile)) {
        sites.push({ file: filePath, line, message: SECOND_CALL_SITE });
      }

      violations.push(...writerViolations(sourceFile, filePath, declaration));
    }

    if (sites.length === 0) {
      violations.push({
        file: PUBLISHER_MODULE,
        line: declaration.getStartLineNumber(),
        message: NO_CALL_SITE,
      });
    }
    // The earliest call in the composer's effort control is the invariant; every
    // other call — another surface, or a second call in that same control — is a
    // second writer. File order is the project's, so the allowed one is chosen
    // by which file it is in rather than by which was scanned first.
    const allowed = sites.find((site) => isRepoPath(site.file, CALL_SITE));
    violations.push(...sites.filter((site) => site !== allowed));
    return violations;
  },
};

export default rule;
