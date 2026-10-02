import { moduleReferences } from '../lib/module-references.js';
import { isLocalSpecifier, isTestFile } from '../lib/paths.js';
import { WEB_SOURCE_TREE } from '../lib/source-scope.js';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Keeps E2E-only module variants (`*.e2e.ts`, e.g. the localStorage export-key
 * fallback `device-key-store.e2e.ts`) out of production web code entirely. That
 * store deliberately persists the OPAQUE export key as base64 in localStorage
 * so Playwright `storageState` can capture it — a plaintext-key path that must
 * never ship to real users.
 *
 * No source-level reference is permitted, static OR dynamic:
 *   - A static `import`/`export … from` would bundle the fallback into the
 *     production chunk.
 *   - A runtime dynamic `import()` is a cancellable network fetch; on the
 *     auth-bootstrap path a racing navigation aborts the chunk request, the
 *     import() rejects uncaught, and the router's CatchBoundary blanks the
 *     page. The variant is selected at BUILD time instead: the Vite resolver
 *     plugin (apps/web vite config + device-key-store-e2e-resolution) swaps the
 *     module id when the build bakes `VITE_E2E`, so the e2e build inlines the
 *     variant into the entry chunk and the production build never references it.
 *
 * Scope (production web code) excludes:
 *   - `*.e2e.*` module files themselves — sibling imports stay inside the
 *     isolated variant tier.
 *   - test files — they import e2e modules to test them in isolation.
 *   - everything outside `apps/web/src/`.
 */

/**
 * This rule watches the web tree; WHERE that tree is comes from the scope
 * layer, so the root cannot be narrowed here by retyping it.
 */
const WEB_SRC = WEB_SOURCE_TREE;
const E2E_MODULE_FILE = /\.e2e\.[cm]?[jt]sx?$/;

/** An e2e module reference: a relative/alias specifier whose basename ends in
 * `.e2e`, with an optional `.js`/`.ts` extension. */
const E2E_MODULE_SPECIFIER = /(^|\/)[^/]+\.e2e(\.[jt]s)?$/;

const MESSAGE =
  'Production code must not reference an E2E module variant (*.e2e) — neither a static ' +
  'import/re-export (which bundles it into the production chunk) nor a runtime dynamic ' +
  'import() (a cancellable chunk fetch that a racing navigation turns into an uncaught ' +
  'rejection). The variant is selected at build time by the Vite resolver plugin gated on ' +
  'the baked VITE_E2E env (see apps/web vite config), which is the only sanctioned path.';

/** Production web code: inside apps/web/src, not an e2e module or a test file. */
function isProductionWebFile(filePath: string): boolean {
  return filePath.includes(WEB_SRC) && !E2E_MODULE_FILE.test(filePath) && !isTestFile(filePath);
}

/** A relative (`.`) or `@/`-alias specifier resolving to an e2e module. */
function targetsE2eModule(specifier: string): boolean {
  return isLocalSpecifier(specifier) && E2E_MODULE_SPECIFIER.test(specifier);
}

/**
 * Every reference in the file whose specifier reaches an e2e variant.
 *
 * A specifier that is not written out is enumerated by the walk and passed over
 * here: a computed specifier cannot target a co-located e2e module without also
 * tripping the bundler's own resolution, so guessing at it would buy nothing.
 * That is this rule's decision about a form the walk cannot follow, not the
 * walk's — {@link moduleReferences} refuses to hide one either way.
 */
function e2eStoreImportViolations(sourceFile: SourceFile): ArchViolation[] {
  const filePath = sourceFile.getFilePath();
  return moduleReferences(sourceFile.compilerNode)
    .filter(({ specifier }) => specifier !== undefined && targetsE2eModule(specifier))
    .map(({ line }) => ({ file: filePath, line, message: MESSAGE }));
}

const rule: ArchRule = {
  name: 'e2e-store-isolation',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      if (!isProductionWebFile(sourceFile.getFilePath())) continue;
      violations.push(...e2eStoreImportViolations(sourceFile));
    }
    return violations;
  },
};

export default rule;
