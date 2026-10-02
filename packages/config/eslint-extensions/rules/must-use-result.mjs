/**
 * Vendored must-use-Result rule.
 *
 * neverthrow's whole value is the typed error channel; a Result returned by a
 * call and then discarded swallows that channel silently. The community
 * must-use forks peer-require ESLint >= 10 while this repo is on 9, so the
 * single rule is vendored here.
 *
 * Detection is type-aware: a CallExpression whose TypeScript type (or any
 * union member, or the type's alias) is named Result/ResultAsync/Ok/Err is
 * "must use". The value counts as discarded only when it ends up in
 * statement position — assignment, return, argument position, member-chain
 * receivers, and arrow bodies all consume it. `void result()` is still a
 * violation: the escape hatch for an intentionally ignored Result is an
 * explicit assignment or .match().
 *
 * The rule self-scopes by absolute filename (default: the whole API source
 * tree) instead of relying on config `files` globs, because flat-config
 * glob base paths differ per consuming package while context.filename is
 * always absolute. The rule carries no test-file exemption of its own: a
 * discarded Result in a test is a test that passes whether the call succeeded
 * or failed, which is the false green this rule exists to prevent.
 * Parser services come from context.sourceCode.parserServices so the rule
 * has zero dependencies.
 */

const RESULT_TYPE_NAMES = new Set(['Result', 'ResultAsync', 'Ok', 'Err']);
const DEFAULT_FILES = String.raw`/apps/api/src/.*\.tsx?$`;

/**
 * A node in the parent chain, typed by the shape this climb reads rather than
 * as an ESTree node: the TypeScript parser inserts wrapper kinds ESTree does
 * not name, and comparing against one of those is an error on the ESTree union.
 *
 * @typedef {{ readonly type: string, readonly parent?: ChainNode | null, readonly operator?: string, readonly expressions?: readonly ChainNode[] }} ChainNode
 */

/**
 * Climbs transparent wrappers; true when the value dead-ends in statement position.
 * @param {ChainNode} node
 */
// eslint-disable-next-line complexity -- one exhaustive parent-kind dispatch; splitting it would hide which kinds are transparent
function isDiscarded(node) {
  let current = node;
  let parent = current.parent;
  while (parent) {
    switch (parent.type) {
      case 'AwaitExpression':
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression': {
        current = parent;
        parent = parent.parent;
        continue;
      }
      case 'UnaryExpression': {
        if (parent.operator === 'void') {
          current = parent;
          parent = parent.parent;
          continue;
        }
        return false;
      }
      case 'SequenceExpression': {
        // A non-final position in a comma expression is always discarded.
        // The switch discriminant establishes the member the shape declares as
        // optional, which a non-discriminated typedef cannot carry.
        const expressions = /** @type {readonly ChainNode[]} */ (parent.expressions);
        if (expressions.at(-1) !== current) return true;
        current = parent;
        parent = parent.parent;
        continue;
      }
      case 'ExpressionStatement': {
        return true;
      }
      default: {
        return false;
      }
    }
  }
  return false;
}

/**
 * @param {import('typescript').Type} type
 * @returns {boolean}
 */
function isResultType(type) {
  if (type.aliasSymbol && RESULT_TYPE_NAMES.has(type.aliasSymbol.getName())) return true;
  const symbol = type.getSymbol();
  if (symbol && RESULT_TYPE_NAMES.has(symbol.getName())) return true;
  if (type.isUnion()) return type.types.some((member) => isResultType(member));
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every Result/ResultAsync returned by a call to be consumed; a discarded Result silently swallows its error channel.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          files: {
            type: 'string',
            description:
              'Regex matched against the absolute filename; non-matching files are skipped.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      mustUse:
        'This call returns a Result that is discarded — assign, return, or .match() it; a dropped Result swallows its error.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const scope = new RegExp(context.options[0]?.files ?? DEFAULT_FILES);
    const filename = context.filename.replaceAll('\\', '/');
    if (!scope.test(filename)) return {};

    const services = context.sourceCode.parserServices;
    if (!services?.program || !services.esTreeNodeToTSNodeMap) {
      throw new Error(
        'must-use-result requires type-aware linting (parserOptions.project or projectService) for files in its scope'
      );
    }
    const checker = services.program.getTypeChecker();

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'CallExpression' }>} node */
      CallExpression(node) {
        if (!isDiscarded(node)) return;
        const tsNode = services.esTreeNodeToTSNodeMap.get(node);
        const type = checker.getTypeAtLocation(tsNode);
        if (isResultType(type)) {
          context.report({ node, messageId: 'mustUse' });
        }
      },
    };
  },
};
