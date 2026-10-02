import path from 'node:path';
import { WRITTEN_EXTENSIONS } from '../../written-extensions.mjs';
import { moduleReferences } from './module-references.js';
import { REPO_ROOT } from './source-scope.js';
import type { Project, SourceFile } from 'ts-morph';

/**
 * The reachability closure behind a package's published doors: the doors read
 * off the exports map, each one's module graph walked to a fixed point, and
 * every edge handed to the caller with the module it reaches.
 *
 * A bundler inlines whatever a published door REACHES, so any property of a
 * door is a property of its closure rather than of its export names. Two rules
 * ask different questions of that same closure — which module a door must never
 * reach, and which specifier it must never write — and the walk is the half
 * they share. It lives here because a second copy would be one rule reading the
 * module graph differently from its neighbour, and the closure is precisely
 * where a difference goes unnoticed: an edge one walk follows and the other
 * skips takes every module behind it out of one answer while both read clean.
 *
 * What the walk refuses to take on faith, each of which leaves a reach visible
 * to nothing when a walk follows only relative imports out of the barrel:
 *
 * - THE ENTRY SET IS NOT THE BARREL. Doors are read from the exports map, so
 *   every leaf door is an entry too. Consumers import several of them directly,
 *   and a leaf sits outside the barrel's closure by construction — a walk
 *   anchored on the barrel alone reports nothing about the door beside it.
 * - A SELF-PACKAGE SPECIFIER IS AN EDGE. A module inside the package that
 *   writes the package's own specifier reaches whatever that door serves,
 *   exactly as the relative spelling would; a walk that follows only `./` calls
 *   it unreachable while the bundler inlines it.
 * - AN UNRESOLVABLE EDGE THROWS, for the reason {@link unresolvable} states to
 *   whoever hits it. Stepping over one instead would go uncaught behind an
 *   ordinary door, and behind a door a rule has DECLARED exempt would arrive at
 *   that rule's exemption check as an absence indistinguishable from an
 *   exemption gone dead, whose reader acting on the wrong reading unguards the
 *   door for good. So the walk stops at an edge it cannot follow instead of
 *   stepping over it.
 *
 * What the walk does NOT own is the question: which edges are a hit, what a
 * violation says, and which doors are exempt each stay with the rule that
 * refuses them.
 */

/** Extensions a specifier resolves to, in the order the compiler tries them. */
const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx'];

/**
 * The scope every workspace package is published under. The walk opens the
 * guarded package's own doors and relative paths and nothing else, so a
 * specifier naming a sibling is an edge it cannot follow rather than one that
 * leaves the repository.
 */
const FIRST_PARTY_SCOPE = '@hushbox/';

export interface DoorManifest {
  readonly name: string;
  readonly exports: Record<string, string>;
}

/** One edge of a door's closure, with the module it reaches. */
export interface ClosureEdge {
  /** The absolute path of the module that writes the edge. */
  readonly from: string;
  readonly line: number;
  readonly specifier: string;
  /** The module reached, or `undefined` for a specifier that left the repository. */
  readonly toFile: string | undefined;
}

/** {@link ClosureEdge} with the module itself, which only the walk needs. */
interface ResolvedEdge extends ClosureEdge {
  readonly to: SourceFile | undefined;
}

/** An edge a rule called a hit, with the route the walk took to reach it. */
export interface ClosureReach extends ClosureEdge {
  /** The modules walked through, ending at the one that writes the edge. */
  readonly chain: readonly string[];
}

/** How the walk arrived at a module: the module it came from, and the edge's line. */
interface Step {
  readonly from: string;
  readonly line: number;
}

interface Edge {
  readonly specifier: string;
  readonly line: number;
}

/** The closure of one package's published doors, read for one rule. */
export interface DoorClosure {
  readonly manifest: DoorManifest;
  readonly modules: ReadonlyMap<string, SourceFile>;
  /** The module a door serves, which the walk has to be able to open. */
  entryOf: (subpath: string, target: string) => SourceFile;
  /** The first edge in a door's closure the rule calls a hit, or `undefined`. */
  firstReach: (entry: SourceFile, hits: (edge: ClosureEdge) => boolean) => ClosureReach | undefined;
}

/** The repo-relative path a message names, so no machine's layout reaches CI output. */
export function repoRelative(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath);
}

/**
 * A specifier the walk read no module name off. Written or computed is not the
 * line it draws: it reads a plain string literal standing in the slot the form
 * takes its specifier from and nothing else, so a specifier the source writes
 * out is unread all the same once anything at all stands between it and that
 * slot. A reader told the specifier was computed goes looking for a computation
 * that is not there, and misses the one repair that works — unwrapping it — so
 * the account names what the walk did rather than what the source is supposed to
 * have done.
 *
 * The account names the SLOT rather than the call, because a call is not where
 * every form carrying this refusal writes its specifier: an import declaration,
 * a re-export and an import assignment reach it too, and a remedy pointing at a
 * call sends the reader of one of those looking for something that is not there
 * — the same misdirection a word further on.
 */
const UNREAD_SPECIFIER =
  'the walk read no module name off it. It reads a specifier written as a plain string ' +
  'literal where the form takes it, and nothing else, so a literal reached through ' +
  'anything at all — parentheses, an operator the emit erases, a spread — goes unread ' +
  'exactly as a name or a template with a substitution does, while a bundler still ' +
  'follows the edge. Write the specifier as a plain string literal where the form takes ' +
  'it, or cut the edge';

/**
 * A require function that got away into a value. The walk reports the escape and
 * cannot report the module, so what a reader has to do about it is stated here.
 */
const ESCAPED_REQUIRE =
  'the require function escapes into a value there — or the `createRequire` that ' +
  'mints one, which is the same escape a word earlier — so nothing written after ' +
  'that names the module it goes on to load while a bundler still follows it ' +
  '(packages/config/arch/lib/module-references.ts enumerates the escapes). Cut the ' +
  'edge, or rewrite the reach in a form the walk reads';

/**
 * The refusal every unfollowable edge ends at, named by the text the source
 * wrote — a specifier where one is written, the escaping expression where the
 * require function got away instead. Its message is where the walk states in
 * full what one skipped edge costs a reachability closure, and the comments
 * point here rather than restating it: whoever meets this is reading CI output,
 * with no editor to follow a pointer in.
 */
function unresolvable(ruleName: string, fromFile: string, written: string, reason: string): Error {
  return new Error(
    `${ruleName}: '${written}' in ${repoRelative(fromFile)} is an ` +
      `edge this walk cannot follow — ${reason}. The walk stops rather than skipping the ` +
      'edge: a skipped edge takes every module behind it out of the closure and ' +
      'reads exactly like a clean pass.'
  );
}

/** The candidate modules a specifier's base path can name, in compiler order. */
function candidatesFor(base: string): string[] {
  return [
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
  ];
}

/**
 * Every route the shared walk (`packages/config/arch/lib/module-references.ts`)
 * reads as linking one module into another, plus the one it reports without a
 * module: a require function escaped into a value, whether it got away through
 * an expression or through a name the source writes. Both arrive here as a
 * reference carrying no specifier and stop the walk, so no door reaches anything
 * through either and reads clean — which is what leaves a rule's own exemption
 * refusal a single reading over everything the walk reads.
 * Type-only edges count throughout: a type edge into a forbidden module is
 * the step that makes the value edge beside it look harmless to add next.
 *
 * An edge the walk cannot follow is where this walk parts company with the
 * layer's other readers, and the reason is its own: {@link firstReachIn} is a
 * fixed point over every edge, so a skipped one costs what
 * {@link unresolvable} says it costs. Hence a throw rather than a step over it.
 */
function edgesOf(ruleName: string, sourceFile: SourceFile): Edge[] {
  return moduleReferences(sourceFile.compilerNode).map((reference) => {
    if (reference.specifier === undefined) {
      throw unresolvable(
        ruleName,
        sourceFile.getFilePath(),
        reference.node.getText(sourceFile.compilerNode),
        reference.form === 'require-escape' ? ESCAPED_REQUIRE : UNREAD_SPECIFIER
      );
    }
    return { specifier: reference.specifier, line: reference.line };
  });
}

/** The route the walk took to the module that writes a hit edge. */
function chainTo(target: string, steps: ReadonlyMap<string, Step>): string[] {
  const chain = [target];
  let step = steps.get(target);
  while (step !== undefined) {
    chain.unshift(step.from);
    step = steps.get(step.from);
  }
  return chain;
}

/**
 * The doors, the modules and the resolution one package's closure is walked
 * with. `ruleName` names the refusing rule in every message the walk throws, so
 * whoever reads CI output is told which gate stopped and why.
 */
export function doorClosure(options: {
  readonly ruleName: string;
  readonly packageDir: string;
  readonly project: Project;
}): DoorClosure {
  const { ruleName, packageDir, project } = options;
  const packageRoot = path.join(REPO_ROOT, packageDir);
  const manifestPath = `${packageDir}/package.json`;

  const manifest = JSON.parse(
    project.getFileSystem().readFileSync(path.join(REPO_ROOT, manifestPath))
  ) as DoorManifest;

  const modules = new Map<string, SourceFile>(
    project.getSourceFiles().map((sourceFile) => [sourceFile.getFilePath(), sourceFile])
  );

  const targetOf = (target: string): string => path.join(packageRoot, target);

  function resolveRelative(fromFile: string, specifier: string): SourceFile {
    const base = path.resolve(path.dirname(fromFile), specifier.replace(WRITTEN_EXTENSIONS, ''));
    for (const candidate of candidatesFor(base)) {
      const module = modules.get(candidate);
      if (module !== undefined) return module;
    }
    throw unresolvable(ruleName, fromFile, specifier, 'no such module');
  }

  function resolveThroughDoor(fromFile: string, specifier: string): SourceFile {
    const subpath = specifier === manifest.name ? '.' : `.${specifier.slice(manifest.name.length)}`;
    const target = manifest.exports[subpath];
    if (target === undefined) {
      throw unresolvable(
        ruleName,
        fromFile,
        specifier,
        `${manifestPath} publishes no '${subpath}' door`
      );
    }
    const module = modules.get(targetOf(target));
    if (module === undefined) {
      throw unresolvable(
        ruleName,
        fromFile,
        specifier,
        `its door names ${repoRelative(targetOf(target))}, which is gone`
      );
    }
    return module;
  }

  /**
   * The module an edge reaches, or `undefined` for a third-party specifier,
   * which has left the repository holding no module of this package. A relative
   * or self-package specifier resolving to nothing throws, and so does one
   * naming a sibling workspace package: each of those is an edge a closure runs
   * through.
   */
  function resolveEdge(fromFile: string, specifier: string): SourceFile | undefined {
    if (specifier.startsWith('.')) return resolveRelative(fromFile, specifier);
    const { name } = manifest;
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      return resolveThroughDoor(fromFile, specifier);
    }
    if (specifier.startsWith(FIRST_PARTY_SCOPE)) {
      throw unresolvable(
        ruleName,
        fromFile,
        specifier,
        'it names a sibling workspace package, and this walk opens no package but ' +
          'the one it guards'
      );
    }
    return undefined;
  }

  /** Each module's edges, parsed once however many doors walk through it. */
  const cache = new Map<string, Edge[]>();
  const edgesFor = (module: SourceFile): Edge[] => {
    const cached = cache.get(module.getFilePath());
    if (cached !== undefined) return cached;
    const edges = edgesOf(ruleName, module);
    cache.set(module.getFilePath(), edges);
    return edges;
  };

  /** Every edge one module writes, each resolved to the module it reaches. */
  function edgesFrom(module: SourceFile): ResolvedEdge[] {
    const from = module.getFilePath();
    return edgesFor(module).map(({ specifier, line }) => {
      const to = resolveEdge(from, specifier);
      return { from, line, specifier, to, toFile: to?.getFilePath() };
    });
  }

  /**
   * The first edge in a door's closure the caller calls a hit, or `undefined`.
   *
   * The walk finishes even once it has an answer: every remaining edge still has
   * to resolve, and stopping early would leave an unfollowable one unreported
   * behind a door that already has a violation to fix. A hit is never queued or
   * marked seen, so a second edge to the same place is read again and answered
   * with the first hit rather than a later one.
   */
  function firstReachIn(
    entry: SourceFile,
    hits: (edge: ClosureEdge) => boolean
  ): ClosureReach | undefined {
    const steps = new Map<string, Step>();
    const seen = new Set<string>([entry.getFilePath()]);
    const queue = [entry];
    let found: ClosureReach | undefined;

    // The queue is appended to while it is being iterated; that append IS the walk.
    for (const module of queue) {
      for (const edge of edgesFrom(module)) {
        if (hits(edge)) {
          found ??= { ...edge, chain: chainTo(edge.from, steps) };
          continue;
        }
        if (edge.to === undefined || seen.has(edge.to.getFilePath())) continue;
        seen.add(edge.to.getFilePath());
        steps.set(edge.to.getFilePath(), { from: edge.from, line: edge.line });
        queue.push(edge.to);
      }
    }

    return found;
  }

  function missingDoorTarget(subpath: string, target: string): Error {
    return new Error(
      `${ruleName}: the '${subpath}' door in ${manifestPath} names ` +
        `${repoRelative(target)}, which is no scanned module. A door onto nothing is a ` +
        'closure this rule cannot walk — restore the module or drop the entry.'
    );
  }

  return {
    manifest,
    modules,
    entryOf(subpath, target) {
      const entry = modules.get(targetOf(target));
      if (entry === undefined) throw missingDoorTarget(subpath, targetOf(target));
      return entry;
    },
    firstReach: firstReachIn,
  };
}
