import { Node, SyntaxKind } from 'ts-morph';
import { isTestFile } from '../lib/paths.js';
import type { CallExpression, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A test that starts a Vite server names the server's dependency cache in the call.
 *
 * Without one, Vite puts the cache in the nearest package's `node_modules/.vite`. A server
 * that starts on a cache another running server optimized with a different config, which a
 * different root alone makes it, deletes that cache's pre-bundled dependencies at startup,
 * and the running server answers 504 "Outdated Optimize Dep" for every one it had not yet
 * served until it restarts. A browser test rooted inside an app shares that app's default
 * with everything else started there, the other tests of the same run included.
 *
 * The rule asks for the hazard's absence, not for a particular helper: a `cacheDir` written
 * in the call's inline config passes, wherever it points. A config that is not an inline
 * object literal shows no `cacheDir`, so it is reported rather than trusted.
 *
 * Production code is out of scope: a dev server a package runs for itself owns its default.
 */

const MESSAGE =
  'A test that starts a Vite server names its cacheDir in the inline config — without one it ' +
  "shares its package's default cache and deletes a running server's pre-bundled " +
  'dependencies. Start it through a fixture-server helper that owns a private cache, or ' +
  'pass cacheDir.';

const VITE = 'vite';
const CREATE_SERVER = 'createServer';

/** The local names that call Vite's `createServer`, and the namespaces that carry it. */
function viteBindings(sourceFile: SourceFile): { direct: Set<string>; namespaces: Set<string> } {
  const direct = new Set<string>();
  const namespaces = new Set<string>();
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.getModuleSpecifierValue() !== VITE) continue;
    const namespace = declaration.getNamespaceImport();
    if (namespace !== undefined) namespaces.add(namespace.getText());
    for (const specifier of declaration.getNamedImports()) {
      if (specifier.getName() !== CREATE_SERVER) continue;
      direct.add(specifier.getAliasNode()?.getText() ?? CREATE_SERVER);
    }
  }
  return { direct, namespaces };
}

function callsViteCreateServer(
  call: CallExpression,
  bindings: { direct: Set<string>; namespaces: Set<string> }
): boolean {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return bindings.direct.has(callee.getText());
  if (Node.isPropertyAccessExpression(callee)) {
    return (
      callee.getName() === CREATE_SERVER &&
      bindings.namespaces.has(callee.getExpression().getText())
    );
  }
  return false;
}

function namesCacheDir(call: CallExpression): boolean {
  const config = call.getArguments()[0];
  if (config === undefined || !Node.isObjectLiteralExpression(config)) return false;
  return config.getProperty('cacheDir') !== undefined;
}

function unnamedCaches(sourceFile: SourceFile): ArchViolation[] {
  const bindings = viteBindings(sourceFile);
  if (bindings.direct.size === 0 && bindings.namespaces.size === 0) return [];
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => callsViteCreateServer(call, bindings) && !namesCacheDir(call))
    .map((call) => ({
      file: sourceFile.getFilePath(),
      line: call.getStartLineNumber(),
      message: MESSAGE,
    }));
}

const rule: ArchRule = {
  name: 'test-vite-servers-name-their-cache',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      if (!isTestFile(sourceFile.getFilePath())) continue;
      violations.push(...unnamedCaches(sourceFile));
    }
    return violations;
  },
};

export default rule;
