import { Node, SyntaxKind } from 'ts-morph';
import { isTestFile } from '../lib/paths.js';
import {
  REDIS_REGISTRY_OPERATIONS,
  calledMember,
  receiverTailNamesRedis,
} from '../lib/redis-calls.js';
import type { CallExpression, Node as TsNode, SourceFile } from 'ts-morph';
import type { RedisRegistryOperation } from '../lib/redis-calls.js';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A key a test hands to Redis may not be built from a literal identity.
 *
 * Concurrent test runs share one logical Redis, and the harness scopes each
 * run's keys (`scripts/lib/vitest/redis-scope.ts`) so a fixed identity can no
 * longer make two runs collide. The rule survives the scope because it fails in
 * a different place: at the moment someone writes `buildKey('user-1')`, rather
 * than at the moment two runs meet. A literal identity is a fixture two authors
 * can pick independently, and inside one run it is still one key two suites
 * share.
 *
 * The subject is the identity, never the value: `redis.set(key, 'a literal')`
 * is a value nothing else can read, and only the key names anything shared.
 *
 * Scope is a key that REACHES Redis, and the repository spells that two ways,
 * each read on its own terms. A client-member call carries the key already
 * built — `redis.set(definition.buildKey(id), …)` — so the builder call
 * standing in its arguments is what this reads. A key-registry helper takes
 * the identity itself and builds the key inside — `redisGet(redis, definition,
 * id)` — so there the ARGUMENTS at {@link IDENTITY_ARGUMENTS_FROM} are what
 * this reads. A key built only to assert its own shape reaches no store and is
 * left alone; the alternative would push those assertions into mirroring the
 * template they exist to check.
 *
 * Two residuals, one per spelling. A builder call assigned to a variable and
 * used a line later stands outside every Redis call's arguments, so the member
 * form does not see it. An identity a helper receives from a call rather than
 * as a written-out literal — `redisGet(redis, definition, label('fixed'))` —
 * is not read through, so the helper form does not see that. The scope is what
 * makes both survivable: each is a lost warning, not a lost isolation.
 */

/** The method a key-registry entry publishes to mint its key. */
const KEY_BUILDER = 'buildKey';

const MESSAGE =
  'A key a test hands to Redis must take its identity from a value this run minted, never a ' +
  'literal: a literal names the same key in every run and in every other suite in this one. ' +
  'Build it from a random identity (a fresh uuid, a factory-created row).';

/**
 * Where a registry helper's identity arguments begin: the index of the rest
 * parameter it spreads into `buildKey`. Stated for every helper so one added to
 * the registry must be classified here rather than defaulting into either
 * answer, and pinned by the colocated test against the declarations
 * themselves — a signature that gains an argument fails that pin instead of
 * shifting this reading silently.
 *
 * `redisMGet` is the one helper taking no identity: it takes entries, each
 * built by `redisMGetEntry`, which this rule reads in its own right.
 */
export const IDENTITY_ARGUMENTS_FROM: Readonly<Record<RedisRegistryOperation, number | undefined>> =
  {
    redisDel: 2,
    redisGet: 2,
    redisGetDel: 2,
    redisMGet: undefined,
    redisMGetEntry: 1,
    redisSet: 3,
    redisSetNx: 3,
    redisTtl: 2,
  };

function isRegistryOperation(name: string): name is RedisRegistryOperation {
  return (REDIS_REGISTRY_OPERATIONS as readonly string[]).includes(name);
}

/** Where this call's identity arguments begin, for a call to a registry helper. */
function registryIdentitiesFrom(call: CallExpression): number | undefined {
  const callee = call.getExpression();
  if (!Node.isIdentifier(callee)) return undefined;
  const name = callee.getText();
  return isRegistryOperation(name) ? IDENTITY_ARGUMENTS_FROM[name] : undefined;
}

/** A literal argument: a written-out string or number, template holes included as literal. */
function isLiteralIdentity(node: TsNode): boolean {
  return (
    Node.isStringLiteral(node) ||
    Node.isNumericLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node)
  );
}

/**
 * The key-builder calls standing in one argument. The argument itself counts:
 * `redis.get(definition.buildKey(id))` puts the builder call in the argument
 * position, where a descendant walk alone misses it.
 */
function keyBuilderCalls(argument: TsNode): CallExpression[] {
  const nested = argument.getDescendantsOfKind(SyntaxKind.CallExpression);
  const candidates = Node.isCallExpression(argument) ? [argument, ...nested] : nested;
  return candidates.filter((candidate) => calledMember(candidate)?.name === KEY_BUILDER);
}

/** The literal identities one call carries, read the way that call spells its key. */
function literalIdentitiesOf(call: CallExpression): TsNode[] {
  const member = calledMember(call);
  if (member !== undefined) {
    return receiverTailNamesRedis(member.receiver)
      ? call
          .getArguments()
          .flatMap((argument) => keyBuilderCalls(argument))
          .flatMap((builder) =>
            builder.getArguments().filter((identity) => isLiteralIdentity(identity))
          )
      : [];
  }
  const from = registryIdentitiesFrom(call);
  return from === undefined
    ? []
    : call
        .getArguments()
        .slice(from)
        .filter((identity) => isLiteralIdentity(identity));
}

function literalIdentities(sourceFile: SourceFile): ArchViolation[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .flatMap((call) => literalIdentitiesOf(call))
    .map((identity) => ({
      file: sourceFile.getFilePath(),
      line: identity.getStartLineNumber(),
      message: MESSAGE,
    }));
}

const rule: ArchRule = {
  name: 'test-redis-keys-take-no-literal-identity',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      if (!isTestFile(sourceFile.getFilePath())) continue;
      violations.push(...literalIdentities(sourceFile));
    }
    return violations;
  },
};

export default rule;
