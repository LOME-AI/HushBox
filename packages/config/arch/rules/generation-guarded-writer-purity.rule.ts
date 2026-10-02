import { Node, SyntaxKind, VariableDeclarationKind } from 'ts-morph';
import { isTestFile, relativePath } from '../lib/paths.js';
import type {
  ArrowFunction,
  FunctionDeclaration,
  FunctionExpression,
  MethodDeclaration,
  Node as TsMorphNode,
  SourceFile,
} from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * THE SPECIES THIS REFUSES: a race between a synchronous state write and an
 * asynchronous decision about whether to make it — the shape a generation
 * counter exists to close. A load that has been superseded must be unable to
 * write module state on any path; that is only true while the write is a
 * single synchronous step gated by one check, because JavaScript never
 * preempts a synchronous function mid-execution — only an `await` opens a
 * window another generation can run inside.
 *
 * A GENERATION-GUARDED WRITER is a function whose first statement is a bare
 * early return comparing an operand against a module-level `let` with `!==`
 * or `!=` — `if (dropped !== startedAt) return;`, braced or not — and which
 * goes on to assign a module-level `let` directly, in its own scope. Being
 * synchronous is what makes that assignment atomic with the check: an
 * `async` writer can suspend at an `await` inserted anywhere after the guard,
 * during which a later generation can run and invalidate the very state the
 * check was meant to protect. So CLAUSE A refuses an `async` modifier on any
 * function matching that shape, wherever it sits in the scanned tree — the
 * check is structural, not tied to a name or a path.
 *
 * A DECIDER is any `async` function sharing a file with a generation-guarded
 * writer, other than a writer itself. CLAUSE B refuses a decider that assigns
 * a module-level `let` directly in its own scope. A decider may return a
 * value for the writer to apply once re-validated; writing state itself
 * bypasses the one gate that makes a superseded generation's effects inert,
 * wherever in its body — before or after its own awaits — that write sits.
 * SYNCHRONOUS helpers a writer calls are not deciders and are not checked:
 * a call made from inside the writer's own synchronous run cannot be
 * preempted, so its effects are exactly as atomic as the writer's own.
 *
 * WHAT THIS DOES NOT SEE. REPRESENTATIVE, NOT EXHAUSTIVE — this is syntactic
 * analysis over source text, so the set of spellings is unbounded and no list
 * can close it.
 * - Decider tracing is FILE-LOCAL: an async function in a different file from
 *   the writer it feeds is invisible to Clause B.
 * - A write is DIRECT-ASSIGNMENT-ONLY: `x = …`, `x += …`, `x++`/`x--` on an
 *   identifier naming a module `let`. A write reached through a mutated
 *   object property, a helper function, or a closure alias is not read as
 *   one.
 * - The generation guard is read only as a `!==`/`!=` comparison against a
 *   module `let`, as the function's FIRST statement, with a bare `return`
 *   (no expression) as its entire consequent and no `else`. A guard spelled
 *   any other way — a positive check, a `switch`, a guard that is not the
 *   first statement — is invisible to Clause A, and a function it does not
 *   recognize as a writer at all is also invisible to Clause A (though it may
 *   still be classified a decider by Clause B).
 */

type FunctionLike = ArrowFunction | FunctionDeclaration | FunctionExpression | MethodDeclaration;

const WRITER_MESSAGE =
  'a generation-guarded state writer must stay synchronous — an `await` here reopens the window the generation check exists to close: a continuation belonging to a dropped generation could still reach the write.';

const DECIDER_MESSAGE =
  "an async function sharing a file with a generation-guarded writer must stay effect-free — it may return a value for the writer to apply, but writing module state itself bypasses the writer's generation check, which is the one gate that makes a dropped generation's effects inert.";

function functionsIn(sourceFile: SourceFile): FunctionLike[] {
  return [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionExpression),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
  ];
}

/** Names of every module-level `let` — the mutable state a generation guard protects. */
function moduleLets(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.getVariableStatements()) {
    if (statement.getDeclarationKind() !== VariableDeclarationKind.Let) continue;
    for (const declaration of statement.getDeclarations()) {
      names.add(declaration.getName());
    }
  }
  return names;
}

/** The nearest enclosing function-like node, or `undefined` at module scope. */
function owningFunction(node: TsMorphNode): FunctionLike | undefined {
  let current = node.getParent();
  while (current !== undefined) {
    if (
      Node.isFunctionDeclaration(current) ||
      Node.isFunctionExpression(current) ||
      Node.isArrowFunction(current) ||
      Node.isMethodDeclaration(current)
    ) {
      return current;
    }
    current = current.getParent();
  }
  /* v8 ignore next -- @preserve unreachable: both call sites pass a node found by
     searching a writer's own body, so `function_` is always an ancestor in the
     parent chain and the walk above always returns before exhausting it. */
  return undefined;
}

function isAssignmentOperator(kind: SyntaxKind): boolean {
  return kind >= SyntaxKind.FirstAssignment && kind <= SyntaxKind.LastAssignment;
}

const STEP_UNARIES = new Set<SyntaxKind>([SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken]);

function directBinaryLetWrites(
  function_: FunctionLike,
  body: TsMorphNode,
  letNames: ReadonlySet<string>
): TsMorphNode[] {
  const writes: TsMorphNode[] = [];
  for (const binary of body.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (!isAssignmentOperator(binary.getOperatorToken().getKind())) continue;
    if (owningFunction(binary) !== function_) continue;
    const target = binary.getLeft();
    if (Node.isIdentifier(target) && letNames.has(target.getText())) writes.push(binary);
  }
  return writes;
}

function directUnaryLetWrites(
  function_: FunctionLike,
  body: TsMorphNode,
  letNames: ReadonlySet<string>
): TsMorphNode[] {
  const writes: TsMorphNode[] = [];
  const unaries = [
    ...body.getDescendantsOfKind(SyntaxKind.PostfixUnaryExpression),
    ...body.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression),
  ];
  for (const unary of unaries) {
    if (!STEP_UNARIES.has(unary.getOperatorToken())) continue;
    if (owningFunction(unary) !== function_) continue;
    const operand = unary.getOperand();
    if (Node.isIdentifier(operand) && letNames.has(operand.getText())) writes.push(unary);
  }
  return writes;
}

/** Every direct (own-scope, not through a nested function) write to a module `let`. */
function directModuleLetWrites(
  function_: FunctionLike,
  letNames: ReadonlySet<string>
): TsMorphNode[] {
  const body = function_.getBody();
  if (body === undefined) return [];
  return [
    ...directBinaryLetWrites(function_, body, letNames),
    ...directUnaryLetWrites(function_, body, letNames),
  ];
}

/** `return;` alone, or a block containing exactly one bare `return;`. */
function isBareReturn(statement: TsMorphNode): boolean {
  if (Node.isReturnStatement(statement)) return statement.getExpression() === undefined;
  if (Node.isBlock(statement)) {
    const statements = statement.getStatements();
    const [only] = statements;
    return (
      statements.length === 1 && Node.isReturnStatement(only) && only.getExpression() === undefined
    );
  }
  return false;
}

const NOT_EQUAL_OPERATORS = new Set<SyntaxKind>([
  SyntaxKind.ExclamationEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
]);

/** `if (<operand> !== <moduleLet>) return;` in either operand order, no `else`. */
function isGenerationGuard(condition: TsMorphNode, letNames: ReadonlySet<string>): boolean {
  if (!Node.isBinaryExpression(condition)) return false;
  if (!NOT_EQUAL_OPERATORS.has(condition.getOperatorToken().getKind())) return false;
  const left = condition.getLeft();
  const right = condition.getRight();
  return (
    (Node.isIdentifier(left) && letNames.has(left.getText())) ||
    (Node.isIdentifier(right) && letNames.has(right.getText()))
  );
}

/** Whether `function_`'s first statement is a generation guard AND it writes a module `let` directly. */
function isGenerationGuardedWriter(
  function_: FunctionLike,
  letNames: ReadonlySet<string>
): boolean {
  const body = function_.getBody();
  if (body === undefined || !Node.isBlock(body)) return false;
  const [first] = body.getStatements();
  if (first === undefined || !Node.isIfStatement(first)) return false;
  if (first.getElseStatement() !== undefined) return false;
  if (!isGenerationGuard(first.getExpression(), letNames)) return false;
  if (!isBareReturn(first.getThenStatement())) return false;
  return directModuleLetWrites(function_, letNames).length > 0;
}

function isAsyncFunction(function_: FunctionLike): boolean {
  return Node.isAsyncable(function_) && function_.isAsync();
}

function writerViolations(writers: readonly FunctionLike[], filePath: string): ArchViolation[] {
  return writers
    .filter((writer) => isAsyncFunction(writer))
    .map((writer) => ({
      file: filePath,
      line: writer.getStartLineNumber(),
      message: WRITER_MESSAGE,
    }));
}

function deciderViolations(
  functions: readonly FunctionLike[],
  writerSet: ReadonlySet<FunctionLike>,
  letNames: ReadonlySet<string>,
  filePath: string
): ArchViolation[] {
  return functions
    .filter((function_) => !writerSet.has(function_))
    .filter((function_) => isAsyncFunction(function_))
    .filter((function_) => directModuleLetWrites(function_, letNames).length > 0)
    .map((function_) => ({
      file: filePath,
      line: function_.getStartLineNumber(),
      message: DECIDER_MESSAGE,
    }));
}

function violationsIn(sourceFile: SourceFile): ArchViolation[] {
  const filePath = relativePath(sourceFile);
  if (isTestFile(filePath)) return [];
  const letNames = moduleLets(sourceFile);
  if (letNames.size === 0) return [];

  const functions = functionsIn(sourceFile);
  const writers = functions.filter((function_) => isGenerationGuardedWriter(function_, letNames));
  if (writers.length === 0) return [];
  const writerSet = new Set<FunctionLike>(writers);

  return [
    ...writerViolations(writers, filePath),
    ...deciderViolations(functions, writerSet, letNames, filePath),
  ];
}

const rule: ArchRule = {
  name: 'generation-guarded-writer-purity',
  check(project) {
    return project.getSourceFiles().flatMap((sourceFile) => violationsIn(sourceFile));
  },
};

export default rule;
