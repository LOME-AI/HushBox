import { doorClosure, repoRelative } from '../lib/door-closure.js';
import type { DoorClosure } from '../lib/door-closure.js';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Secrets live in the env registry and nowhere a reader or a log can reach
 * (`docs/CODE-RULES.md` §Security). The backend env registry carries every
 * backend variable name and the credential-shaped placeholder values the
 * non-production modes hold, and the public dists and mobile bundles are built
 * from doors this package publishes.
 *
 * A bundler inlines whatever a published door REACHES, so browser-safety is a
 * property of the module graph rather than of a door's export names: the
 * registry shipped into public dists once because a single re-export line
 * pointed the barrel at the module that declares it. This rule stands over that
 * graph.
 *
 * The walk itself — which edges a closure runs through, and why an edge it
 * cannot follow throws rather than being stepped over — is
 * `packages/config/arch/lib/door-closure.ts`, shared with the rule that refuses
 * a browser-facing door a Node runtime. What stays here is this rule's own
 * subject: the module a door must never reach, and which doors are exempt.
 *
 * The subject is derived rather than listed: the server-only module is the one
 * that DECLARES the registry, found by that declaration, so a rename moves the
 * rule with it and losing it throws instead of passing. The remedy a violation
 * carries points at the declared node-only doors, the only sanctioned way to
 * reach the registry.
 */

/** The package whose published doors this rule stands over. */
const PACKAGE_DIR = 'packages/shared';

/**
 * The manifest that publishes the doors, repo-relative. Exported so the
 * consumer-side ban reads the doors off the same manifest this rule does
 * rather than off a second path constant that can drift from it.
 */
export const MANIFEST_PATH = `${PACKAGE_DIR}/package.json`;

/**
 * The declaration that IDENTIFIES the server-only module. A path would merely
 * name it: a rename that left a path-shaped constant behind would leave this
 * rule enforcing over nothing while still reading like it enforced.
 */
const REGISTRY_DECLARATION = 'envConfig';

const RULE_NAME = 'published-doors-stay-browser-safe';

/**
 * The doors that serve node-only code, each reaching the registry because
 * reading it is the door's job. Every other door is browser-facing by default,
 * so a door published tomorrow is guarded the day it appears and an entry here
 * costs a visible edit with its reason beside it.
 *
 * The list cannot rot in place. An entry naming a subpath the exports map no
 * longer publishes throws, and so does an entry whose door reaches the registry
 * by no edge: an exemption nothing needs is deleted rather than left standing to
 * cover something else later. That second throw has one reading for every reach
 * the shared walk reads, because the reach that would have given it a second one
 * stops the walk with a refusal of its own instead;
 * {@link nodeOnlyDoorWithNoReadEdge} states both that and what stays outside
 * what the walk reads at all.
 *
 * This list is about the registry's CONTENT, and it is not the declaration that
 * a door needs a Node runtime — that one lives in the manifest, beside the door
 * it exempts, and `published-doors-declare-a-node-runtime.rule.ts` reads it.
 * Two lists because the consumer-side ban derives from this one: a door added
 * here is refused to every tree that declares no consumer of the registry.
 *
 * Exported so the colocated test seeds its fixtures from this list rather than
 * from a copy of it.
 */
export const NODE_ONLY_DOORS: readonly string[] = [
  // The registry's own door: the read path node-only code is meant to take to
  // the registry, and nothing browser-side reaches it.
  './env.config',
  // The bundle guard derives its needles FROM the registry, so it reads the
  // registry by construction; it is served to no origin and bundled by nothing.
  './env-registry-content',
];

/** The module that declares the registry — exactly one, or the rule has lost its subject. */
function serverOnlyModule(modules: ReadonlyMap<string, SourceFile>): string {
  const declaring = [...modules]
    .filter(
      ([file, sourceFile]) =>
        repoRelative(file).startsWith(`${PACKAGE_DIR}/`) &&
        sourceFile.getVariableDeclaration(REGISTRY_DECLARATION)?.isExported() === true
    )
    .map(([file]) => file);

  const [only, ...rest] = declaring;
  if (only !== undefined && rest.length === 0) return only;
  throw new Error(
    `${RULE_NAME}: ${String(declaring.length)} module(s) under ` +
      `'${PACKAGE_DIR}' export a '${REGISTRY_DECLARATION}' declaration ` +
      `(${declaring.map((file) => repoRelative(file)).join(', ') || 'none'}), and this rule stands over exactly one. ` +
      'The registry has moved, split, or gone — point the rule at what declares it now.'
  );
}

/** The specifiers node-only code is allowed to reach the registry by. */
function sanctionedSpecifiers(packageName: string): string {
  return NODE_ONLY_DOORS.map((subpath) => `'${packageName}${subpath.slice(1)}'`).join(' and ');
}

function poisonedDoorMessage(
  subpath: string,
  forbidden: string,
  chain: readonly string[],
  sanctioned: string
): string {
  return (
    `the '${subpath}' door reaches ${repoRelative(forbidden)}, the module that ` +
    `declares the backend environment registry: ` +
    `${chain.map((file) => repoRelative(file)).join(' -> ')}. A bundler inlines ` +
    'whatever a published door reaches, so every backend variable name and every ' +
    'non-production placeholder value ships into the dists built from this door. ' +
    `Cut the edge — node-only code reaches the registry through ${sanctioned}, and ` +
    'nothing else may.'
  );
}

function unpublishedNodeOnlyDoor(subpath: string): Error {
  return new Error(
    `${RULE_NAME}: NODE_ONLY_DOORS names '${subpath}', which ` +
      `${MANIFEST_PATH} does not publish. An entry naming no door exempts nothing, ` +
      'and reads like it exempts something — point it at the door that replaced it, ' +
      'or drop it.'
  );
}

/**
 * A declared exemption whose door reaches the registry by no edge. The reading
 * that used to share this message — a live exemption whose reach the walk could
 * not follow — now stops the walk at its own refusal before it can get here, for
 * every reach the walk reads.
 *
 * How far that goes is stated in the message rather than left for the reader to
 * work out, because the disposition this refusal hands out is DROP: a sentence
 * claiming more closure than the walk has would unguard the door in one edit,
 * which is the state this refusal exists to make unrepresentable. It states the
 * residue by DERIVATION for the same reason: a sentence naming one shape of
 * unread reach reads as the list of them, so a reader who searches for that one
 * shape, finds none, and drops the entry has done what the message told him —
 * which is how a residue scoped by a single example outlived two rounds of
 * widening the walk underneath it.
 */
function nodeOnlyDoorWithNoReadEdge(subpath: string, forbidden: string): Error {
  return new Error(
    `${RULE_NAME}: NODE_ONLY_DOORS names '${subpath}', whose ` +
      `closure reaches ${repoRelative(forbidden)} by no edge at all. The door has ` +
      'stopped reaching the registry, so the exemption is dead, buys nothing, and ' +
      'would silently cover the next edge in: drop the entry. A door reaching the ' +
      'registry through a form this walk cannot follow stops the walk with its own ' +
      'refusal rather than arriving here, so no reach this walk reads ends in this ' +
      'absence. What it reads is a fixed set of words standing in a fixed set of ' +
      'positions, so what stays invisible to it is everything outside that pairing ' +
      'rather than any one shape of it: the word left unwritten, as a key computed ' +
      'at runtime leaves it, and the word written where the walk does not read it, ' +
      'as a reflective property read leaves it. Those two are instances, not the ' +
      "class. Read the door's closure for any route to a module loader at all " +
      'before dropping the entry.'
  );
}

/**
 * Every declared exemption still names a published door whose closure still
 * reaches the registry by an edge this walk reads.
 */
function assertNodeOnlyDoorsEarnTheirPlace(closure: DoorClosure, forbidden: string): void {
  for (const subpath of NODE_ONLY_DOORS) {
    const target = closure.manifest.exports[subpath];
    if (target === undefined) throw unpublishedNodeOnlyDoor(subpath);
    const entry = closure.entryOf(subpath, target);
    if (entry.getFilePath() === forbidden) continue;
    if (registryChain(closure, entry, forbidden) === undefined) {
      throw nodeOnlyDoorWithNoReadEdge(subpath, forbidden);
    }
  }
}

/**
 * The door's first arrival at the server-only module: where the edge is
 * written, and the route the walk took to it with the module it reached on the
 * end.
 */
function registryChain(
  closure: DoorClosure,
  entry: SourceFile,
  forbidden: string
): { readonly file: string; readonly line: number; readonly chain: readonly string[] } | undefined {
  const reach = closure.firstReach(entry, (edge) => edge.toFile === forbidden);
  if (reach === undefined) return undefined;
  return { file: reach.from, line: reach.line, chain: [...reach.chain, forbidden] };
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project) {
    const closure = doorClosure({ ruleName: RULE_NAME, packageDir: PACKAGE_DIR, project });
    const forbidden = serverOnlyModule(closure.modules);
    assertNodeOnlyDoorsEarnTheirPlace(closure, forbidden);

    const sanctioned = sanctionedSpecifiers(closure.manifest.name);
    const violations: ArchViolation[] = [];
    for (const [subpath, target] of Object.entries(closure.manifest.exports)) {
      if (NODE_ONLY_DOORS.includes(subpath)) continue;
      const reach = registryChain(closure, closure.entryOf(subpath, target), forbidden);
      if (reach === undefined) continue;
      violations.push({
        file: repoRelative(reach.file),
        line: reach.line,
        message: poisonedDoorMessage(subpath, forbidden, reach.chain, sanctioned),
      });
    }
    return violations;
  },
};

export default rule;
