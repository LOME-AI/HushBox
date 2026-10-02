import path from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import { failWith, isRepoPath, isTestFile, relativePath, sourceFileAt } from '../lib/paths.js';
import { REPO_ROOT } from '../lib/source-scope.js';
import type {
  CallExpression,
  Expression,
  Project,
  SourceFile,
  Symbol as MorphSymbol,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A model's tool loop has ONE home: the shared tool-loop module holds the
 * tool-call cap, its floor and ceiling, and the relation between a node's steps
 * and its calls. The browser's hold, the server's hold and the run all read it,
 * so a second home is a second answer to how long a loop may run, and the hold
 * stops covering the run the moment the two disagree.
 *
 * Three clauses, each a shape a second home takes:
 *
 * - A `maxSteps` property in non-test source under `apps/` or `packages/`,
 *   whether keyed by an identifier, a string or shorthand, is set by a call into
 *   the home or by a read of another `maxSteps`. A call into the home is one
 *   whose callee resolves, through its imports, to a function the home module
 *   declares, with no numeric literal or arithmetic among its arguments, however
 *   parenthesized or asserted to a type. A read is a property read of
 *   `maxSteps`, or a binding of that name that is a parameter or a destructured
 *   read whose default, if any, passes this same test, or a local whose own
 *   initializer does. The node schema's field declaration is excepted: it
 *   declares the field, and bounds no loop.
 * - No non-test file under `apps/` or `packages/` other than the home declares a
 *   binding, a function, an object property or a class field whose name spells
 *   the tool-call cap, its floor or its ceiling, unless its value is a read of,
 *   or a call into, the home module. A local holding what the home answered is
 *   not a second answer; anything else is.
 * - The retired search cap's name appears nowhere under `apps/` or `packages/`,
 *   comments and tests included, outside this rule's own file and its test.
 *
 * "The home" is decided by resolution, never by spelling: a name counts only
 * when the symbol it binds leads, through every import and re-export, to a
 * declaration in the home module. A local function sharing a home function's
 * name, or an import the scanned tree cannot resolve, therefore counts as a
 * second home.
 *
 * Known limits: the cap clause is a name-based net, so a cap bound to an
 * unrelated name, or built from data at run time, passes. A `maxSteps`
 * parameter's default is checked, but the value a caller passes into it is not
 * traced.
 * Reach is the scanned source files, so a file type the harness does not load
 * is never read.
 */

const RULE = 'tool-loop-has-one-home';

export const TOOL_LOOP_HOME = 'packages/shared/src/affordability/tool-loop.ts';

const NODE_SCHEMA = 'packages/shared/src/workflow/workflow.ts';

const RETIRED_NAME = 'MAX_SEARCH_TOOL_CALLS';

const STEP_FIELD = 'maxSteps';

const OWN_FILES: readonly string[] = [
  'packages/config/arch/rules/tool-loop-has-one-home.rule.ts',
  'packages/config/arch/rules/tool-loop-has-one-home.rule.test.ts',
];

const SCOPED_TREES: readonly string[] = ['apps', 'packages'];

/** A name that spells the tool-call cap, its floor or its ceiling, in either word order. */
const CAP_NAME = /tool_?calls?_?(cap|ceil|floor|max)|(cap|max)_?tool_?calls?/i;

/** The operators that make a number of the file's own out of whatever they combine. */
const ARITHMETIC_OPERATORS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.PlusToken,
  SyntaxKind.MinusToken,
  SyntaxKind.AsteriskToken,
  SyntaxKind.AsteriskAsteriskToken,
  SyntaxKind.SlashToken,
  SyntaxKind.PercentToken,
]);

const fail: (message: string) => never = failWith(RULE);

function isUnderScopedTree(sourceFile: SourceFile): boolean {
  const filePath = sourceFile.getFilePath();
  return SCOPED_TREES.some((tree) => filePath.startsWith(`${path.join(REPO_ROOT, tree)}/`));
}

function isFile(sourceFile: SourceFile, repoPath: string): boolean {
  return isRepoPath(relativePath(sourceFile), repoPath);
}

function isNonTestSource(sourceFile: SourceFile): boolean {
  return isUnderScopedTree(sourceFile) && !isTestFile(sourceFile.getFilePath());
}

function violationAt(sourceFile: SourceFile, node: Node, message: string): ArchViolation {
  return { file: relativePath(sourceFile), line: node.getStartLineNumber(), message };
}

/** The declarations a symbol stands for, followed through every import and re-export. */
function declarationsOf(symbol: MorphSymbol | undefined): readonly Node[] {
  if (symbol === undefined) return [];
  const target = symbol.isAlias() ? symbol.getAliasedSymbol() : symbol;
  return target?.getDeclarations() ?? [];
}

function isInHome(declaration: Node): boolean {
  return isFile(declaration.getSourceFile(), TOOL_LOOP_HOME);
}

/** A property or member name as written, with a string or computed string key unquoted. */
function keyText(nameNode: Node): string | undefined {
  if (Node.isIdentifier(nameNode) || Node.isPrivateIdentifier(nameNode)) return nameNode.getText();
  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
    return nameNode.getLiteralText();
  }
  if (Node.isComputedPropertyName(nameNode)) return keyText(nameNode.getExpression());
  return undefined;
}

/** The value under any parentheses and type assertions, which leave it unchanged. */
function unwrapValue(expression: Expression): Expression {
  if (
    Node.isParenthesizedExpression(expression) ||
    Node.isAsExpression(expression) ||
    Node.isSatisfiesExpression(expression) ||
    Node.isTypeAssertion(expression)
  ) {
    return unwrapValue(expression.getExpression());
  }
  return expression;
}

/**
 * A number the file makes itself: a numeric literal, arithmetic, or a local
 * whose initializer is one of those.
 */
function isOwnNumber(expression: Expression, seen = new Set<Node>()): boolean {
  const inner = unwrapValue(expression);
  if (seen.has(inner)) return false;
  seen.add(inner);
  if (Node.isNumericLiteral(inner)) return true;
  if (Node.isPrefixUnaryExpression(inner)) return isOwnNumber(inner.getOperand(), seen);
  if (Node.isBinaryExpression(inner)) {
    return ARITHMETIC_OPERATORS.has(inner.getOperatorToken().getKind());
  }
  if (Node.isIdentifier(inner)) {
    return declarationsOf(inner.getSymbol()).some((declaration) => {
      if (!Node.isVariableDeclaration(declaration)) return false;
      const initializer = declaration.getInitializer();
      return initializer !== undefined && isOwnNumber(initializer, seen);
    });
  }
  return false;
}

/** A call whose callee resolves to a function the home declares, fed no number of its own. */
function isHomeCall(call: CallExpression): boolean {
  const calleeIsHome = declarationsOf(call.getExpression().getSymbol()).some(
    (declaration) => Node.isFunctionDeclaration(declaration) && isInHome(declaration)
  );
  return (
    calleeIsHome &&
    !call.getArguments().some((argument) => Node.isExpression(argument) && isOwnNumber(argument))
  );
}

/** A value read from, or computed by a call into, the home module. */
function isHomeDerived(initializer: Expression | undefined): boolean {
  if (initializer === undefined) return false;
  const inner = unwrapValue(initializer);
  if (Node.isCallExpression(inner)) return isHomeCall(inner);
  if (Node.isIdentifier(inner) || Node.isPropertyAccessExpression(inner)) {
    return declarationsOf(inner.getSymbol()).some((declaration) => isInHome(declaration));
  }
  return false;
}

/**
 * Whether every declaration a `maxSteps` binding resolves to is a read of
 * another `maxSteps`: a parameter or a destructured `maxSteps` whose default, if
 * it has one, is itself an accepted step count, or a local whose initializer is.
 * An unresolved binding fails.
 */
function isAcceptedStepBinding(symbol: MorphSymbol | undefined, seen: Set<Node>): boolean {
  const declarations = declarationsOf(symbol);
  return (
    declarations.length > 0 &&
    declarations.every((declaration) => {
      if (Node.isParameterDeclaration(declaration)) {
        const fallback = declaration.getInitializer();
        return fallback === undefined || isAcceptedStepCount(fallback, seen);
      }
      if (Node.isBindingElement(declaration)) {
        const key = declaration.getPropertyNameNode() ?? declaration.getNameNode();
        const fallback = declaration.getInitializer();
        return (
          keyText(key) === STEP_FIELD &&
          (fallback === undefined || isAcceptedStepCount(fallback, seen))
        );
      }
      if (Node.isVariableDeclaration(declaration)) {
        const initializer = declaration.getInitializer();
        return initializer !== undefined && isAcceptedStepCount(initializer, seen);
      }
      return false;
    })
  );
}

/** A read of another `maxSteps`, or a call into the home. */
function isAcceptedStepCount(initializer: Expression, seen = new Set<Node>()): boolean {
  const inner = unwrapValue(initializer);
  if (seen.has(inner)) return false;
  seen.add(inner);
  if (Node.isPropertyAccessExpression(inner)) return inner.getName() === STEP_FIELD;
  if (Node.isIdentifier(inner)) {
    return inner.getText() === STEP_FIELD && isAcceptedStepBinding(inner.getSymbol(), seen);
  }
  if (Node.isCallExpression(inner)) return isHomeCall(inner);
  return false;
}

function stepViolation(sourceFile: SourceFile, node: Node, written: string): ArchViolation {
  return violationAt(
    sourceFile,
    node,
    `maxSteps is set to '${written}'; derive it from ${TOOL_LOOP_HOME} or read another maxSteps`
  );
}

function stepCountViolations(sourceFile: SourceFile): ArchViolation[] {
  if (isFile(sourceFile, TOOL_LOOP_HOME) || isFile(sourceFile, NODE_SCHEMA)) return [];
  const assigned = sourceFile
    .getDescendantsOfKind(SyntaxKind.PropertyAssignment)
    .filter((assignment) => keyText(assignment.getNameNode()) === STEP_FIELD)
    .flatMap((assignment) => {
      const initializer = assignment.getInitializer();
      if (initializer === undefined || isAcceptedStepCount(initializer)) return [];
      return [stepViolation(sourceFile, assignment, initializer.getText())];
    });
  const shorthand = sourceFile
    .getDescendantsOfKind(SyntaxKind.ShorthandPropertyAssignment)
    .filter((assignment) => assignment.getName() === STEP_FIELD)
    .flatMap((assignment) =>
      isAcceptedStepBinding(assignment.getValueSymbol(), new Set())
        ? []
        : [stepViolation(sourceFile, assignment, assignment.getText())]
    );
  return [...assigned, ...shorthand];
}

interface CapCandidate {
  readonly declaration: Node;
  readonly name: string;
  readonly initializer: Expression | undefined;
}

function capViolations(sourceFile: SourceFile): ArchViolation[] {
  if (isFile(sourceFile, TOOL_LOOP_HOME)) return [];
  const valued: CapCandidate[] = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.PropertyDeclaration),
  ].flatMap((declaration) => {
    const name = keyText(declaration.getNameNode());
    return name === undefined
      ? []
      : [{ declaration, name, initializer: declaration.getInitializer() }];
  });
  const flaggedValues = valued.filter(
    ({ name, initializer }) => CAP_NAME.test(name) && !isHomeDerived(initializer)
  );
  const functions = sourceFile
    .getDescendantsOfKind(SyntaxKind.FunctionDeclaration)
    .flatMap((declaration) => {
      const name = declaration.getName();
      return name !== undefined && CAP_NAME.test(name)
        ? [{ declaration, name, initializer: undefined }]
        : [];
    });
  return [...flaggedValues, ...functions].map(({ declaration, name }) =>
    violationAt(
      sourceFile,
      declaration,
      `'${name}' declares the tool-call cap outside ${TOOL_LOOP_HOME}; import it from there`
    )
  );
}

function retiredNameViolations(sourceFile: SourceFile): ArchViolation[] {
  if (OWN_FILES.some((own) => isFile(sourceFile, own))) return [];
  const text = sourceFile.getFullText();
  const index = text.indexOf(RETIRED_NAME);
  if (index === -1) return [];
  return [
    {
      file: relativePath(sourceFile),
      line: sourceFile.getLineAndColumnAtPos(index).line,
      message: `${RETIRED_NAME} is retired; the tool-call cap is TOOL_CALL_CAP_MAX in ${TOOL_LOOP_HOME}`,
    },
  ];
}

const rule: ArchRule = {
  name: RULE,
  check(project: Project) {
    if (sourceFileAt(project, TOOL_LOOP_HOME) === undefined) {
      return fail(`'${TOOL_LOOP_HOME}' names no file in the scanned tree; move the rule with it.`);
    }
    return project
      .getSourceFiles()
      .filter((sourceFile) => isUnderScopedTree(sourceFile))
      .flatMap((sourceFile) => [
        ...(isNonTestSource(sourceFile)
          ? [...stepCountViolations(sourceFile), ...capViolations(sourceFile)]
          : []),
        ...retiredNameViolations(sourceFile),
      ]);
  },
};

export default rule;
