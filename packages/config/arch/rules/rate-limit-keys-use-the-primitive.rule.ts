import { Node, SyntaxKind } from 'ts-morph';
import { isTestFile, relativePath } from '../lib/paths.js';
import { REDIS_REGISTRY_OPERATIONS } from '../lib/redis-calls.js';
import type { RedisRegistryOperation } from '../lib/redis-calls.js';
import type { CallExpression, Project, SatisfiesExpression, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Rate-limit counters are driven by `lib/rate-limit` and nothing else.
 *
 * The primitive admits exactly `maxAttempts` per window because its whole
 * decision is one Lua `INCR` + compare. Reaching the same counter through the
 * generic Redis registry (`redisGet`/`redisSet`/…) reintroduces the
 * read-then-write window the primitive exists to close, and it does so without
 * looking like a second implementation — the registry call sites read as
 * ordinary cache access. Two arms close the two ways in:
 *
 * 1. A registry entry (`defineKey`) that mints a key in the `ratelimit:`
 *    namespace. Those keys belong to a `ThrottleLimit`/`ReservationLimit`
 *    entry, whose type makes `consume` the only way to advance them.
 * 2. A generic Redis operation handed a rate-limit definition. The compiler
 *    rejects this today (a limit definition carries no `schema`), so the arm
 *    guards the future widening that would make it compile rather than a shape
 *    reachable now.
 */

const RATE_LIMIT_KEY_PREFIX = 'ratelimit:';

/** The limit-entry types; a declaration satisfying one is a rate-limit definition. */
const LIMIT_TYPE_NAMES = new Set(['RateLimitDefinition', 'ReservationLimit', 'ThrottleLimit']);

/** The generic key-registry operations, none of which may drive a limit counter. */
const GENERIC_REDIS_OPERATIONS = new Set<string>(REDIS_REGISTRY_OPERATIONS);

/** The one operation taking the definition first; the rest take the client first. */
const ENTRY_DESCRIPTOR_OPERATION: RedisRegistryOperation = 'redisMGetEntry';

function definitionArgumentIndex(operation: string): number {
  return operation === ENTRY_DESCRIPTOR_OPERATION ? 0 : 1;
}

function isInScope(filePath: string): boolean {
  if (!filePath.includes('apps/api/src/')) return false;
  if (isTestFile(filePath)) return false;
  return !filePath.includes('apps/api/src/lib/rate-limit/');
}

/** Every string the expression can produce, template literals included. */
function literalTexts(node: Node): string[] {
  const texts: string[] = [];
  for (const literal of node.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    texts.push(literal.getLiteralText());
  }
  for (const literal of node.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    texts.push(literal.getLiteralText());
  }
  for (const literal of node.getDescendantsOfKind(SyntaxKind.TemplateExpression)) {
    texts.push(literal.getHead().getLiteralText());
  }
  return texts;
}

function buildsRateLimitKey(objectLiteral: Node): boolean {
  const buildKey = objectLiteral
    .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
    .find((property) => property.getName() === 'buildKey');
  if (buildKey === undefined) return false;
  return literalTexts(buildKey).some((text) => text.startsWith(RATE_LIMIT_KEY_PREFIX));
}

const REGISTRY_ENTRY_MESSAGE =
  "a `ratelimit:` key declared as a generic registry entry — declare it as a ThrottleLimit/ReservationLimit and advance it through lib/rate-limit's `consume`, whose atomic INCR admits exactly maxAttempts under any concurrency.";

/** Arm 1: `defineKey({ … buildKey: () => 'ratelimit:…' })`. */
function registryEntriesInRateLimitNamespace(
  call: CallExpression,
  filePath: string
): ArchViolation[] {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee) || callee.getText() !== 'defineKey') return [];
  const [definition] = call.getArguments();
  if (definition === undefined || !buildsRateLimitKey(definition)) return [];
  return [{ file: filePath, line: call.getStartLineNumber(), message: REGISTRY_ENTRY_MESSAGE }];
}

/**
 * A declared rate-limit definition: where it is declared, and the text a call
 * site would name it by — `loginIpRateLimit` for a top-level const,
 * `IDENTITY_KEYS.loginLockout` for one held in a map alongside ordinary
 * registry entries. `name` is absent for a declaration no such text reaches, a
 * limit returned inline from a factory above all; what to do about one is the
 * reading rule's decision, so it is enumerated rather than dropped here.
 */
interface LimitDeclaration {
  readonly name: string | undefined;
  readonly file: string;
  readonly line: number;
}

function limitDefinitionName(satisfies: SatisfiesExpression): string | undefined {
  const parent = satisfies.getParent();
  if (Node.isVariableDeclaration(parent)) return parent.getName();
  if (!Node.isPropertyAssignment(parent)) return undefined;
  const owner = parent.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return owner === undefined ? undefined : `${owner.getName()}.${parent.getName()}`;
}

/**
 * Every rate-limit definition declared anywhere in the scanned project, in one
 * reading. Two rules stand on it from opposite sides — this one refuses a
 * generic Redis call driven by one, and `rate-limit-entries-reach-the-cross-check`
 * refuses one no cross-check case covers — so a declaration form one of them
 * recognised and the other did not would be a hole in whichever read it
 * narrowly.
 */
export function limitDeclarations(project: Project): LimitDeclaration[] {
  const declarations: LimitDeclaration[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const file = relativePath(sourceFile);
    for (const satisfies of sourceFile.getDescendantsOfKind(SyntaxKind.SatisfiesExpression)) {
      // `satisfies` grammatically requires its type, so the throwing accessor
      // reports a broken parse rather than silently matching nothing.
      if (!LIMIT_TYPE_NAMES.has(satisfies.getTypeNodeOrThrow().getText())) continue;
      declarations.push({
        name: limitDefinitionName(satisfies),
        file,
        line: satisfies.getStartLineNumber(),
      });
    }
  }
  return declarations;
}

function collectLimitDefinitionNames(project: Project): Set<string> {
  const names = new Set<string>();
  for (const declaration of limitDeclarations(project)) {
    if (declaration.name !== undefined) names.add(declaration.name);
  }
  return names;
}

/** Arm 2: a generic registry operation handed one of those definitions. */
function genericOperationsOnLimits(
  call: CallExpression,
  filePath: string,
  limitNames: Set<string>
): ArchViolation[] {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return [];
  const operation = callee.getText();
  if (!GENERIC_REDIS_OPERATIONS.has(operation)) return [];
  const argument = call.getArguments()[definitionArgumentIndex(operation)];
  if (argument === undefined || !limitNames.has(argument.getText())) return [];
  return [
    {
      file: filePath,
      line: call.getStartLineNumber(),
      message: `${operation}() called with the rate-limit definition ${argument.getText()} — limit counters are advanced only by lib/rate-limit's \`consume\`/\`clear\`, never through the generic key registry.`,
    },
  ];
}

function violationsIn(
  sourceFile: SourceFile,
  filePath: string,
  limitNames: Set<string>
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    violations.push(
      ...registryEntriesInRateLimitNamespace(call, filePath),
      ...genericOperationsOnLimits(call, filePath, limitNames)
    );
  }
  return violations;
}

const rule: ArchRule = {
  name: 'rate-limit-keys-use-the-primitive',
  check(project) {
    const limitNames = collectLimitDefinitionNames(project);
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (!isInScope(filePath)) continue;
      violations.push(...violationsIn(sourceFile, filePath, limitNames));
    }
    return violations;
  },
};

export default rule;
