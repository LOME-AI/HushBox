import path from 'node:path';
import { moduleReferences } from '../lib/module-references.js';
import { isTestFile } from '../lib/paths.js';
import { REPO_ROOT, discoverSourceTrees, workspaceSourceTree } from '../lib/source-scope.js';
import { MANIFEST_PATH, NODE_ONLY_DOORS } from './published-doors-stay-browser-safe.rule.js';
import type { Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The consumer half of {@link NODE_ONLY_DOORS}: a node-only door onto the
 * backend environment registry is named only from a tree that declares a
 * consumer of one, and every other tree is refused by default.
 *
 * The door rule that owns that list stands on the PRODUCER side — it walks each
 * published door's closure and refuses any door but a declared node-only one
 * from reaching the registry. That leaves the registry nameable, from anywhere
 * in the repository, by writing a declared door's own specifier: legal against
 * the door rule by construction, since the door is exempt there, and legal
 * against the boundaries perimeter, which is scoped to the api tree. This rule
 * is the other side of that same list.
 *
 * THE BANNED SET IS DERIVED, and both halves of the derivation say so when they
 * stop agreeing. It is one specifier per declared node-only door, spelled from
 * the package name and the subpath the manifest publishes it under, so:
 *
 * - a declared door the manifest no longer publishes throws
 *   ({@link unpublishedDoor}) — the derived specifier would ban a name nothing
 *   can write, which is a ban that reads like it covers something;
 * - a manifest that publishes a PATTERN subpath throws ({@link patternDoors}) —
 *   the derivation reads exact subpaths, and a pattern hands the same modules
 *   specifiers no entry in the map spells, so the ban goes partial with nothing
 *   saying so. This is the direction a hand-written list of strings never
 *   reports at all, and the reason the set is not one.
 *
 * The list going EMPTY needs no assertion here: the door rule then exempts no
 * door, and the registry's own door reaching the registry is a violation there
 * — loudly, before this rule's silence could be mistaken for a pass.
 *
 * WHO MAY NAME A DOOR, default-closed — every tree not named here is refused:
 * the `scripts` workspace, which drives seed and env generation off the registry
 * and ships to no origin; the api source tree, whose runtime environment is the
 * one the registry declares; and test files anywhere, which run in Node. `ops`
 * is deliberately absent — the default-closed refusal is how the day it needs a
 * door becomes visible.
 *
 * RE-EXPORTING A DOOR IS LAUNDERING IT, so the taint travels. A declared
 * consumer may legally name a door; republishing it puts the registry behind a
 * specifier the derived ban does not spell, and every module that re-exports one
 * of those inherits the same property. Taint is seeded and propagated by
 * `export … from` declarations and only those ({@link launderingModules}), to
 * any depth: a chain of them ending at a door is refused to undeclared trees
 * exactly as the door itself is. A link that instead imports the door and
 * exports the binding in a separate statement is not such a declaration, so it
 * neither seeds a chain nor continues one — that module republishes the registry
 * just the same, and importing it is admitted. The clause is armor rather than a
 * migration: it was written with nothing in the repository re-exporting either
 * door.
 *
 * WHAT STAYS UNSEEN IS DERIVED, NOT LISTED. The DOOR leg ({@link doorViolations})
 * reads a specifier written out where the form takes it
 * (`packages/config/arch/lib/module-references.ts` owns which forms exist), so a
 * reach that never becomes one written specifier is outside it: a specifier
 * assembled at runtime, and a module loader escaped into a value. The TAINT leg
 * ({@link launderedViolations}) is narrower than that account, not equal to it —
 * it reads static import and export declarations only, so a dynamic import or a
 * `require` of a laundering module is admitted where the same module statically
 * imported is refused. Narrower again along a second axis: what is banned is the
 * door SPECIFIERS, so the registry module named by cross-package relative path is
 * admitted from every tree — and that spelling is live here rather than
 * hypothetical: `scripts/verify-bundle.ts` names the registry modules that way
 * at its own call site.
 * Wider than any of them: an undeclared tree reaching a declared consumer that
 * names a door in any form the taint leg does not follow — whether it merely
 * IMPORTS one, a browser file importing a build script being the plain case, or
 * republishes one through separate import and export statements — reaches the
 * registry through a graph this rule does not walk. That residual is accepted
 * with its closing design recorded: a full closure from the browser entry points
 * needs per-app path-alias resolution the architecture harness does not have.
 *
 * Behind all of it stands the artifact-level check on the built dists
 * (`scripts/verify-bundle.ts`), which reads bytes rather than source and so sees
 * what a plugin or a resolution-time swap injects after every source rule has
 * had its say. Source graph and built artifact are complementary layers, not two
 * copies of one guard.
 */

/** The trees whose files may name a node-only door, resolved once at import. */
const SOURCE_TREES = discoverSourceTrees(REPO_ROOT);
const API_ROOT = path.join(REPO_ROOT, workspaceSourceTree(SOURCE_TREES, 'apps/api'));
const SCRIPTS_ROOT = path.join(REPO_ROOT, workspaceSourceTree(SOURCE_TREES, 'scripts'));

/** The declared consumers, as a violation names them to whoever reads CI output. */
const CONSUMER_CLASSES = 'the scripts workspace, the api source tree, and test files anywhere';

/** What a bundler does with a reach, stated wherever a violation has to justify itself. */
const INLINING =
  'A bundler inlines whatever a module reaches, so every backend variable name and ' +
  'every non-production placeholder value the registry carries ships into any dist ' +
  'built from this file.';

interface Manifest {
  readonly name: string;
  readonly exports: Record<string, string>;
}

/** The repo-relative path a message names, so no machine's layout reaches CI output. */
function repoRelative(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath);
}

function readManifest(project: Project): Manifest {
  return JSON.parse(
    project.getFileSystem().readFileSync(path.join(REPO_ROOT, MANIFEST_PATH))
  ) as Manifest;
}

function isDeclaredConsumer(filePath: string): boolean {
  return isTestFile(filePath) || filePath.startsWith(API_ROOT) || filePath.startsWith(SCRIPTS_ROOT);
}

function unpublishedDoor(subpath: string): Error {
  return new Error(
    `node-only-doors-have-declared-consumers: NODE_ONLY_DOORS names '${subpath}', which ` +
      `${MANIFEST_PATH} does not publish, so the specifier this ban derives from it names a ` +
      'door nothing can write. The ban has lost that subject rather than gained safety — ' +
      'point the entry at the door that replaced it, or drop it.'
  );
}

function patternDoors(patterns: readonly string[]): Error {
  const named = patterns.map((subpath) => `'${subpath}'`).join(', ');
  return new Error(
    `node-only-doors-have-declared-consumers: ${MANIFEST_PATH} publishes the pattern ` +
      `door(s) ${named}. This ban derives one ` +
      'specifier per exact subpath, so a pattern hands the same modules specifiers no entry ' +
      'in the map spells and the ban goes partial with nothing reporting it. Publish the ' +
      'node-only modules under exact subpaths, or teach this rule to read patterns.'
  );
}

/** One specifier per declared node-only door, with the manifest held to the list both ways. */
function bannedSpecifiers(manifest: Manifest): Set<string> {
  const patterns = Object.keys(manifest.exports).filter((subpath) => subpath.includes('*'));
  if (patterns.length > 0) throw patternDoors(patterns);

  const banned = new Set<string>();
  for (const subpath of NODE_ONLY_DOORS) {
    if (manifest.exports[subpath] === undefined) throw unpublishedDoor(subpath);
    banned.add(`${manifest.name}${subpath.slice(1)}`);
  }
  return banned;
}

/**
 * Every module that republishes a node-only door, and every module that
 * republishes one of those — the fixed point, so a door is still a door however
 * many barrels it has travelled through.
 *
 * Seeded from re-exports of a banned specifier; with no seed there is nothing to
 * propagate, and the walk that would resolve every re-export in the repository
 * is skipped rather than run to reach the same empty answer.
 */
function launderingModules(project: Project, banned: ReadonlySet<string>): Set<SourceFile> {
  const tainted = new Set(
    project.getSourceFiles().filter((file) =>
      file.getExportDeclarations().some((declaration) => {
        const specifier = declaration.getModuleSpecifierValue();
        return specifier !== undefined && banned.has(specifier);
      })
    )
  );
  if (tainted.size === 0) return tainted;

  const edges = project.getSourceFiles().flatMap((file) =>
    file.getExportDeclarations().map((declaration) => ({
      file,
      target: declaration.getModuleSpecifierSourceFile(),
    }))
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const { file, target } of edges) {
      if (target === undefined || !tainted.has(target) || tainted.has(file)) continue;
      tainted.add(file);
      changed = true;
    }
  }
  return tainted;
}

function doorMessage(specifier: string): string {
  return (
    `'${specifier}' is one of the node-only doors ${MANIFEST_PATH} publishes onto the backend ` +
    `environment registry, and this file sits in no tree that declares a consumer of one. ` +
    `${INLINING} The declared consumers are ${CONSUMER_CLASSES} — cut the import, or move the ` +
    'caller into one of those.'
  );
}

function launderedMessage(target: SourceFile): string {
  return (
    `${repoRelative(target.getFilePath())} re-exports a node-only door onto the backend ` +
    'environment registry, so importing it reaches the registry under a specifier no door ' +
    `spells. ${INLINING} The declared consumers are ${CONSUMER_CLASSES} — cut the import, or ` +
    'take the re-export off that module.'
  );
}

/** Every place a file writes a banned specifier, in whichever form names the module. */
function doorViolations(file: SourceFile, banned: ReadonlySet<string>): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const reference of moduleReferences(file.compilerNode)) {
    const { specifier } = reference;
    if (specifier === undefined || !banned.has(specifier)) continue;
    violations.push({
      file: repoRelative(file.getFilePath()),
      line: reference.line,
      message: doorMessage(specifier),
    });
  }
  return violations;
}

/** Every place a file names a module that republishes a door. */
function launderedViolations(file: SourceFile, tainted: ReadonlySet<SourceFile>): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
    const target = declaration.getModuleSpecifierSourceFile();
    if (target === undefined || !tainted.has(target)) continue;
    violations.push({
      file: repoRelative(file.getFilePath()),
      line: declaration.getStartLineNumber(),
      message: launderedMessage(target),
    });
  }
  return violations;
}

const rule: ArchRule = {
  name: 'node-only-doors-have-declared-consumers',
  check(project) {
    const banned = bannedSpecifiers(readManifest(project));
    const tainted = launderingModules(project, banned);
    return project
      .getSourceFiles()
      .filter((file) => !isDeclaredConsumer(file.getFilePath()))
      .flatMap((file) => [
        ...doorViolations(file, banned),
        ...(tainted.size === 0 ? [] : launderedViolations(file, tainted)),
      ]);
  },
};

export default rule;
