import { builtinModules } from 'node:module';
import { doorClosure, repoRelative } from '../lib/door-closure.js';
import type { DoorClosure, DoorManifest } from '../lib/door-closure.js';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A door published by a browser-facing package runs where its consumers run,
 * and a Node built-in does not run in a browser at all. A door whose closure
 * reaches one is served to every consumer as if it worked, fails at call time
 * rather than at build time — the bundlers only warn, and one of them emits an
 * empty stub — and so is a door that cannot do its job in the place its package
 * promises. This rule is what refuses it.
 *
 * It is the second question over the same closure the registry rule asks, and
 * the two are genuinely different: that one is about CONTENT a browser must
 * never receive, this one about CODE a browser cannot run. A door can carry
 * either property without the other, which is why the exemptions are two lists
 * rather than one — and why sharing that one list would refuse the very
 * consumers this door exists to serve, since the registry list also drives a
 * consumer-side ban scoped to the trees that read the registry.
 *
 * The walk is `packages/config/arch/lib/door-closure.ts`, shared with that rule.
 * What is this rule's own: which edges are a hit, and where the exemption is
 * declared.
 *
 * THE DECLARATION LIVES IN THE MANIFEST, beside the doors it exempts, rather
 * than in this file. Whoever publishes a door edits that map; a declaration one
 * package away is a step nobody takes who does not already know this rule
 * exists, and a door published without it is guarded by default the day it
 * appears. The list is held to the map both ways: an entry naming an
 * unpublished subpath throws, and so does an entry whose door reaches no
 * built-in — an exemption nothing needs is dropped rather than left standing to
 * cover the next edge in.
 */

const RULE_NAME = 'published-doors-declare-a-node-runtime';

/** The package whose published doors this rule stands over. */
const PACKAGE_DIR = 'packages/shared';

/** The manifest that publishes the doors and declares which need a Node runtime. */
const MANIFEST_PATH = `${PACKAGE_DIR}/package.json`;

/** The manifest field that declares a door as needing a Node runtime. */
const DECLARATION_FIELD = 'nodeRuntimeDoors';

/**
 * Node's own modules, under both spellings a source can write. The prefixed
 * form is checked as a prefix rather than against this set, because `node:` is
 * a namespace the runtime owns whole: a module added to it in a later release
 * is a Node built-in the day it ships, and a set frozen at the version this
 * process happens to run would admit it.
 */
const BARE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);
const BUILTIN_PREFIX = 'node:';

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith(BUILTIN_PREFIX) || BARE_BUILTINS.has(specifier);
}

/** The doors declared as needing a Node runtime, or none where the field is absent. */
function declaredDoors(manifest: DoorManifest): readonly string[] {
  if (!(DECLARATION_FIELD in manifest)) return [];
  const declared: unknown = manifest[DECLARATION_FIELD];
  if (!Array.isArray(declared) || declared.some((entry) => typeof entry !== 'string')) {
    throw new Error(
      `${RULE_NAME}: '${DECLARATION_FIELD}' in ${MANIFEST_PATH} is not a list of subpaths, ` +
        'so this rule cannot tell which doors it exempts. Reading it as empty would guard ' +
        'every door and fail the ones already declared; reading it as everything would ' +
        'guard none. Write it as an array of exports-map subpaths, or drop the field.'
    );
  }
  return declared as readonly string[];
}

function unpublishedDoor(subpath: string): Error {
  return new Error(
    `${RULE_NAME}: '${DECLARATION_FIELD}' names '${subpath}', which ${MANIFEST_PATH} does ` +
      'not publish. An entry naming no door exempts nothing, and reads like it exempts ' +
      'something — point it at the door that replaced it, or drop it.'
  );
}

function declaredDoorWithNoBuiltin(subpath: string): Error {
  return new Error(
    `${RULE_NAME}: '${DECLARATION_FIELD}' names '${subpath}', whose closure reaches no Node ` +
      'built-in at all. The door runs in a browser now, so the declaration is dead, buys ' +
      'nothing, and would silently cover the next built-in in: drop the entry. A door ' +
      'reaching one through a form this walk cannot follow stops the walk with its own ' +
      'refusal rather than arriving here, so no reach this walk reads ends in this absence.'
  );
}

function browserDoorMessage(subpath: string, specifier: string, chain: readonly string[]): string {
  return (
    `the '${subpath}' door reaches the Node built-in '${specifier}': ` +
    `${chain.map((file) => repoRelative(file)).join(' -> ')} -> ${specifier}. A browser has no such ` +
    'module, and nothing fails the build over it — the bundlers warn and one of them ' +
    'emits an empty stub, so a consumer finds out at call time. Cut the edge, or ' +
    `declare the door in '${DECLARATION_FIELD}' in ${MANIFEST_PATH} and keep it off the ` +
    "package's barrel."
  );
}

/** A door's first arrival at a Node built-in: where the edge is written, and the route to it. */
function builtinReach(
  closure: DoorClosure,
  entry: SourceFile
):
  | {
      readonly file: string;
      readonly line: number;
      readonly specifier: string;
      readonly chain: readonly string[];
    }
  | undefined {
  const reach = closure.firstReach(entry, (edge) => isNodeBuiltin(edge.specifier));
  if (reach === undefined) return undefined;
  return { file: reach.from, line: reach.line, specifier: reach.specifier, chain: reach.chain };
}

/** Every declared door still names a published door whose closure still reaches a built-in. */
function assertDeclarationsEarnTheirPlace(closure: DoorClosure, declared: readonly string[]): void {
  for (const subpath of declared) {
    const target = closure.manifest.exports[subpath];
    if (target === undefined) throw unpublishedDoor(subpath);
    if (builtinReach(closure, closure.entryOf(subpath, target)) === undefined) {
      throw declaredDoorWithNoBuiltin(subpath);
    }
  }
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project) {
    const closure = doorClosure({ ruleName: RULE_NAME, packageDir: PACKAGE_DIR, project });
    const declared = declaredDoors(closure.manifest);
    assertDeclarationsEarnTheirPlace(closure, declared);

    const violations: ArchViolation[] = [];
    for (const [subpath, target] of Object.entries(closure.manifest.exports)) {
      if (declared.includes(subpath)) continue;
      const reach = builtinReach(closure, closure.entryOf(subpath, target));
      if (reach === undefined) continue;
      violations.push({
        file: repoRelative(reach.file),
        line: reach.line,
        message: browserDoorMessage(subpath, reach.specifier, reach.chain),
      });
    }
    return violations;
  },
};

export default rule;
