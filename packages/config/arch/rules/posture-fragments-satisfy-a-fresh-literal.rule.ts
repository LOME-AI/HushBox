import { Node, SyntaxKind } from 'ts-morph';

import { isTestFile, relativePath, sourceFileAt } from '../lib/paths.js';

import type {
  ExportSpecifier,
  Expression,
  ObjectLiteralExpression,
  Project,
  SourceFile,
  TypeNode,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Doctrine: "Every route declares a rate-limit posture in the route-keyed posture
 * map" (`CODE-RULES.md` §Security). Once that map is assembled from per-slice
 * fragments, each fragment's completeness is the compiler's job — and the half of
 * that check which catches a STALE route key (one the slice no longer serves) rests
 * entirely on object-literal **freshness**, not on the presence of a `satisfies`
 * clause.
 *
 * Measured, not assumed: the same stale key survives with no diagnostic at all —
 * exit 0 — when the literal reaches `satisfies` through a named binding, through a
 * spread of one, through a helper's return, or when the clause's target is widened.
 * Widening was measured in three spellings: `Record<string, …>`, which drops the key
 * union's name, and `Record<SliceRouteKey<…> | string, …>` and
 * `Record<SliceRouteKey<…>, …> & Record<string, …>`, which keep it. The two that keep
 * it were compiled against a real slice manifest carrying every real key plus one
 * stale one and produced nothing at all, while the exact target reported the stale key
 * at its own line. Each spelling carries a `satisfies` clause, and the two that keep
 * the name would clear a rule checking for a mention of it, so neither test recovers
 * anything. The missing-key half is robust to the same indirection (it is an
 * assignability failure, not a freshness one), which is exactly why only the fragile
 * half needs a structural rule.
 *
 * A non-`const` assertion is refused for the same reason a binding is: `{…} as Loose
 * satisfies Target` type-checks the ASSERTED type, so the stale key goes unreported.
 * `as const` is the one assertion that preserves freshness, so it is the one allowed
 * between the literal and the clause.
 *
 * The rule holds three clauses, and no clause reads a test file: a path
 * {@link isTestFile} matches is skipped before any of them runs. Within what remains,
 * the first two run over a slice's `rate-limit-posture.ts`; the third runs over every
 * other module under `apps/api/src/slices/`:
 *
 * 1. Every exported value declaration is `{…} satisfies …` with the clause on the
 *    literal itself, and that literal declares at least one route. Stated over
 *    EVERY exported value rather than over "the fragment" deliberately: identifying
 *    the fragment by its `satisfies` clause would make the rule circular — a
 *    fragment written without one would not be recognised as a fragment, which is
 *    the case the naive rule was written for. An EMPTY literal is refused on the
 *    same freshness logic one step up: an empty literal that compiles proves the
 *    derived key union is empty too, since a non-empty one would fail the
 *    missing-key half, so it satisfies its target vacuously.
 * 2. The clause's target IS a `Record` keyed by {@link KEY_UNION}, resolved
 *    structurally rather than by mention: the key position must resolve to that type
 *    itself — directly, or through a same-file type alias — never to a union that
 *    merely contains it, and the target itself is never an intersection. Naming the
 *    union is not enough, which is what the two keep-the-name spellings above
 *    measure; dropping it (`Record<string, CarriedRoutePosture>`) is the same hole
 *    spelled without it.
 * 3. {@link BINDING_FACTORY} — the sole constructor of a carried posture — is named
 *    nowhere under `apps/api/src/slices/` except a slice's own fragment file. This
 *    is what makes clause 1's path matcher binding rather than evadable: a fragment
 *    written at some other path would otherwise slip past clauses 1 and 2 together,
 *    silently, and this rule's whole subject is a check that passes over nothing.
 *
 * The rule also asserts its own subject before reporting anything — see
 * {@link assertFactoryIsStillPublished}, which is where clause 3's silent decay is
 * closed.
 *
 * What the rule does NOT prove, stated rather than implied away:
 *
 * - That the target's type argument is THIS slice's manifest. A foreign slice's
 *   manifest passes clause 2, and so does any argument the derivation resolves to
 *   `never`: an EMPTY key union admits a non-empty literal carrying any stale key,
 *   with no diagnostic at all (measured). That is the one shape clause 1's
 *   empty-literal refusal cannot reach — an empty union with a NON-empty literal —
 *   and catching it belongs to the merge-level completeness assertion, not here.
 * - That a hand-written posture object, one that never calls the factory, is absent
 *   from some other path. Clause 3 keys on the factory's name, so it narrows that; it
 *   does not seal it.
 */

/** A slice's posture fragment: one per slice, at the slice root. */
const FRAGMENT_PATH = /(?:^|\/)apps\/api\/src\/slices\/[^/]+\/rate-limit-posture\.ts$/;

/** The tree clause 3 watches for a fragment that wandered off the fragment path. */
const SLICE_TREE = /(?:^|\/)apps\/api\/src\/slices\//;

const RULE_NAME = 'posture-fragments-satisfy-a-fresh-literal';

/** The sole constructor of a carried posture, and so the mark of a fragment. */
export const BINDING_FACTORY = 'bindRoutePosture';

/** The module that declares {@link BINDING_FACTORY}. */
export const CAPABILITY_MODULE = 'apps/api/src/lib/rate-limit/capability.ts';

/** The published type that derives one slice's route keys from its own manifest. */
const KEY_UNION = 'SliceRouteKey';

/** The one target constructor the clause admits, keyed by {@link KEY_UNION}. */
const RECORD = 'Record';

const REMEDY =
  'write it as `{…} satisfies Record<SliceRouteKey<…>, CarriedRoutePosture>` with the clause on the literal itself — a stale route key is caught only while the literal is fresh, and every indirection (a binding, a spread, a helper return, a non-`const` assertion) drops that check silently while keeping the clause.';

/** What stands between a `satisfies` clause and a fresh object literal, if anything. */
type Freshness = { readonly fresh: true } | { readonly fresh: false; readonly reason: string };

function refuse(reason: string): Freshness {
  return { fresh: false, reason };
}

function literalFreshness(literal: ObjectLiteralExpression): Freshness {
  const properties = literal.getProperties();
  if (properties.some((property) => Node.isSpreadAssignment(property))) {
    return refuse(
      'the literal spreads another value, and spread-in keys carry no excess-property check'
    );
  }
  if (properties.length === 0) {
    return refuse(
      'the literal declares no route, and an EMPTY literal that compiles proves the derived key union is empty too — the fragment satisfies its target vacuously'
    );
  }
  return { fresh: true };
}

function freshnessOf(expression: Expression): Freshness {
  if (Node.isParenthesizedExpression(expression)) return freshnessOf(expression.getExpression());
  if (Node.isObjectLiteralExpression(expression)) return literalFreshness(expression);
  if (Node.isAsExpression(expression)) {
    const asType = expression.getTypeNodeOrThrow().getText();
    if (asType === 'const') return freshnessOf(expression.getExpression());
    return refuse(
      `a type assertion (\`as ${asType}\`) stands between the literal and the clause, so the ASSERTED type is what gets checked`
    );
  }
  if (Node.isCallExpression(expression)) {
    return refuse("the clause applies to a call's return value, not to a literal");
  }
  if (Node.isIdentifier(expression) || Node.isPropertyAccessExpression(expression)) {
    return refuse('the clause applies to a binding, not to a literal');
  }
  return refuse(`the clause applies to a ${expression.getKindName()}, not to a literal`);
}

/** Same-file type aliases, so a target or a key position may be spelled as one. */
type TypeAliases = ReadonlyMap<string, TypeNode>;

function sameFileAliases(sourceFile: SourceFile): TypeAliases {
  const aliases = new Map<string, TypeNode>();
  for (const alias of sourceFile.getTypeAliases()) {
    aliases.set(alias.getName(), alias.getTypeNodeOrThrow());
  }
  return aliases;
}

function bareType(node: TypeNode): TypeNode {
  return Node.isParenthesizedTypeNode(node) ? bareType(node.getTypeNode()) : node;
}

/**
 * The same-file alias a type name resolves to, once. `seen` makes an alias cycle
 * terminate rather than recur: an alias cycle is a type error, not a syntax one, so it
 * reaches this rule intact, and a rule that hangs takes the whole check down.
 */
function aliasToFollow(
  bare: TypeNode,
  aliases: TypeAliases,
  seen: Set<string>
): TypeNode | undefined {
  if (!Node.isTypeReference(bare)) return undefined;
  const name = bare.getTypeName().getText();
  if (seen.has(name)) return undefined;
  const alias = aliases.get(name);
  if (alias === undefined) return undefined;
  seen.add(name);
  return alias;
}

/** The key position of a `Record<K, V>`, or undefined for anything else. */
function recordKeyPosition(bare: TypeNode): TypeNode | undefined {
  if (!Node.isTypeReference(bare)) return undefined;
  if (bare.getTypeName().getText() !== RECORD) return undefined;
  const args = bare.getTypeArguments();
  return args.length === 2 ? args[0] : undefined;
}

/**
 * The key position must BE {@link KEY_UNION}, not merely mention it: a union with one
 * further member reads as the published type to any textual check while admitting
 * every key the union does not name.
 */
function keyPositionRefusal(
  node: TypeNode,
  aliases: TypeAliases,
  seen: Set<string>
): string | undefined {
  const bare = bareType(node);
  if (Node.isUnionTypeNode(bare)) {
    return `its key position \`${bare.getText()}\` is a union rather than \`${KEY_UNION}\` itself, and a member beside the union admits every key the union does not name`;
  }
  if (Node.isTypeReference(bare) && bare.getTypeName().getText() === KEY_UNION) return undefined;
  const alias = aliasToFollow(bare, aliases, seen);
  if (alias !== undefined) return keyPositionRefusal(alias, aliases, seen);
  return `its key position \`${bare.getText()}\` is not \`${KEY_UNION}\``;
}

function targetRefusal(
  node: TypeNode,
  aliases: TypeAliases,
  seen: Set<string>
): string | undefined {
  const bare = bareType(node);
  if (Node.isIntersectionTypeNode(bare)) {
    return `the target is an intersection, and a member widening the key domain leaves the \`${KEY_UNION}\` member's excess-property check nothing to refuse`;
  }
  const keyPosition = recordKeyPosition(bare);
  if (keyPosition !== undefined) return keyPositionRefusal(keyPosition, aliases, seen);
  const alias = aliasToFollow(bare, aliases, seen);
  if (alias !== undefined) return targetRefusal(alias, aliases, seen);
  return `the target is \`${bare.getText()}\`, not a \`Record\` keyed by \`${KEY_UNION}\``;
}

/** An exported value this module declares itself, paired with its name. */
interface ExportedValue {
  readonly name: string;
  readonly line: number;
  readonly initializer: Expression | undefined;
  /** A function, class, enum or default export can never be a fragment declaration. */
  readonly declarable: boolean;
}

function fromVariableStatements(sourceFile: SourceFile): ExportedValue[] {
  return sourceFile
    .getVariableStatements()
    .filter((statement) => statement.isExported())
    .flatMap((statement) => statement.getDeclarations())
    .map((declaration) => ({
      name: declaration.getName(),
      line: declaration.getStartLineNumber(),
      initializer: declaration.getInitializer(),
      declarable: true,
    }));
}

function localExportedValue(
  sourceFile: SourceFile,
  specifier: ExportSpecifier
): ExportedValue | undefined {
  if (specifier.isTypeOnly()) return undefined;
  const local = sourceFile.getVariableDeclaration(specifier.getName());
  if (local === undefined) return undefined;
  return {
    name: local.getName(),
    line: local.getStartLineNumber(),
    initializer: local.getInitializer(),
    declarable: true,
  };
}

/** `const X = …; export { X };` — the declaration carries no export keyword of its own. */
function fromExportClauses(sourceFile: SourceFile): ExportedValue[] {
  return sourceFile
    .getExportDeclarations()
    .filter(
      (declaration) => !declaration.isTypeOnly() && declaration.getModuleSpecifier() === undefined
    )
    .flatMap((declaration) => declaration.getNamedExports())
    .map((specifier) => localExportedValue(sourceFile, specifier))
    .filter((value): value is ExportedValue => value !== undefined);
}

function fromNonVariableExports(sourceFile: SourceFile): ExportedValue[] {
  const declared = [
    ...sourceFile.getFunctions(),
    ...sourceFile.getClasses(),
    ...sourceFile.getEnums(),
  ]
    .filter((declaration) => declaration.isExported())
    .map((declaration) => ({
      name: declaration.getName() ?? 'default',
      line: declaration.getStartLineNumber(),
      initializer: undefined,
      declarable: false,
    }));
  const assigned = sourceFile.getExportAssignments().map((assignment) => ({
    name: 'default',
    line: assignment.getStartLineNumber(),
    initializer: undefined,
    declarable: false,
  }));
  return [...declared, ...assigned];
}

function exportedValues(sourceFile: SourceFile): ExportedValue[] {
  return [
    ...fromVariableStatements(sourceFile),
    ...fromExportClauses(sourceFile),
    ...fromNonVariableExports(sourceFile),
  ];
}

function refusalFor(value: ExportedValue, aliases: TypeAliases): string | undefined {
  if (!value.declarable || value.initializer === undefined) {
    return 'is not a posture-fragment declaration';
  }
  const initializer = value.initializer;
  if (!Node.isSatisfiesExpression(initializer)) return 'carries no `satisfies` clause';
  const freshness = freshnessOf(initializer.getExpression());
  if (!freshness.fresh) return freshness.reason;
  const target = initializer.getTypeNodeOrThrow();
  const refusal = targetRefusal(target, aliases, new Set());
  if (refusal === undefined) return undefined;
  return `satisfies \`${target.getText()}\` — ${refusal}, so it checks no route key, fresh literal or not`;
}

function fragmentViolations(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const values = exportedValues(sourceFile);
  if (values.length === 0) {
    return [
      {
        file: filePath,
        line: 1,
        message: `Fragment module declares no posture fragment — it exports no value declaration. A fragment path with nothing on it makes the freshness check pass over nothing: ${REMEDY}`,
      },
    ];
  }
  const aliases = sameFileAliases(sourceFile);
  const violations: ArchViolation[] = [];
  for (const value of values) {
    const reason = refusalFor(value, aliases);
    if (reason === undefined) continue;
    violations.push({
      file: filePath,
      line: value.line,
      message: `Fragment module's exported \`${value.name}\` — ${reason}. ${REMEDY}`,
    });
  }
  return violations;
}

/**
 * Clause 3. Read off IDENTIFIERS rather than off import declarations: an aliased
 * import, a namespace-qualified call and a bare call each write the factory's own
 * name somewhere, and a rule that read only the import list would miss whichever
 * form it did not enumerate.
 */
function strayFragmentViolations(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const named = sourceFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .find((identifier) => identifier.getText() === BINDING_FACTORY);
  if (named === undefined) return [];
  return [
    {
      file: filePath,
      line: named.getStartLineNumber(),
      message: `Slice module names \`${BINDING_FACTORY}\` outside the slice's own \`rate-limit-posture.ts\` — a posture fragment declared anywhere else escapes the freshness check entirely, so a bound posture is declared at the fragment path or nowhere.`,
    },
  ];
}

/**
 * The rule's own subject, asserted before it reports anything.
 *
 * Clause 3 is written against a symbol NAME, and it is the one clause whose decay is
 * SILENT: rename or move the factory and the clause matches nothing, reports nothing,
 * and clause 1's path matcher is evadable again — the permanently-inert failure that
 * clause exists to prevent. {@link KEY_UNION} needs no such assertion because clause 2
 * fails in the opposite direction: it demands the target resolve to that exact name, so
 * a stale constant refuses fragments rather than silently admitting them.
 *
 * Both halves are asserted, and a module that still exists proves nothing about the
 * name it exports. They are asserted here rather than through the shared
 * `assertNamedPathsExist` because that helper is path-shaped and returns nothing: the
 * export half needs the file itself, and a path assertion followed by a second lookup
 * would leave an arm no test can reach. The failure is a throw rather than a violation
 * because what went missing is the rule's own subject, so there is nothing to report
 * it against.
 */
function assertFactoryIsStillPublished(project: Project): void {
  const module = sourceFileAt(project, CAPABILITY_MODULE);
  if (module === undefined) {
    throw new Error(
      `${RULE_NAME}: '${CAPABILITY_MODULE}' names no file in the scanned tree, so the symbol ` +
        `every clause below is written against cannot be confirmed to exist. Point this rule ` +
        `at the module that declares \`${BINDING_FACTORY}\` now.`
    );
  }
  if (!exportedValues(module).some((value) => value.name === BINDING_FACTORY)) {
    throw new Error(
      `${RULE_NAME}: '${CAPABILITY_MODULE}' no longer declares an exported \`${BINDING_FACTORY}\`, so the ` +
        `clause watching for it matches nothing and reports nothing, leaving a posture fragment ` +
        `free to be declared anywhere. Name the factory this rule watches for.`
    );
  }
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project) {
    assertFactoryIsStillPublished(project);
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (isTestFile(filePath)) continue;
      if (FRAGMENT_PATH.test(filePath)) {
        violations.push(...fragmentViolations(sourceFile, filePath));
        continue;
      }
      if (!SLICE_TREE.test(filePath)) continue;
      violations.push(...strayFragmentViolations(sourceFile, filePath));
    }
    return violations;
  },
};

export default rule;
