import { Node, SyntaxKind } from 'ts-morph';

import { assertNamedPathsExist, isRepoPath, isTestFile, relativePath } from '../lib/paths.js';

import type { Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * No two declared route keys of one method match the same concrete request
 * path.
 *
 * The class-default rate-limit counter takes its route component from the
 * MATCHED REGISTRATION, not from the request. So a request matching two
 * declared keys of one method spends one unit on each of two counters rather
 * than two units on one, and the effective bound for that path is the SUM of
 * the two declarations rather than either of them. Nothing else in the tree
 * reacts: the map still typechecks, every posture is still declared, and the
 * default-deny pipeline stage still finds a posture for every match. A cap that
 * rises by addition is "hit the limiter, then allow" wearing a different shape,
 * which is the one outcome the posture vocabulary exists to foreclose.
 *
 * The check reasons over TEMPLATE COMPATIBILITY rather than over probe paths,
 * and the difference decides whether it works at all. Measured on the router
 * itself: with `$get /a/:x/b` and `$get /a/c/:y` both registered, a request to
 * `/a/PROBE/b` matches only the first and one to `/a/c/PROBE` only the second,
 * while `/a/c/b` matches both. A sweep that requests one path per template
 * therefore returns zero for the exact shape it exists to catch.
 *
 * Its subject is every route-key-shaped property name — `'$<verb> /<path>'` —
 * written in the product Worker's non-test source, deduplicated by key. Read by
 * SHAPE rather than from a named file, so a declaration map that moves stays
 * covered and a second route-keyed map that lands is covered on arrival; a key
 * declared in two such maps is one key and pairs with nothing, and the site a
 * failure points at is the first of that key's sites in path order — which may
 * be a map other than the one whose bound is at stake, since the key is what
 * the two share. Reading
 * declarations rather than registrations is what makes the check static, and
 * the two sets are held together from the other side: the posture map's
 * `satisfies Record<AppRouteKey, …>` clause refuses to compile while a served
 * route is undeclared, so a live overlap cannot hide from a declaration-side
 * sweep. A declared key naming no route runs the other way and only over-flags.
 *
 * Compatibility is decided per segment over templates of equal segment count:
 * two literals must be equal, a param admits whatever the other side requires,
 * and the witness path in the failure is built from those choices — a literal
 * contributes its own text, two params contribute {@link ANY_SEGMENT}. The
 * failure therefore names both keys AND the shape of path that reaches both,
 * which is the whole of the fix.
 *
 * A segment that is neither a literal nor a plain `:param` — a wildcard, an
 * optional param, a regex-constrained param — is REFUSED at its own
 * declaration and then left out of the pairing. The segment algebra cannot
 * decide it and a wildcard overlaps every path under its prefix by
 * construction, so passing it silently is the one disposition unavailable
 * here; dropping it from the pairing afterwards costs nothing, because the
 * build is already refused. Extending the algebra is what a first such
 * declaration is meant to trigger.
 *
 * What it does NOT catch, stated rather than glossed:
 *
 * - A route the router serves that no declaration names. This rule reads
 *   declarations, and rests on the posture map's own completeness clause for
 *   the two sets agreeing; it re-proves nothing about that.
 * - A key not written out as a property name — one reaching a map through a
 *   spread of a value declared elsewhere, through a computed key, or through a
 *   map built at runtime. It reads written string literals in property-name
 *   position, and a key in a TYPE literal is a property signature rather than a
 *   property assignment and is not read either.
 * - Which of two overlapping registrations actually answers. Precedence is
 *   mount order, which is not syntax; the overlap is the finding and the
 *   winner is not read.
 * - `ALL`-method registrations. They carry no declared key to collide with:
 *   `routeKeysOf` in `apps/api/src/lib/context/route-keys.ts` drops the `ALL`
 *   method before a key is minted, so every `.use()` mount — every pipeline
 *   stage and edge-ring middleware — is outside this key space by
 *   construction.
 * - Whether two overlapping keys share a route CLASS or a posture kind. The
 *   counter component is per key either way, so the sum holds across classes as
 *   well as within one. The rule reads no posture VALUE at all, which is also
 *   what keeps it independent of how that vocabulary is spelled.
 */

const RULE_NAME = 'declared-route-keys-match-disjoint-paths';

/** The tree whose declarations are read: the product Worker's source. */
const SCANNED_TREE = 'apps/api/src/';

/**
 * The map whose keys prove the spelling below still reads.
 *
 * A shape-driven collector decays without a symptom: the route-key spelling
 * changes, the pattern matches nothing, and the rule goes on passing over an
 * empty set. There is no violation to report when what went missing is the
 * rule's own subject, so an abort is the only signal available — and this map
 * is the one place in the tree guaranteed to declare keys, since it holds the
 * routes no slice can own.
 */
export const ANCHOR_MAP = 'apps/api/src/composition/rate-limit-posture.ts';

/** The router's own spelling of a declared route: `$<verb> <path>`. */
const ROUTE_KEY = /^\$([a-z]+) (\/.*)$/;

/** A segment carrying no matcher syntax, which matches only its own text. */
const LITERAL_SEGMENT = /^[^:*?{}]*$/;

/** A segment that matches any one non-empty segment. */
const PARAM_SEGMENT = /^:\w+$/;

/** What a witness path shows where both templates leave the segment open. */
const ANY_SEGMENT = '{any}';

/** One segment of a template, in the two forms the algebra can decide. */
type Segment = { readonly kind: 'literal'; readonly text: string } | { readonly kind: 'param' };

/** A parsed template, or the first segment that defeated the parse. */
type Template =
  | { readonly decided: true; readonly segments: readonly Segment[] }
  | { readonly decided: false; readonly segment: string };

/** Where a key is declared, and under which verb. */
interface KeySite {
  readonly key: string;
  readonly method: string;
  readonly file: string;
  readonly line: number;
}

/** A declared route key, at the site that names it. */
interface DeclaredKey extends KeySite {
  readonly template: Template;
}

/** A declared key whose template the algebra parsed, and so can be paired. */
interface DecidedKey extends KeySite {
  readonly segments: readonly Segment[];
}

function templateOf(path: string): Template {
  const segments: Segment[] = [];
  for (const raw of path.slice(1).split('/')) {
    if (LITERAL_SEGMENT.test(raw)) {
      segments.push({ kind: 'literal', text: raw });
      continue;
    }
    if (PARAM_SEGMENT.test(raw)) {
      segments.push({ kind: 'param' });
      continue;
    }
    return { decided: false, segment: raw };
  }
  return { decided: true, segments };
}

/**
 * The two templates' segments side by side, dropping any position only one of
 * them has — so a caller reads a length mismatch off the result rather than
 * carrying a second, unreachable guard for it.
 */
function zipSegments(
  left: readonly Segment[],
  right: readonly Segment[]
): readonly (readonly [Segment, Segment])[] {
  const remaining = [...right];
  return left.flatMap((segment) => {
    const counterpart = remaining.shift();
    return counterpart === undefined ? [] : [[segment, counterpart] as const];
  });
}

/** What a concrete path must carry at this position to satisfy both sides. */
function mergeSegments([left, right]: readonly [Segment, Segment]): string | undefined {
  if (left.kind === 'literal' && right.kind === 'literal') {
    return left.text === right.text ? left.text : undefined;
  }
  if (left.kind === 'literal') return left.text;
  if (right.kind === 'literal') return right.text;
  return ANY_SEGMENT;
}

/** A concrete path both templates match, or `undefined` when none exists. */
function witnessPath(left: readonly Segment[], right: readonly Segment[]): string | undefined {
  const pairs = zipSegments(left, right);
  if (pairs.length !== left.length || pairs.length !== right.length) return undefined;
  const parts: string[] = [];
  for (const pair of pairs) {
    const part = mergeSegments(pair);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function declaredKeysIn(sourceFile: SourceFile, file: string): DeclaredKey[] {
  const declared: DeclaredKey[] = [];
  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    const name = property.getNameNode();
    if (!Node.isStringLiteral(name)) continue;
    const key = name.getLiteralText();
    const match = ROUTE_KEY.exec(key);
    const method = match?.[1];
    const path = match?.[2];
    if (method === undefined || path === undefined) continue;
    declared.push({
      key,
      method,
      file,
      line: name.getStartLineNumber(),
      template: templateOf(path),
    });
  }
  return declared;
}

/**
 * Every declared key in the scanned tree, one entry per key. Sorted before the
 * fold so the surviving site of a key declared in several maps, and the order
 * a pair is reported in, are both stable across runs.
 */
function declaredKeys(project: Project): readonly DeclaredKey[] {
  const found: DeclaredKey[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    const file = relativePath(sourceFile);
    if (!file.includes(SCANNED_TREE) || isTestFile(file)) continue;
    found.push(...declaredKeysIn(sourceFile, file));
  }
  found.sort(
    (a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file) || a.line - b.line
  );
  const byKey = new Map<string, DeclaredKey>();
  for (const declared of found) {
    if (!byKey.has(declared.key)) byKey.set(declared.key, declared);
  }
  return [...byKey.values()];
}

function assertTheKeySpellingStillReads(project: Project, keys: readonly DeclaredKey[]): void {
  const remedy = `Point this rule at the map that declares the routes no slice owns.`;
  assertNamedPathsExist(RULE_NAME, project, [ANCHOR_MAP], remedy);
  if (keys.some((declared) => isRepoPath(declared.file, ANCHOR_MAP))) return;
  throw new Error(
    `${RULE_NAME}: '${ANCHOR_MAP}' declares no property name matching ${ROUTE_KEY.source}, so the ` +
      `collector below reads an empty set and reports nothing whatever the tree declares. ${remedy}`
  );
}

function overlapViolation(first: DecidedKey, second: DecidedKey, witness: string): ArchViolation {
  return {
    file: second.file,
    line: second.line,
    message:
      `'${second.key}' and '${first.key}' (declared in ${first.file}) both match ${witness} — the ` +
      `class-default counter takes its route component from the matched registration, so one ` +
      `request to that path spends a unit on each key's counter and the bound for it is their sum. ` +
      `Narrow one of the two templates so no concrete path reaches both.`,
  };
}

function undecidableViolation(declared: KeySite, segment: string): ArchViolation {
  return {
    file: declared.file,
    line: declared.line,
    message:
      `'${declared.key}' carries the segment '${segment}', which is neither a literal nor a plain ` +
      `:param, so this rule cannot decide which concrete paths it shares with its neighbours — and ` +
      `a wildcard shares all of them. Extend the segment algebra to cover this form, or declare a ` +
      `route whose template it already covers.`,
  };
}

/** The pairable keys, and a refusal for every key whose template defeated the parse. */
function partition(keys: readonly DeclaredKey[]): {
  readonly decided: readonly DecidedKey[];
  readonly refused: readonly ArchViolation[];
} {
  const decided: DecidedKey[] = [];
  const refused: ArchViolation[] = [];
  for (const { template, ...site } of keys) {
    if (template.decided) decided.push({ ...site, segments: template.segments });
    else refused.push(undecidableViolation(site, template.segment));
  }
  return { decided, refused };
}

/** Every same-method pair whose templates share a concrete path. */
function overlaps(decided: readonly DecidedKey[]): readonly ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const [index, first] of decided.entries()) {
    for (const second of decided.slice(index + 1)) {
      if (second.method !== first.method) continue;
      const witness = witnessPath(first.segments, second.segments);
      if (witness !== undefined) violations.push(overlapViolation(first, second, witness));
    }
  }
  return violations;
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project) {
    const keys = declaredKeys(project);
    assertTheKeySpellingStillReads(project, keys);
    const { decided, refused } = partition(keys);
    return [...refused, ...overlaps(decided)];
  },
};

export default rule;
