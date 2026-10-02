import { Node, SyntaxKind } from 'ts-morph';
import { isTestFile } from '../lib/paths.js';
import type { CallExpression, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Exactly one Hono `.onError()` handler exists in the app tree, and it lives
 * in `app.ts` (audit fix F19). Error mapping is owned by the assembly: a
 * defect must answer with the same `{code: INTERNAL}` shape everywhere, so a
 * sub-router installing its own `onError` would fork error handling and drop
 * the telemetry the assembly's handler emits.
 *
 * Matching is deliberately narrow — `onError` appears in four unrelated
 * forms, and only the first is a handler installation:
 *   1. the Hono method call `app.onError((error, c) => …)` — a CallExpression
 *      whose callee is a `.onError` PropertyAccessExpression ON A RECEIVER
 *      THAT RESOLVES TO A HONO APP. COUNTED.
 *   2. the workflow DAG node's error policy `onError: 'skip' | 'fail'` — a
 *      PropertyAssignment. Never a CallExpression callee, so never matched.
 *   3. the AI-SDK streamText option `onError: noopOnError` — likewise a
 *      PropertyAssignment. Never matched.
 *   4. an injected callback invoked as `deps.onError?.(id, error)` — a
 *      CallExpression with a `.onError` callee, indistinguishable from form 1
 *      by name. The receiver is what separates them.
 * Iterating CallExpressions and testing the callee keeps forms 2 and 3 out by
 * construction (they are object-literal members, not call callees); form 4 is
 * kept out by resolving the receiver.
 *
 * Receiver resolution is syntactic and same-file: a receiver counts as Hono
 * when its expression chain bottoms out in `new Hono(...)` — directly, through
 * a local `const` alias, or through a wrapper that takes the app as an
 * argument, which is the shape `applyPipeline(root, …).use(…).onError(…)` in
 * `app.ts` has. A name-only match is not sufficient in either direction: it
 * reported two plain callbacks in `packages/realtime` as handler installs, and
 * any file is one `deps.onError` away from the same misfire.
 *
 * Test files are exempt — they build throwaway Hono apps with their own
 * `onError` to assert error mapping in isolation. `app.ts` is always in the
 * harness scope, so the missing-handler check anchors on it; if it is somehow
 * absent, only sub-router installs are reported.
 */

function isInScope(filePath: string): boolean {
  return !isTestFile(filePath);
}

function isAppTs(filePath: string): boolean {
  return filePath.endsWith('apps/api/src/app.ts');
}

/** Local names the Hono class is bound to, including the bare imported name. */
function honoClassNames(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    const specifier = importDeclaration.getModuleSpecifierValue();
    if (specifier !== 'hono' && !specifier.startsWith('hono/')) continue;
    for (const specifier of importDeclaration.getNamedImports()) {
      if (specifier.getName() === 'Hono') {
        names.add((specifier.getAliasNode() ?? specifier.getNameNode()).getText());
      }
    }
  }
  return names;
}

/**
 * Whether an expression bottoms out in a Hono app: the construction itself, a
 * builder chain over one, a wrapper called with one, or a known local alias.
 */
function isHonoRooted(expression: Node, classNames: Set<string>, appNames: Set<string>): boolean {
  if (Node.isNewExpression(expression)) {
    const callee = expression.getExpression();
    return Node.isIdentifier(callee) && classNames.has(callee.getText());
  }
  if (Node.isCallExpression(expression)) {
    return (
      isHonoRooted(expression.getExpression(), classNames, appNames) ||
      expression.getArguments().some((argument) => isHonoRooted(argument, classNames, appNames))
    );
  }
  if (Node.isPropertyAccessExpression(expression)) {
    return isHonoRooted(expression.getExpression(), classNames, appNames);
  }
  return Node.isIdentifier(expression) && appNames.has(expression.getText());
}

/**
 * Parameters annotated as a Hono app — the `applyPipeline(app: Hono<AppEnv>, …)`
 * shape, where an install would sit in the wrapper rather than on a
 * construction.
 */
function honoTypedParameters(sourceFile: SourceFile, classNames: Set<string>): Set<string> {
  const names = new Set<string>();
  for (const parameter of sourceFile.getDescendantsOfKind(SyntaxKind.Parameter)) {
    const typeNode = parameter.getTypeNode();
    if (typeNode === undefined || !Node.isTypeReference(typeNode)) continue;
    if (classNames.has(typeNode.getTypeName().getText())) names.add(parameter.getName());
  }
  return names;
}

/**
 * Fixed point over `const app = <hono-rooted expression>` chains.
 *
 * Declarations are gathered by descendant walk, not `getVariableDeclarations()`
 * — that returns top-level declarations only, and the assembly builds its app
 * inside a factory function, so the sole real handler in the repo was invisible
 * to a top-level-only lookup.
 */
function variableAliases(
  sourceFile: SourceFile,
  classNames: Set<string>,
  names: Set<string>
): void {
  const declarations = sourceFile.getDescendantsOfKind(SyntaxKind.VariableDeclaration);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      const initializer = declaration.getInitializer();
      if (initializer === undefined || names.has(declaration.getName())) continue;
      if (isHonoRooted(initializer, classNames, names)) {
        names.add(declaration.getName());
        changed = true;
      }
    }
  }
}

/** Every local name bound to a Hono app. */
function honoAppNames(sourceFile: SourceFile, classNames: Set<string>): Set<string> {
  const names = honoTypedParameters(sourceFile, classNames);
  variableAliases(sourceFile, classNames, names);
  return names;
}

/** Every `<hono app>.onError(...)` method-call site in a file (form 1 above). */
function onErrorHandlerCalls(sourceFile: SourceFile): CallExpression[] {
  const classNames = honoClassNames(sourceFile);
  if (classNames.size === 0) return [];
  const appNames = honoAppNames(sourceFile, classNames);
  const calls: CallExpression[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'onError') return;
    if (isHonoRooted(callee.getExpression(), classNames, appNames)) {
      calls.push(node);
    }
  });
  return calls;
}

/** A sub-router (any file but app.ts) may not install onError. */
function subRouterViolations(filePath: string, calls: CallExpression[]): ArchViolation[] {
  return calls.map((call) => ({
    file: filePath,
    line: call.getStartLineNumber(),
    message:
      'Sub-routers must not install onError — error mapping is owned by app.ts (audit fix F19).',
  }));
}

/** app.ts must carry exactly one handler: none and more-than-one both fail. */
function appTsViolations(appTsFile: SourceFile, calls: CallExpression[]): ArchViolation[] {
  if (calls.length === 0) {
    return [
      {
        file: appTsFile.getFilePath(),
        line: 1,
        message: 'app.ts must install exactly one onError handler; found none.',
      },
    ];
  }
  return calls.slice(1).map((extra) => ({
    file: appTsFile.getFilePath(),
    line: extra.getStartLineNumber(),
    message: 'app.ts must install exactly one onError handler; found more than one.',
  }));
}

const rule: ArchRule = {
  name: 'onerror-handler-only-in-app',
  check(project) {
    const violations: ArchViolation[] = [];
    let appTsFile: SourceFile | undefined;
    const appTsCalls: CallExpression[] = [];

    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      if (!isInScope(filePath)) continue;
      const calls = onErrorHandlerCalls(sourceFile);
      if (isAppTs(filePath)) {
        appTsFile = sourceFile;
        appTsCalls.push(...calls);
      } else {
        violations.push(...subRouterViolations(filePath, calls));
      }
    }

    // app.ts is always in the harness scope; guard only for defensiveness.
    if (appTsFile !== undefined) {
      violations.push(...appTsViolations(appTsFile, appTsCalls));
    }
    return violations;
  },
};

export default rule;
