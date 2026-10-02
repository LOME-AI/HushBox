import { builtinModules } from 'node:module';
import path from 'node:path';
import { ts } from 'ts-morph';
import { moduleReferences } from '../lib/module-references.js';
import { REPO_ROOT, SCANNED_WORKSPACES } from '../lib/source-scope.js';
import type { FileSystemHost } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Every package a workspace imports must be declared in that workspace's own
 * `package.json`.
 *
 * Why this cannot be left to `knip`: knip treats a root-workspace dependency as
 * available to every nested workspace, so an import satisfied only by the root
 * declaration is invisible to it — not a per-instance miss but a structural
 * blind spot, measured at ~40 undeclared imports across 12 workspaces when this
 * rule was written. pnpm's node_modules layout makes those imports resolve
 * anyway, through a copy hoisted above the importer; the workspace still has no
 * declared edge, so its resolved version is whatever the root happens to pin,
 * and moving the package to a different install (or dropping the root
 * declaration) breaks it with no gate firing.
 *
 * The rule reads whole workspaces off the project's file system rather than the
 * project's parsed source files, because the layer's shared scope
 * (`lib/source-scope.ts`) is deliberately narrower than the question asked here:
 * it globs `<package>/src` for `.ts`/`.tsx` only, which excludes every
 * package-root config file — including `packages/config/eslint.config.js`, the
 * file whose thirteen undeclared plugin imports opened this. Widening the shared
 * scope would hand every other rule those files at once; a rule whose subject is
 * the workspace rather than the slice owns its own scope instead.
 */

/** Node's own modules, which resolve from the runtime and no manifest can declare. */
const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/**
 * Sections whose keys are a declared edge. All four count: the rule asks
 * whether the workspace declares the package at all, not how it depends on it.
 */
const MANIFEST_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * Trees excluded from every workspace, each with the reason it is out. All are
 * generated, installed or vendored — none holds authored module source, so an
 * import inside one says nothing about what the workspace depends on.
 *
 * `public` is here on measurement, not assumption: of the five app static
 * roots, only `apps/sandbox/public` holds any JavaScript at all, and that is a
 * minified esbuild bundle plus the downloaded Pyodide distribution.
 *
 * `__test-fixtures-*__` is the repository's existing spelling for a corpus that
 * is analysed as text and never executed. The directory NAME is the whole key —
 * matched as a path segment at any depth, with nothing of a file's content read
 * — so a corpus renamed out of this shape is scanned as workspace source. The
 * corpora are self-describing counter-examples: a fixture manifest declares
 * `@fixture/shared` and fixture modules import it while it exists in no
 * install, so that rename does not merely widen the scan, it turns a corpus
 * written to be undeclared into this rule's own violations.
 */
const EXCLUDED_TREES: Readonly<Record<string, string>> = {
  node_modules: 'Installed dependencies, not repository source.',
  dist: 'Build output.',
  'dist-ota': 'Build output — the mobile over-the-air bundle.',
  build: 'Build output.',
  coverage: 'Coverage report output.',
  '.turbo': 'Task-runner cache.',
  '.wrangler': 'Local Workers runtime state.',
  public: 'Static asset root: generated bundles and vendored distributions.',
  '__test-fixtures-*__': 'Fixture corpus — source text a test analyses, never code that runs.',
};

/**
 * The extensions parsed as module source. Every file this rule reads is handed
 * to the TypeScript parser, so a file type that is not TypeScript — `.astro`,
 * `.mdx` — is out.
 *
 * The bound is recorded because the class it admits is live, not hypothetical.
 * An import written only in such a file is invisible to this rule, so a
 * declaration nothing else imports can be dropped with the rule still passing.
 * Measured: `apps/marketing` is today the only workspace holding such files,
 * and its `lucide-static` dependency is imported from one of them and from no
 * file this rule reads in that workspace.
 */
const SOURCE_EXTENSIONS = 'ts,tsx,mts,cts,js,jsx,mjs,cjs';

/** One `package.json` glob per declared workspace pattern. */
function manifestGlobs(repoRoot: string): string[] {
  return SCANNED_WORKSPACES.map((pattern) => path.join(repoRoot, pattern, 'package.json'));
}

/** Every source file in one workspace, minus the declared-excluded trees. */
function sourceGlobs(workspaceDir: string): string[] {
  return [
    path.join(workspaceDir, `**/*.{${SOURCE_EXTENSIONS}}`),
    ...Object.keys(EXCLUDED_TREES).map((tree) => `!${path.join(workspaceDir, '**', tree, '**')}`),
  ];
}

interface Manifest {
  readonly name?: string;
  readonly [section: string]: unknown;
}

/** Every package name the manifest declares, in any of the four sections. */
function declaredPackages(manifest: Manifest): Set<string> {
  const declared = new Set<string>();
  for (const section of MANIFEST_SECTIONS) {
    const entries = manifest[section];
    if (typeof entries !== 'object' || entries === null) continue;
    for (const name of Object.keys(entries)) declared.add(name);
  }
  return declared;
}

/**
 * The package a specifier names, or `null` when it names none.
 *
 * A specifier carrying `:` is a runtime or build-tool module namespace
 * (`node:fs`, `cloudflare:workers`, `astro:content`). It can never be an npm
 * package, because npm names cannot contain `:` — so one rule covers every such
 * scheme, present and future, without an allowlist that has to be maintained.
 */
function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) return null;
  if (specifier.startsWith('#')) return null;
  if (specifier.includes(':')) return null;
  const segments = specifier.split('/');
  const name = segments.slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
  return NODE_BUILTINS.has(name) ? null : name;
}

/**
 * The `@types` package that carries a package's declarations. A type-only
 * import is erased before anything resolves at runtime, so the `@types` package
 * alone is a complete declaration for it — for a value import it is not.
 */
function typesPackageFor(packageName: string): string {
  return packageName.startsWith('@')
    ? `@types/${packageName.slice(1).replace('/', '__')}`
    : `@types/${packageName}`;
}

interface ImportSite {
  readonly specifier: string;
  readonly typeOnly: boolean;
  readonly line: number;
}

/**
 * Every specifier one file imports, in each form that binds a package at
 * runtime or at compile time — which forms those are is
 * {@link moduleReferences}' answer for the whole rule layer.
 *
 * A specifier that is not written out is passed over rather than reported: this
 * rule asks whether a NAMED package is declared, and a specifier assembled at
 * runtime names none it could look up. The walk enumerates it regardless, so the
 * skip is this rule's decision rather than a form it never saw.
 */
function importSites(sourceFile: ts.SourceFile): ImportSite[] {
  const sites: ImportSite[] = [];
  for (const { specifier, typeOnly, line } of moduleReferences(sourceFile)) {
    if (specifier !== undefined) sites.push({ specifier, typeOnly, line });
  }
  return sites;
}

/** Reads and parses one file; the extension decides whether JSX is legal syntax. */
function parse(fileSystem: FileSystemHost, filePath: string): ts.SourceFile {
  const scriptKind = filePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(
    filePath,
    fileSystem.readFileSync(filePath),
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
}

/**
 * The package one import site obliges the manifest to declare, or `null` when
 * it obliges nothing — the specifier names no package, names the workspace
 * itself, is already declared, or is type-only and covered by `@types`.
 */
function requiredPackage(
  site: ImportSite,
  manifest: Manifest,
  declared: ReadonlySet<string>
): string | null {
  const packageName = packageNameOf(site.specifier);
  if (packageName === null || packageName === manifest.name) return null;
  if (declared.has(packageName)) return null;
  if (site.typeOnly && declared.has(typesPackageFor(packageName))) return null;
  return packageName;
}

/**
 * The first undeclared import of each package in one workspace, keyed by
 * package name. One violation per package rather than per site: forty
 * repetitions of the same missing declaration would bury the other rules'
 * output, and the fix is one manifest line either way.
 */
function undeclaredIn(
  fileSystem: FileSystemHost,
  repoRoot: string,
  manifestPath: string
): ArchViolation[] {
  const workspaceDir = path.dirname(manifestPath);
  const manifest = JSON.parse(fileSystem.readFileSync(manifestPath)) as Manifest;
  const declared = declaredPackages(manifest);
  const workspaceName = manifest.name ?? path.relative(repoRoot, workspaceDir);
  const violations = new Map<string, ArchViolation>();

  const files = fileSystem
    .globSync(sourceGlobs(workspaceDir))
    .toSorted((a, b) => a.localeCompare(b));
  for (const filePath of files) {
    const sourceFile = parse(fileSystem, filePath);
    for (const site of importSites(sourceFile)) {
      const packageName = requiredPackage(site, manifest, declared);
      if (packageName === null || violations.has(packageName)) continue;
      violations.set(packageName, {
        file: path.relative(repoRoot, filePath),
        line: site.line,
        message: `${workspaceName} imports "${packageName}" but its own package.json declares it nowhere. Resolution succeeds today only because a hoisted copy sits higher in the tree.`,
      });
    }
  }
  return [...violations.values()];
}

const rule: ArchRule = {
  name: 'imports-declared-in-manifest',
  check(project) {
    const fileSystem = project.getFileSystem();
    return fileSystem
      .globSync(manifestGlobs(REPO_ROOT))
      .toSorted((a, b) => a.localeCompare(b))
      .flatMap((manifestPath) => undeclaredIn(fileSystem, REPO_ROOT, manifestPath));
  },
};

export default rule;
