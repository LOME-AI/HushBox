import { Node, SyntaxKind } from 'ts-morph';
import { EXTERNAL_PORTS } from '../lib/external-calls.js';
import { isTestFile, relativePath } from '../lib/paths.js';
import type {
  ImportTypeNode,
  InterfaceDeclaration,
  Project,
  PropertySignature,
  SourceFile,
  TypeAliasDeclaration,
  TypeNode,
  TypeReferenceNode,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A post-commit capability stays off an admin operation's transaction-scoped
 * dependencies.
 *
 * Admin preview is the real op body run inside a transaction that is then
 * rolled back, which is what makes previewing against production data safe. The
 * dependency types carry that: a body receives only the transaction-scoped
 * half, and a post-commit capability reaches op-authored code only as the
 * argument the engine hands a registered effect after the commit. A live sender
 * on the transaction-scoped half puts the capability back in the body's scope,
 * where a call on it outruns the rollback — a preview that discards the body's
 * rows but cannot recall the mail.
 *
 * The compiler enforces the partition once a dependency has been classified; it
 * has nothing to say about the classification being right. This rule is the
 * declaration-site half: which types may appear on which half.
 *
 * WHICH half a type is, is read from POSITION, never from its name: the halves
 * are the type arguments {@link ANCHORS} names, at the position it records for
 * each. Inheritance carries the classification with it, so the composite union
 * that names a family's halves classifies that family too
 * ({@link withInheritedNames}).
 *
 * The guarded set is DERIVED from the post-commit halves rather than
 * enumerated: every capability name a post-commit half declares
 * ({@link capabilityNamesDeclaredBy}) is refused wherever a transaction-scoped
 * declaration writes it ({@link guardedNamedBy}), so a capability is guarded the
 * moment it is declared post-commit rather than when a list someone maintains
 * catches up. The port names {@link EXTERNAL_PORTS} carries are a floor under
 * that, covering ports no post-commit half names. Both sides compare the name
 * as written, in the forms {@link asNamedType} reads.
 *
 * The derived set is rebuilt from the halves on each run, so it follows them
 * down as well as up. That, and one of the places its reach ends, are pinned
 * by case rather than described here: see “un-derives a capability once no
 * post-commit half names it” and “leaves a capability composed under an
 * inline object type unrefused” in `admin-external-ports-stay-post-commit.rule.test.ts`.
 */

/** Where a generic puts each dependency half among its type arguments. */
interface HalfPositions {
  readonly transactionScoped: number;
  readonly postCommit: number;
}

/**
 * The generics that name an operation's two dependency halves, and the type
 * argument position each half sits at. The transaction-scoped half is always
 * first; the post-commit half trails the input schema where a generic carries
 * one, which is why the positions are read from a table rather than an offset.
 */
const ANCHORS: ReadonlyMap<string, HalfPositions> = new Map([
  ['AdminOpContext', { transactionScoped: 0, postCommit: 1 }],
  ['AdminOpEngineDeps', { transactionScoped: 0, postCommit: 1 }],
  ['AdminOpImplementation', { transactionScoped: 0, postCommit: 2 }],
  ['AdminOpRegistry', { transactionScoped: 0, postCommit: 1 }],
  ['createAdminOpRegistry', { transactionScoped: 0, postCommit: 1 }],
  ['defineAdminOp', { transactionScoped: 0, postCommit: 2 }],
]);

const EXTERNAL_PORT_NAMES = new Set<string>(EXTERNAL_PORTS);

/** The admin slice, whose operation dependencies are this rule's whole subject. */
const ADMIN_SLICE = 'apps/api/src/slices/admin/';

/** A dependency interface, or the alias standing in for an empty one. */
type DependencyDeclaration = InterfaceDeclaration | TypeAliasDeclaration;

/** `registry.AdminOpContext` → `AdminOpContext`; the name a reference ends in. */
function lastSegment(text: string): string {
  return text.slice(text.lastIndexOf('.') + 1);
}

/** The two node kinds that write a type's name at a declaration site. */
type NamedTypeNode = ImportTypeNode | TypeReferenceNode;

/**
 * The node read as one that writes a type's name, or nothing: a type reference
 * (`EmailSender`, `ports.EmailSender`) and an import type
 * (`import('./ports.js').EmailSender`), the `typeof import(…)` form included,
 * since it parses as one. Both sides of the comparison come through here — the
 * capability name a post-commit member declares, and the names a
 * transaction-scoped declaration writes — and {@link writtenName} takes the
 * last segment of whichever form it is.
 */
function asNamedType(node: Node | undefined): NamedTypeNode | undefined {
  return Node.isTypeReference(node) || Node.isImportTypeNode(node) ? node : undefined;
}

/** The name written, less any namespace or module qualification. */
function writtenName(node: NamedTypeNode): string | undefined {
  if (Node.isTypeReference(node)) return lastSegment(node.getTypeName().getText());
  const qualifier = node.getQualifier();
  return qualifier === undefined ? undefined : lastSegment(qualifier.getText());
}

/** The type this anchor puts at the named half's position, when it names one. */
function depsNameAt(
  anchor: string,
  typeArguments: readonly TypeNode[],
  half: keyof HalfPositions
): string[] {
  const positions = ANCHORS.get(anchor);
  const deps = positions === undefined ? undefined : typeArguments[positions[half]];
  return deps !== undefined && Node.isTypeReference(deps)
    ? [lastSegment(deps.getTypeName().getText())]
    : [];
}

/**
 * Every type named at the given half's position anywhere in this file, in both
 * forms an anchor takes: a type reference (`AdminOpImplementation<…>`) and a
 * definition call's explicit type arguments (`defineAdminOp<…>(…)`).
 */
function halfNames(file: SourceFile, half: keyof HalfPositions): string[] {
  return [
    ...file
      .getDescendantsOfKind(SyntaxKind.TypeReference)
      .flatMap((reference) =>
        depsNameAt(
          lastSegment(reference.getTypeName().getText()),
          reference.getTypeArguments(),
          half
        )
      ),
    ...file
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .flatMap((call) =>
        depsNameAt(lastSegment(call.getExpression().getText()), call.getTypeArguments(), half)
      ),
  ];
}

/** The admin slice's dependency-shaped declarations, by name. */
function declarationsByName(project: Project): Map<string, DependencyDeclaration[]> {
  const declarations = new Map<string, DependencyDeclaration[]>();
  for (const file of project.getSourceFiles()) {
    const filePath = relativePath(file);
    if (isTestFile(filePath) || !filePath.includes(ADMIN_SLICE)) continue;
    for (const declaration of [...file.getInterfaces(), ...file.getTypeAliases()]) {
      const named = declarations.get(declaration.getName()) ?? [];
      named.push(declaration);
      declarations.set(declaration.getName(), named);
    }
  }
  return declarations;
}

/** The types a named declaration inherits from; an alias inherits from nothing. */
function parentNames(
  name: string,
  declarations: ReadonlyMap<string, DependencyDeclaration[]>
): string[] {
  return (declarations.get(name) ?? []).flatMap((declaration) =>
    Node.isInterfaceDeclaration(declaration)
      ? declaration.getExtends().map((parent) => lastSegment(parent.getExpression().getText()))
      : []
  );
}

/**
 * The named types plus everything they inherit from. A composite union names
 * its families' halves rather than restating their members, so a family reached
 * only through one is on the transaction-scoped half exactly as directly as the
 * union is.
 */
function withInheritedNames(
  seed: Iterable<string>,
  declarations: ReadonlyMap<string, DependencyDeclaration[]>
): Set<string> {
  const reached = new Set(seed);
  let frontier = [...reached];
  while (frontier.length > 0) {
    const inherited = frontier
      .flatMap((name) => parentNames(name, declarations))
      .filter((parent) => !reached.has(parent));
    for (const parent of inherited) reached.add(parent);
    frontier = inherited;
  }
  return reached;
}

/** The declared properties of a dependency interface, or of the alias standing in for one. */
function properties(declaration: DependencyDeclaration): PropertySignature[] {
  if (Node.isInterfaceDeclaration(declaration)) return declaration.getProperties();
  const aliased = declaration.getTypeNode();
  return Node.isTypeLiteral(aliased) ? aliased.getProperties() : [];
}

/**
 * The capability names a post-commit half puts into the guarded set: the type a
 * member is declared AS, and only where that is written as a bare name — in
 * either form that writes one ({@link asNamedType}), carrying no type
 * arguments.
 *
 * Reading the member's own type and nothing under it is the deliberate part.
 * Under it sit `Promise`, `ResultAsync`, `DomainError` and the domain types a
 * post-commit signature mentions in passing; deriving those would put them in
 * the guarded set, where an ordinary transaction-scoped dependency of the same
 * type is then refused. Refusal reads wider ({@link guardedNamedBy}).
 */
function capabilityNamesDeclaredBy(declaration: DependencyDeclaration): string[] {
  return properties(declaration).flatMap((member) => {
    const declared = asNamedType(member.getTypeNode());
    const name = declared?.getTypeArguments().length === 0 ? writtenName(declared) : undefined;
    return name === undefined ? [] : [name];
  });
}

function guardedOnTransactionHalfMessage(name: string, declaration: string): string {
  const what = EXTERNAL_PORT_NAMES.has(name)
    ? `${name} is an external port`
    : `${name} is a post-commit capability, named on an admin op's post-commit dependencies`;
  return `${what}, declared on ${declaration} — an admin op's transaction-scoped dependencies, which its body holds while a preview's transaction is still open and about to roll back. Declare it on the family's post-commit dependencies, where the engine hands it to a registered effect after the commit.`;
}

/** Every guarded type this declaration names, wherever in a member it sits. */
function guardedNamedBy(
  declaration: DependencyDeclaration,
  guarded: ReadonlySet<string>
): ArchViolation[] {
  return declaration.getDescendants().flatMap((node) => {
    const named = asNamedType(node);
    if (named === undefined) return [];
    const name = writtenName(named);
    return name !== undefined && guarded.has(name)
      ? [
          {
            file: relativePath(declaration.getSourceFile()),
            line: named.getStartLineNumber(),
            message: guardedOnTransactionHalfMessage(name, declaration.getName()),
          },
        ]
      : [];
  });
}

/** The declarations standing at the given half's position, and everything they inherit. */
function declarationsOfHalf(
  project: Project,
  declarations: ReadonlyMap<string, DependencyDeclaration[]>,
  half: keyof HalfPositions
): DependencyDeclaration[] {
  const names = new Set<string>();
  for (const file of project.getSourceFiles()) {
    if (isTestFile(relativePath(file))) continue;
    for (const name of halfNames(file, half)) names.add(name);
  }
  return [...withInheritedNames(names, declarations)]
    .toSorted((a, b) => a.localeCompare(b))
    .flatMap((name) => declarations.get(name) ?? []);
}

const rule: ArchRule = {
  name: 'admin-external-ports-stay-post-commit',
  check(project) {
    const declarations = declarationsByName(project);
    const guarded = new Set<string>(EXTERNAL_PORT_NAMES);
    for (const declaration of declarationsOfHalf(project, declarations, 'postCommit')) {
      for (const name of capabilityNamesDeclaredBy(declaration)) guarded.add(name);
    }
    return declarationsOfHalf(project, declarations, 'transactionScoped').flatMap((declaration) =>
      guardedNamedBy(declaration, guarded)
    );
  },
};

export default rule;
