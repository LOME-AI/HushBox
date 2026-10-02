import { Node, SyntaxKind } from 'ts-morph';
import { assertNamedPathsExist, failWith, isRepoPath, relativePath } from './paths.js';
import type { ObjectLiteralExpression, Project, SourceFile, VariableDeclaration } from 'ts-morph';

/**
 * How the evidence registry is READ, for the two rules that read it.
 *
 * `declared-evidence-names-are-required` holds the whole registry against the
 * workflow files; `evidence-rows-outlive-the-worker-clone` resolves one write
 * site's service argument against it. Both start from the same three facts —
 * which module declares the names, which object holds them, and which members
 * that object writes — and each carried its own walk of them. Nothing compared
 * the two: each rule's tests build their own fixture registry, so a member
 * shape read by one walk and not the other shrinks the other's set with no
 * symptom on either side. A name that goes unread is a name never held against
 * the workflow, and an unread member leaves a write naming it reading as naming
 * no declared service — a silent pass in one rule and a silent green in the
 * other.
 *
 * WHAT THIS OWNS is the walk, and the abort when a caller is left holding
 * nothing — the rule's own subject going missing rather than a finding, since a
 * rule that resolves nothing accuses nothing and proves nothing. Each caller
 * passes its own remedy prose, as it does to {@link assertNamedPathsExist},
 * because what the silence costs differs per rule.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN is what to do about a member whose name it
 * cannot read. The two rules differ there on purpose, and each follows its own
 * harm: holding the workflow against part of a registry while reporting success
 * over the whole of it is the empty-registry silence one member at a time, so
 * that rule refuses; a service name that resolves to nothing is a name no
 * requirement can demand, so the other passes the write over. Every member is
 * therefore handed to the caller's own reader — carrying its inline name where
 * it has one and nothing where it has none — and the policy stays with the rule
 * whose harm it follows.
 *
 * A MEMBER'S NAME IS AN INLINE STRING LITERAL, and the initializer holding the
 * members is read through its type assertions and no further. `as const` is
 * what the registry writes; a `satisfies` spelling resolves to no object
 * literal and so to no member, which the zero-member abort turns into a loud
 * failure rather than a quiet one.
 */

/** The module declaring which service names exist, repo-relative. */
export const REGISTRY_MODULE = 'packages/db/src/evidence.ts';

/** The registry's own declaration inside that module, and the spelling a call site reads a name off. */
export const REGISTRY_OBJECT = 'SERVICE_NAMES';

/** One member of the registry object, in the readings its two callers need. */
export interface RegistryMember {
  /** The member as written: its property name, or its whole text where it has none. */
  readonly written: string;
  /** The inline name it declares, or nothing where it is written in a shape this cannot read. */
  readonly name: string | undefined;
  /** The line a caller's message about this member points at. */
  readonly line: number;
}

/** What a caller says when the registry it reads is not there to be read. */
interface RegistryAborts {
  /** Appended to the missing-module failure: what reading no registry would cost this rule. */
  readonly missingModule: string;
  /** The whole message for a registry that resolves to no member at all. */
  readonly emptyRegistry: string;
}

/** An expression with its type assertions stripped. */
function unwrapped(node: Node): Node {
  return Node.isAsExpression(node) ? unwrapped(node.getExpression()) : node;
}

/** The object literal a declaration initializes, or nothing for a shape this cannot read. */
function registryLiteral(declaration: VariableDeclaration): ObjectLiteralExpression[] {
  const initializer = declaration.getInitializer();
  if (initializer === undefined) return [];
  const value = unwrapped(initializer);
  return Node.isObjectLiteralExpression(value) ? [value] : [];
}

/** The inline name one member declares, or nothing where it carries none of its own. */
function declaredName(property: Node): string | undefined {
  if (!Node.isPropertyAssignment(property)) return undefined;
  const initializer = property.getInitializer();
  return initializer !== undefined && Node.isStringLiteral(initializer)
    ? initializer.getLiteralValue()
    : undefined;
}

function memberOf(property: Node): RegistryMember {
  return {
    written: Node.isPropertyAssignment(property) ? property.getName() : property.getText().trim(),
    name: declaredName(property),
    line: property.getStartLineNumber(),
  };
}

function membersIn(file: SourceFile): RegistryMember[] {
  return file
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter((declaration) => declaration.getName() === REGISTRY_OBJECT)
    .flatMap((declaration) => registryLiteral(declaration))
    .flatMap((literal) => literal.getProperties())
    .map((property) => memberOf(property));
}

/**
 * What the registry declares, read off the declaring module itself and handed
 * one member at a time to the caller's own reader.
 *
 * The reader is where the two rules part: one refuses a member it cannot read
 * and the other returns nothing for it, and what it returns nothing for is
 * dropped here. So the emptiness the abort asks about is emptiness of what the
 * CALLER kept, which is the only reading that is honest for both — a registry
 * whose every member one rule drops leaves that rule resolving nothing, exactly
 * as a registry with no member at all does.
 *
 * Every arm is the caller's own subject going missing rather than a finding
 * about anything in the tree, which is why they abort instead of reporting.
 */
export function registryMembers<Kept>(
  rule: string,
  project: Project,
  aborts: RegistryAborts,
  read: (member: RegistryMember) => Kept | undefined
): Kept[] {
  const refuse: (message: string) => never = failWith(rule);
  assertNamedPathsExist(rule, project, [REGISTRY_MODULE], aborts.missingModule);
  const kept = project
    .getSourceFiles()
    .filter((file) => isRepoPath(relativePath(file), REGISTRY_MODULE))
    .flatMap((file) => membersIn(file))
    .flatMap((member) => {
      const value = read(member);
      return value === undefined ? [] : [value];
    });
  if (kept.length === 0) refuse(aborts.emptyRegistry);
  return kept;
}
