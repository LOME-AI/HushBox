import { Node, SyntaxKind } from 'ts-morph';
import { failWith, isTestFile, relativePath } from '../lib/paths.js';
import { calledMember, receiverTailNamesRedis } from '../lib/redis-calls.js';
import type { CallExpression, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Redis keys exist only as typed key-registry entries — schema + TTL +
 * buildKey (CODE-RULES §Registries). A key written at the call site has none
 * of the three: nothing declares what the stored value must parse as, nothing
 * bounds its lifetime, and the template exists in as many copies as there are
 * callers, so a rename reaches some of them and leaves the rest reading a key
 * nobody writes.
 *
 * ONLY ONE SPECIES OF THIS DOCTRINE WAS GATED before this rule:
 * `rate-limit-keys-use-the-primitive` refuses a registry entry that mints a
 * `ratelimit:` key, which is a rule about WHICH mechanism owns a namespace. It
 * says nothing about a key that reaches Redis without passing a registry entry
 * at all, and that is the shape here.
 *
 * WHAT IT REFUSES: the first argument of a Redis client call resolving to text
 * written in the source — a string literal, a template, or a concatenation of
 * either — rather than to an expression. The test is on the WRITTEN-ness of the
 * key, not on the shape of what replaces it: asserting positively that the
 * argument is a `buildKey(…)` call would refuse the several legitimate
 * spellings a key reaches a call through (a limit definition's own key builder,
 * a mapped list of built keys, a page of keys a scan returned), and the pressure
 * to widen that list back out is how a positive test becomes a list of accepted
 * call sites.
 *
 * The key is the FIRST argument for every keyed command the client publishes,
 * so the classification this rule makes is of the commands whose first argument
 * is NOT a key — {@link NON_KEY_FIRST_ARGUMENT}. That list is default-CLOSED: a
 * command it does not name is checked, so a client method added tomorrow enters
 * the rule's view rather than its exemptions.
 *
 * A first argument that is an array literal is read element by element, because
 * the Lua seam passes its KEYS through one (`createScript(…).exec(keys, args)`)
 * and a key written into that array is written just as hard as one written
 * inline.
 *
 * WHAT IT DOES NOT SEE. Representative rather than exhaustive — this is
 * syntactic analysis over source text:
 * - A key assembled by a function (`buildMyKey(id)` returning a template). The
 *   rule reads where the text is written, and there it is written inside a
 *   builder; the doctrine wants that builder to be a registry entry, and no
 *   syntax distinguishes one bare builder from another.
 * - A key carried across a function boundary. Resolution follows file-local
 *   bindings by NAME, the same reach `no-lossy-counter-gate` declares, so a key
 *   handed to a helper and used there breaks the chain.
 * - A key reached off a receiver whose trailing name does not contain "redis",
 *   a command named by a computed index (`redis[name](key)`), or a client the
 *   call site obtains from a bare factory call (`getClient().get(key)`), which
 *   names nothing this can read a receiver off.
 * - The `match` pattern of a scan, which is a key GLOB rather than a key —
 *   written text that names a namespace instead of addressing a value, so
 *   gating it would need a rule about namespaces rather than about keys.
 */

const RULE = 'redis-keys-come-from-the-registry';
const fail = failWith(RULE);

/**
 * The one tree holding a Redis client. The Durable Objects reach Redis through
 * capabilities this Worker composes and injects, so their own package declares
 * no client call for a rule to read.
 */
const API_SOURCE_TREE = 'apps/api/src/';

/**
 * Client methods whose FIRST argument is not a key: `scan` takes a cursor, and
 * the three script entry points take the Lua source. Named because their first
 * argument is legitimately written text — every other method is checked.
 */
const NON_KEY_FIRST_ARGUMENT = new Set(['scan', 'eval', 'evalsha', 'createscript']);

const MESSAGE =
  'a Redis key written at the call site — keys exist only as typed key-registry entries (schema + TTL + buildKey), so declare it with `defineKey` and pass its `buildKey(...)`.';

function isInScope(filePath: string): boolean {
  return filePath.includes(API_SOURCE_TREE) && !isTestFile(filePath);
}

/**
 * The expression a name ultimately stands for, following file-local `const`
 * bindings. Cycles cannot occur in a well-formed initializer chain, but the
 * visited set keeps a malformed one from spinning.
 */
function resolveBinding(node: Node, sourceFile: SourceFile, visited: Set<string>): Node {
  if (!Node.isIdentifier(node)) return node;
  const name = node.getText();
  if (visited.has(name)) return node;
  visited.add(name);
  const declaration = sourceFile
    .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .find((candidate) => candidate.getName() === name);
  const initializer = declaration?.getInitializer();
  return initializer === undefined ? node : resolveBinding(initializer, sourceFile, visited);
}

/** Text written into the source: a string, a template, or a concatenation of them. */
function isWrittenText(node: Node, sourceFile: SourceFile): boolean {
  const resolved = resolveBinding(node, sourceFile, new Set());
  if (
    Node.isStringLiteral(resolved) ||
    Node.isNoSubstitutionTemplateLiteral(resolved) ||
    Node.isTemplateExpression(resolved)
  ) {
    return true;
  }
  if (Node.isBinaryExpression(resolved) && resolved.getOperatorToken().getText() === '+') {
    return (
      isWrittenText(resolved.getLeft(), sourceFile) ||
      isWrittenText(resolved.getRight(), sourceFile)
    );
  }
  return false;
}

/**
 * The key positions the first argument holds: itself, or every element of a key
 * array. A spread inside that array is opened once, because the Lua seam's key
 * list is routinely built as `[...keys]` and the keys are what this reads.
 */
function keyExpressions(argument: Node, sourceFile: SourceFile): Node[] {
  const resolved = resolveBinding(argument, sourceFile, new Set());
  if (!Node.isArrayLiteralExpression(resolved)) return [argument];
  return resolved.getElements().flatMap((element) => {
    if (!Node.isSpreadElement(element)) return [element];
    const spread = resolveBinding(element.getExpression(), sourceFile, new Set());
    return Node.isArrayLiteralExpression(spread) ? spread.getElements() : [element.getExpression()];
  });
}

/** A Redis client call: where it is, and which command it names. */
interface ClientCall {
  readonly call: CallExpression;
  readonly command: string;
  readonly sourceFile: SourceFile;
}

function writtenKeyIn({ call, command, sourceFile }: ClientCall): boolean {
  if (NON_KEY_FIRST_ARGUMENT.has(command.toLowerCase())) return false;
  const [first] = call.getArguments();
  if (first === undefined) return false;
  return keyExpressions(first, sourceFile).some((key) => isWrittenText(key, sourceFile));
}

/** Every Redis client call in scope: the rule's subject set, counted so it cannot empty out. */
function clientCalls(project: Project): ClientCall[] {
  const calls: ClientCall[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    if (!isInScope(relativePath(sourceFile))) continue;
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const member = calledMember(call);
      if (member !== undefined && receiverTailNamesRedis(member.receiver)) {
        calls.push({ call, command: member.name, sourceFile });
      }
    }
  }
  return calls;
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    const calls = clientCalls(project);
    if (calls.length === 0) {
      fail(
        `found no Redis client call under '${API_SOURCE_TREE}', so it is standing over nothing. ` +
          'Either the tree moved, or the client is now reached by a spelling this rule does not read.'
      );
    }
    const violations: ArchViolation[] = [];
    for (const clientCall of calls) {
      if (!writtenKeyIn(clientCall)) continue;
      violations.push({
        file: relativePath(clientCall.sourceFile),
        line: clientCall.call.getStartLineNumber(),
        message: MESSAGE,
      });
    }
    return violations;
  },
};

export default rule;
