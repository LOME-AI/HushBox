/**
 * A gate a rule cannot be silently disarmed past: every repository path a lint
 * or architecture rule hard-codes still names something that is there.
 *
 * A path-shaped scope decays without a symptom. The rule keeps running, its
 * scope matches nothing, and the suite stays green — because the colocated
 * tests feed the rule synthetic filenames built from the same string, so rule
 * and test agree with each other about a tree that is no longer there.
 * Measured on this repository: renaming the workflow slice segment inside both
 * path-scoped engine rules AND their colocated test's fixture constants left
 * that pair's suite entirely green against a directory that is not on disk.
 *
 * WHY THE PATHS ARE READ FROM THE LITERALS rather than declared by each rule.
 * A rule declaring its own scope for the gate is a second copy of that scope,
 * and a relocation that repoints the regex and forgets the declaration is the
 * same silent disarm one level out. The literals ARE the scope, so they are
 * what the gate reads.
 *
 * WHY NOT `arch/lib/paths.ts`'s `assertNamedPathsExist`, which names
 * this same decay. That one answers "is this file in the scanned ts-morph
 * project", which is the right question for an architecture rule mid-run and
 * reaches neither a directory prefix, nor a `.mjs` rule module, nor a path
 * outside the scanned globs. This one answers "is this on disk", over every
 * governed tree at once.
 *
 * WHY A SPLICED PATH IS REFUSED RATHER THAN EVALUATED. A path assembled from
 * pieces — `'apps/api/src/slices/' + leaf`, or the same in a template
 * interpolation — reads as its resolving directory prefix and nothing else, so
 * the module it actually points at is gated by nothing while the gate reports
 * success. Joining the pieces means resolving identifiers, which makes this an
 * interpreter of the modules it gates and still answers nothing for a computed
 * one. So a truncated read is a refusal with a remedy: write the path whole.
 *
 * WHY DEFAULT-ON WITH DECLARED EXCEPTIONS rather than a list of the modules to
 * check: a list the author must remember to join is the same defect one level
 * up — a rule added without its entry gets no gate and reports nothing about
 * having none. What makes default-on affordable is what the gate declines to
 * read: prose is outside it, and so is every module that exists only so tests
 * can run, so the only paths reaching the check are scopes — and a scope
 * deliberately naming nothing is rare enough to name individually in
 * {@link SYNTHETIC_RULE_PATHS} with its reason.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parser } from 'typescript-eslint';
import { DEFERRED_WORKSPACES, REPO_ROOT, SCANNED_WORKSPACES } from './arch/lib/source-scope.ts';
import { TEST_FILE_PATTERN } from './test-file-spellings.ts';

export const CONFIG_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * The trees the gate reads: the two rule layers and the shared ESLint config
 * they compose into. Each is taken whole rather than enumerated — a list of
 * rule files silently exempts whatever it does not name, which is the shape of
 * failure this module exists to refuse.
 */
export const GOVERNED_TREES = ['arch', 'eslint-extensions', 'eslint-parts', 'eslint.config.js'];

/**
 * Repository directories a rule names that the workspace manifest does not,
 * each with the reason a rule reaches into it. A whitelist rather than every
 * top-level directory because without one a plugin rule id is a repo path:
 * `unicorn/no-null` and `docs/BILLING.md` are the same shape.
 *
 * WHAT STAYS OUT, AND WHAT THAT COSTS. A path under a tracked top-level
 * directory named neither by the manifest nor here — `patches`,
 * `mobile-tests`, and the dot-directories `.github`, `.husky`, `.claude`,
 * `.impeccable`, `.superset` — is not gated at all, so a rule citing one and a
 * relocation moving it produce exactly the silence this gate exists to refuse.
 * The trade is deliberate: the whitelist is what keeps a rule id out, and a
 * root joins it the first time a rule names a path under it.
 */
export const NON_WORKSPACE_ROOTS = {
  docs: 'A rule cites a design document in the message it refuses code with, which is the text a developer reads at the moment their code is refused — the worst place in the repository for a reference to a file that has moved.',
};

/**
 * The directories a repo-relative path can start with: the workspace manifest
 * the architecture layer already reads, so that a new workspace needs no second
 * declaration here, plus {@link NON_WORKSPACE_ROOTS}.
 */
const REPO_ROOTS = [
  ...new Set([
    ...[...SCANNED_WORKSPACES, ...Object.keys(DEFERRED_WORKSPACES)].map(
      (pattern) => pattern.split('/')[0]
    ),
    ...Object.keys(NON_WORKSPACE_ROOTS),
  ]),
].toSorted();

/**
 * A repo-relative path inside a literal. The leading boundary admits `/`,
 * because a path sits mid-string in every regex scope (`/\/apps\/api\/…/`) and
 * a boundary refusing it reads those rules as naming no path at all — which is
 * how the first cut of this gate missed both rules the defect was found in.
 * Segments stop at whatever a glob or a regex adds, so `apps/api/src/**` and
 * `…/nodes/[\w-]+-execution` each yield the literal directory they scope to.
 */
const REPO_PATH = new RegExp(
  String.raw`(?:^|[^\w.@-])((?:${REPO_ROOTS.join('|')})/[\w.@-]+(?:/[\w.@-]+)*)`,
  'g'
);

/**
 * A character class and the partial path segment in front of it, or one
 * escaped literal character. Ordered so a partial segment is consumed with the
 * class it leads into rather than surviving as a directory of its own.
 */
const REGEX_ESCAPE = /[\w.@-]*\\\w|\\(\W)/g;

/** The separator or full stop a path's own text stops before. */
const TRAILING_TEXT = /[./]+$/;

/** Nothing but {@link TRAILING_TEXT}, so the literal named no more than the path. */
const TRAILING_TEXT_ONLY = /^[./]*$/;

/** A regex scope's pattern as the string form of the same scope would spell it. */
function unescapeRegexPath(pattern) {
  return pattern.replaceAll(REGEX_ESCAPE, (_, literal) => literal ?? ' ');
}

/** The text a node carries, or the empty string where a node carries none. */
function literalText(node) {
  // A tagged template's cooked value is null when it holds an invalid escape,
  // and the raw text is deliberately not read in its place: what a scope means
  // is its cooked value.
  if (node.type === 'TemplateElement') return node.value.cooked ?? '';
  if (node.type !== 'Literal') return '';
  if (typeof node.value === 'string') return node.value;
  // A regex scope carries its path escaped, and unescaping is not deleting the
  // backslashes: `\/` and `\.` escape one literal character, while `\w` and
  // `\d` open a character class, which is no part of a path — and neither is
  // the partial segment leading into it, so both go. That is what a bracketed
  // class (`[\w-]+`) already does to the same scope by terminating the match.
  return node.regex === undefined ? '' : unescapeRegexPath(node.regex.pattern);
}

/**
 * Every literal a module carries, each with whether more string content
 * follows it out of an expression this gate does not evaluate — a `+` operand
 * with something to its right, or a template quasi with an interpolation after
 * it.
 *
 * WHY THE FLAG IS CARRIED RATHER THAN THE JOINED STRING. Evaluating what a
 * splice produces means resolving the identifier, which means becoming an
 * interpreter of the module under gate; the answer would still be unknown for
 * anything computed. The flag is the whole mechanism: a path truncated by a
 * splice is refused, never read.
 */
function* stringReads(node, continued) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) yield* stringReads(child, false);
    return;
  }
  if (node.type === 'TemplateLiteral') {
    yield* templateReads(node, continued);
    return;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    yield* stringReads(node.left, true);
    yield* stringReads(node.right, continued);
    return;
  }
  yield { text: literalText(node), continued };
  for (const key of Object.keys(node)) yield* stringReads(node[key], false);
}

/**
 * A template's own text, quasi by quasi. Every quasi but the last is followed
 * by an interpolation, so only the last can carry a path to its own end.
 */
function* templateReads(node, continued) {
  const last = node.quasis.length - 1;
  for (const [index, quasi] of node.quasis.entries()) {
    yield { text: literalText(quasi), continued: index < last || continued };
  }
  for (const expression of node.expressions) yield* stringReads(expression, false);
}

/**
 * The paths a module names whole, and the prefixes it splices — a path whose
 * readable part runs to the end of its literal, with the rest coming from an
 * expression this gate cannot read.
 *
 * A spliced prefix is deliberately NOT a named path: its directory resolves
 * while the module it actually points at is unknown, so reading it as a scope
 * is exactly the silent disarm this gate exists to refuse, one spelling in.
 */
function readPaths(source, filePath) {
  const { ast } = parser.parseForESLint(source, {
    filePath,
    jsx: filePath.endsWith('x'),
    loc: false,
    range: false,
  });
  const named = new Set();
  const spliced = new Set();
  for (const { text, continued } of stringReads(ast, false)) {
    // A path ends in neither a separator nor a full stop, so a trailing run of
    // either belongs to the text around it: the sentence a violation message
    // cites the path in, or the wildcard a scope continues with (`src/.*`).
    for (const match of text.matchAll(REPO_PATH)) {
      const tail = text.slice(match.index + match[0].length);
      const found = match[1].replace(TRAILING_TEXT, '');
      // Only a path the literal's own end cuts short is spliced. One a
      // sentence carries on past — `'see docs/BILLING.md for ' + name` — was
      // read whole, and refusing it would refuse a diagnostic that is fine.
      (continued && TRAILING_TEXT_ONLY.test(tail) ? spliced : named).add(found);
    }
  }
  return { named: [...named].toSorted(), spliced: [...spliced].toSorted() };
}

/**
 * The repo-relative paths a module names whole, read from its string, template
 * and regex literals alone. Parsing rather than matching raw text is what keeps
 * prose out: a docblock naming the path a rule used to watch, or an example
 * filename in a rule's own message, is not a scope and must not be gated as
 * one.
 */
export function repoPathsIn(source, filePath) {
  return readPaths(source, filePath).named;
}

/**
 * The prefixes a module splices a path out of, which this gate refuses rather
 * than reads: `'apps/api/src/slices/' + leaf` and `` `apps/api/src/slices/${leaf}` ``
 * both leave a directory that resolves standing for a module nobody checked.
 */
export function splicedPathsIn(source, filePath) {
  return readPaths(source, filePath).spliced;
}

/**
 * A repo-relative path names something on disk. An extension-less path counts
 * when a sibling carries one, because a module scope written as a regex
 * (`…/live-execution-registry(?:\.[cm]?[jt]s)?`) names the module rather than
 * the file.
 */
export function resolvesInRepo(repoPath) {
  const absolute = path.join(REPO_ROOT, repoPath);
  if (existsSync(absolute)) return true;
  const parent = path.dirname(absolute);
  if (!existsSync(parent)) return false;
  const stem = `${path.basename(absolute)}.`;
  return readdirSync(parent).some((entry) => entry.startsWith(stem));
}

/**
 * True for a file a rule scope can be written in, which excludes a module that
 * exists only so tests can run.
 *
 * Both halves are asked of `test-file-spellings.ts`, which owns the one
 * declaration of the markers and extensions this repository spells a test
 * module with — the extension half by handing that predicate the test-file
 * spelling of the extension in question, because the extension set is reachable
 * only through it. Respelling either set here is a copy that drifts: an
 * extension left out makes a rule written in it invisible to this gate
 * entirely, and a marker left out walks a test-support module as a rule and
 * gates its fixture paths as scopes. That is the silent disarm this gate exists
 * to refuse, one level in — and this exact set has already drifted once, which
 * is why the declaration exists.
 */
export function isGovernedModule(fileName) {
  return (
    TEST_FILE_PATTERN.test(`module.test${path.extname(fileName)}`) &&
    !TEST_FILE_PATTERN.test(fileName)
  );
}

// A governed tree that is not there throws out of `statSync` rather than
// reading as empty: a gate that reports nothing over a tree it never found is
// the failure it exists to refuse, one level in. The colocated test names each
// tree so the abort arrives as an assertion rather than an ENOENT.
//
// The fixture skip keys on the directory NAME and nothing else, so a corpus
// renamed out of that shape is walked as rule source and any path-shaped
// literal inside it becomes a gated scope. It is a prefix test rather than a
// glob: a name starting `__test-fixtures-` is skipped whether or not it closes
// with a trailing `__`.
function sourceModulesUnder(target) {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('__test-fixtures-')) return [];
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) return sourceModulesUnder(full);
    return isGovernedModule(entry.name) ? [full] : [];
  });
}

/**
 * Every governed module that names at least one repo-relative path, config-
 * relative, with the paths it names whole and the prefixes it splices one out
 * of.
 *
 * A module that exists only so tests can run is out of scope by construction:
 * its path constants are fixture filenames handed to a rule as text, invented
 * to exercise a scope rather than to name a tree. Reading those is what would
 * force this gate to be opted into instead of inherited.
 */
export function governedModuleNamedPaths() {
  return GOVERNED_TREES.flatMap((tree) => sourceModulesUnder(path.join(CONFIG_ROOT, tree)))
    .map((file) => ({
      module: path.relative(CONFIG_ROOT, file),
      ...readPaths(readFileSync(file, 'utf8'), file),
    }))
    .filter(({ named, spliced }) => named.length + spliced.length > 0)
    .toSorted((a, b) => a.module.localeCompare(b.module));
}

/**
 * The paths a rule names with nothing deliberately there, each with the reason
 * it names nothing. An entry here is the decision that a scope points at
 * absence; every other path a governed module names must resolve.
 */
export const SYNTHETIC_RULE_PATHS = {
  'arch/lib/source-scope.ts': {
    'packages/config/src':
      'An excluded-tree entry whose entire content is that the directory is not there, so holding this package out of the scanned trees stays a recorded decision rather than an accident.',
  },
};

/**
 * One module's disarmed scopes: the paths it names that neither resolve nor
 * are declared to name absence, plus every path it splices — which is refused
 * whether or not its prefix resolves, because what the splice produces was
 * never read. Each in the form a reader can act on.
 *
 * Separate from the walk so the reporting arm is exercised by tests of its
 * own. A gate whose failure path runs only once the repository is already
 * broken is a gate nobody has watched work.
 */
export function disarmedPathsIn({ module, named, spliced = [] }) {
  return [
    ...named
      .filter(
        (candidate) =>
          !resolvesInRepo(candidate) && SYNTHETIC_RULE_PATHS[module]?.[candidate] === undefined
      )
      .map((candidate) => `${module} names '${candidate}'`),
    ...spliced.map(
      (candidate) => `${module} splices a path onto '${candidate}', which nothing can check`
    ),
  ];
}

/** Every disarmed scope across every governed tree. */
export function unresolvedNamedPaths() {
  return governedModuleNamedPaths().flatMap((entry) => disarmedPathsIn(entry));
}
