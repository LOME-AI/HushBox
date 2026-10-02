/**
 * Checks that a cross-reference an author opted into actually resolves.
 *
 * The rule is opt-in by construction, and that is the whole of its safety. It
 * checks a reference written in one of two forms — a `{@link}` tag naming a
 * symbol, a backticked path for a file — and never asks whether a comment ought
 * to have used one. A rule that demanded the form would be a style mandate over
 * every comment in the repository and would fire hardest on comments that name
 * nothing at all; a rule that checks only what an author opted into cannot
 * produce that class of noise.
 *
 * Symbol resolution is by WHAT THE FILE DECLARES, never by type information.
 * The property being enforced is that a reader of this file can find the thing
 * named. A scope binding is most of that answer but not all of it, so the
 * declarations that bind no variable are collected beside the bindings.
 * Resolving through the type checker was rejected: it would make the lint gate
 * depend on a program-wide type build for a comment check.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/**
 * Resolution is anchored to this module's own location rather than to a linting
 * cwd: every package lints from its own base path, so a cwd-anchored root would
 * give a different answer per package for the same token.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

const ALL_FORMS = ['symbol', 'path'];

/**
 * Omitting the option gives the form the repository ships, never the one held
 * back: a default that enables an unselected form restores it silently at the
 * next registration written without arguments. Selecting the path form is a
 * decision, so it must be visible as an argument at the registration site.
 */
const DEFAULT_FORMS = ['symbol'];

/**
 * JSDoc's `{@link}` carries either a symbol or a URL. The property enforced is
 * that a reader can follow the reference; a URL is followable on its own, so
 * whether it is bound in this file is the wrong question to ask of one.
 */
const URL_TARGET = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The link target is the first token after `{@link}`. The `[\s*]*` run absorbs
 * the leading asterisks of a block comment's continuation lines, so a reference
 * that wraps across lines still yields its target rather than an asterisk.
 */
const LINK_REFERENCE = /\{@link\b[\s*]*([^\s|}]+)/g;

const BACKTICKED_TOKEN = /`([^`\n]+)`/g;

/** Ends the leading segment of a member reference: `Foo.bar` and `Foo#bar`. */
const MEMBER_SEPARATOR = /[.#]/;

/** Existence is asked once per distinct token across a whole lint run. */
/** @typedef {ReturnType<import('eslint').SourceCode['getAncestors']>[number]} AstNode */
/**
 * A comment as the parser hands it over: ESTree types the position members as
 * optional, and every parser this repository runs sets them.
 * @typedef {import('eslint').AST.Program['comments'][number] & { range: [number, number] }} LocatedComment
 */

/** @type {Map<string, boolean>} */
const existenceCache = new Map();

/**
 * The listing is one process for a whole lint run, so its size is bounded by
 * the repository rather than by the file being linted. Overrunning the cap
 * fails the read, which the caller turns into a raise — the same disposition
 * as any other unreadable index, and never a quiet empty answer.
 */
const LISTING_CAP_BYTES = 64 * 1024 * 1024;

const UNREADABLE_INDEX =
  "the path form anchors and resolves every citation on the repository's git-tracked entries, and they could not be read. Run the gate inside a readable git working tree, or deselect the path form at the registration.";

const UNREADABLE_HISTORY =
  "the path form admits a bare filename by the names the checked-out commit's history has tracked at the repository root, and that history could not be read. Run the gate inside a git working tree with at least one commit, or deselect the path form at the registration.";

/**
 * @typedef {object} TrackedTree
 * @property {ReadonlySet<string>} roots the repository-root entries
 * @property {ReadonlySet<string>} paths every tracked file and every directory holding one
 * @property {ReadonlySet<string>} rootFiles every file git tracks at the repository root, or has tracked there in the checked-out commit's history
 */

/** @type {TrackedTree | null} */
let trackedTree = null;

/**
 * What git TRACKS, as the one answer both halves of the path form consult: the
 * anchor asks whether a token's first segment is a root entry, or whether a
 * bare filename is a root file now or in history, and resolution asks whether
 * the whole token is a tracked file or a directory holding one.
 *
 * The distinction from the working tree is the whole point. An untracked path
 * — a build artifact, a run's report directory, a tool's scratch path,
 * another workstream's leftovers — would otherwise make a citation of it read
 * as a repository path, or resolve, on the machine that happens to have it and
 * not on one that does not, so the same committed comment would get two
 * verdicts and a clean checkout would disagree with every working machine.
 * Asking the index makes the gate answer the same question everywhere it runs.
 * The cost is that a correct citation of output generated at build or run time
 * reports on every machine alike, and takes a suppression naming why.
 *
 * Read from the index rather than from a commit, because tracked means staged:
 * a path added but not yet committed is one a citation may legitimately name.
 *
 * @returns {TrackedTree}
 */
function readTrackedTree() {
  if (trackedTree !== null) return trackedTree;
  let listing;
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a prerequisite of the checkout this rule reads, and a checkout that cannot run it raises below rather than passing quietly
    listing = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: LISTING_CAP_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Raising is the requirement, not a precaution. An unreadable index
    // treated as "no entry matches" admits no token as a path, so every path
    // citation in the repository stops being checked while the run still
    // reports clean — an instrument that examines nothing is indistinguishable
    // from one that examined everything and found nothing.
    throw new Error(UNREADABLE_INDEX, { cause: error });
  }
  /** @type {Set<string>} */
  const roots = new Set();
  /** @type {Set<string>} */
  const paths = new Set();
  const rootFiles = readRootFileHistory();
  for (const file of listing.split('\u0000')) {
    if (file === '') continue;
    const segments = file.split('/');
    roots.add(/** @type {string} */ (segments[0]));
    if (segments.length === 1) rootFiles.add(file);
    for (let depth = 1; depth <= segments.length; depth++) {
      paths.add(segments.slice(0, depth).join('/'));
    }
  }
  // With no index file git lists nothing and exits cleanly, so an empty
  // listing is the unreadable case that no failed command announces. It is
  // never a real answer: this rule's own configuration is a tracked file.
  if (roots.size === 0) throw new Error(UNREADABLE_INDEX);
  trackedTree = { roots, paths, rootFiles };
  return trackedTree;
}

/**
 * Every file ever added at the repository root in the history of the checked-
 * out commit. Read from HEAD rather than from every ref, because a local
 * branch or a stash exists on one machine and not on another, and the verdict
 * on a committed comment must not depend on which machine asks.
 *
 * Renames are read as a deletion plus an addition, so a file renamed into the
 * root is listed by its root name. `--root` holds the first commit's files in
 * the answer whatever `log.showRoot` says.
 *
 * @returns {Set<string>}
 */
function readRootFileHistory() {
  const filter = ['--no-renames', '--diff-filter=A', '-z', '--', ':(glob)*'];
  const argv = ['log', 'HEAD', '--root', '--format=', '--name-only', ...filter];
  let listing;
  try {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a prerequisite of the checkout this rule reads, and a checkout that cannot run it raises below rather than passing quietly
    listing = execFileSync('git', argv, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: LISTING_CAP_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Raising for the same reason the index read does: an unreadable history
    // treated as "no name was ever at the root" admits no bare filename, so
    // every root citation stops being checked while the run reports clean.
    throw new Error(UNREADABLE_HISTORY, { cause: error });
  }
  return new Set(listing.split('\u0000').filter((file) => file !== ''));
}

/**
 * Normalised so a trailing slash or an inner `./` names the same entry the
 * listing does.
 *
 * @param {string} candidate
 */
function isTracked(candidate) {
  return readTrackedTree().paths.has(path.posix.normalize(candidate).replace(/\/$/, ''));
}

/**
 * A trailing line or line-range citation. It is stripped before the token is
 * resolved, so `file.ts:72` resolves exactly as `file.ts` does. The rule
 * therefore never checks whether the line says what the citation claims; that
 * is the accepted cost of admitting a spelling the repository already uses.
 * The pattern is deliberately numeric: `file.ts:someSymbol` keeps its suffix
 * and so is reported, which is what makes a dead file-plus-symbol citation
 * visible rather than silently half-checked.
 */
const LINE_SUFFIX = /:\d+(?:-\d+)?$/;

/**
 * TypeScript's module specifiers name the EMITTED file, so a comment quoting an
 * import writes `.js` where the module on disk is `.ts`. Rewriting the
 * extension is what lets such a comment agree with the import it describes
 * instead of being corrected into disagreement with it.
 */
const MODULE_SPECIFIER_TWINS = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
]);

/** @param {string} token */
function resolutionCandidates(token) {
  const bare = token.replace(LINE_SUFFIX, '');
  const extension = path.extname(bare);
  const twins = MODULE_SPECIFIER_TWINS.get(extension) ?? [];
  return [bare, ...twins.map((twin) => bare.slice(0, -extension.length) + twin)];
}

/** @param {string} token */
function existsInRepo(token) {
  const cached = existenceCache.get(token);
  if (cached !== undefined) return cached;
  const answer = resolutionCandidates(token).some((candidate) => isTracked(candidate));
  existenceCache.set(token, answer);
  return answer;
}

/**
 * Syntax that makes a token a pattern or a template rather than a path: a glob
 * star, and an angle-bracket placeholder standing in for a name the writer is
 * generalising over.
 */
const NON_PATH_SYNTAX = /[*<]/;

/**
 * The admission test for the path form, and the whole of what separates a path
 * citation from every other backticked token.
 *
 * A token is read as a repo-relative path when its FIRST SEGMENT names a
 * GIT-TRACKED entry at the repository root. That single question is what
 * declines an npm specifier (`@hushbox/shared`), an ESLint rule id
 * (`boundaries/dependencies`), an HTTP route (`/api/chat`, whose first segment
 * is empty), a package-relative path (`lib/rate-limit`) and a bare directory
 * label (`public/`) — none of which a reader could follow from the root, and
 * all of which the form reported before the anchor existed.
 *
 * The same question declines a specifier relative to the citing file (`./x`,
 * `../x`), because git never lists a `.` or `..` segment. Resolving such a
 * token against the citing file's own directory would be strictly better and
 * is deliberately not done here, because it would report citations nobody has
 * yet looked at.
 *
 * A token with no slash is read as a path only when it names a FILE git tracks
 * at the repository root or has tracked there in the checked-out commit's
 * history. History is what lets a root file's citations report once the file
 * is deleted or renamed away: a name admitted only while it exists stops being
 * admitted the moment it goes stale. Every other bare filename stays outside,
 * because most of them name a sibling file, a third-party file or a
 * placeholder, and admitting them all reports far more false citations than
 * stale ones.
 *
 * What the anchor gives up, knowingly: a citation rooted at a top-level
 * directory that has been DELETED — or that git never tracked, which is how a
 * generated or ignored root directory reads — is never reported, though the
 * first of those is a stale citation of the most valuable kind. Globs and
 * file-relative specifiers are declined for the same kind of reason and at the
 * same kind of cost — each goes stale exactly as a path does when the tree it
 * names is renamed. An angle-bracket template is declined whole, so its FIXED
 * part is never checked either: a template spelled as a slice directory with a
 * placeholder for the slice's name stays silent when `apps/api/src/slices` is
 * renamed, although the part before its placeholder has then gone stale.
 *
 * A bare filename resolves against the root alone. A citation meaning a
 * nested file that shares a current root file's name — a package's own
 * manifest beside the root `package.json` — is therefore never reported either
 * way, while one meaning a nested file that shares a DELETED root file's name
 * reports although nothing about it is stale. That citation, like a correct
 * citation of a generated file once committed at the root, is rewritten in a
 * form that is not a path or takes a suppression naming why. A root file that
 * left the tree before the earliest commit a checkout holds, as in a shallow
 * clone, is unknown to that checkout, so a full clone admits and reports its
 * citations while that checkout does not.
 */
/** @param {string} token */
function isPathToken(token) {
  if (token.startsWith('-') || NON_PATH_SYNTAX.test(token)) return false;
  if (!token.includes('/')) return readTrackedTree().rootFiles.has(token.replace(LINE_SUFFIX, ''));
  // A path always has a first segment.
  return readTrackedTree().roots.has(/** @type {string} */ (token.split('/')[0]));
}

/** Every name bound anywhere in the file, across every scope. */
/** @param {import('eslint').SourceCode} sourceCode */
function boundNames(sourceCode) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {import('eslint').Scope.Scope} scope */
  const visit = (scope) => {
    for (const variable of scope.variables) names.add(variable.name);
    for (const child of scope.childScopes) visit(child);
  };
  // A parsed program always has a global scope.
  visit(/** @type {import('eslint').Scope.Scope} */ (sourceCode.scopeManager.globalScope));
  return names;
}

/**
 * Members of a declaration body. A scope variable is not the whole of what a
 * file declares: a class method, an interface member and a type-literal member
 * are each written in the file the reader is holding, yet none of them binds
 * one, so a binding-only answer reports a reference the reader can follow on
 * sight. Selecting on the enclosing body rather than on the member's own node
 * type keeps a member kind the parser gains later inside the answer, but only
 * where that kind names itself through an identifier `key` — the sole place a
 * name is read from. A kind naming itself any other way reaches the handler,
 * contributes nothing, and a reference to it is reported.
 *
 * A key of an object literal or of a destructuring pattern is deliberately
 * outside this: it is a value's key, not a declaration, and admitting it would
 * resolve a reference against any data row that happens to carry the field. An
 * enum body is absent because its members do bind variables of their own.
 */
const DECLARED_MEMBER = ['ClassBody > *', 'TSInterfaceBody > *', 'TSTypeLiteral > *'].join(', ');

/**
 * Names a re-export writes. The same gap as a member declaration and named as
 * such by the rule's first audit, which left it alone for want of a live
 * instance: `export { name } from …` binds nothing, while a reader inside a
 * barrel follows the name straight to the module beside it. Both sides of an
 * alias count, because both are written here.
 */
const RE_EXPORTED_NAME = [
  'ExportNamedDeclaration[source] > ExportSpecifier',
  'ExportAllDeclaration[exported]',
].join(', ');

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Check that a cross-reference written in a comment resolves — a {@link} to a declaration in its own file, a backticked path to something in the repository.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          forms: {
            type: 'array',
            items: { enum: ALL_FORMS },
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unresolvedSymbol:
        '{@link {{name}}} names nothing this file declares — a reader cannot follow it. Name a symbol this file declares, imports or re-exports, or drop the {@link} wrapper and write the name as prose.',
      unresolvedPath:
        "'{{name}}' reads as a path but git tracks nothing there relative to the repository root. Correct it to a real repo-relative path, or write it in a form that is not a path.",
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const sourceCode = context.sourceCode;
    const forms = new Set(context.options[0]?.forms ?? DEFAULT_FORMS);
    // Read here rather than at the first path-shaped token: a run whose files
    // happen to carry none would otherwise finish clean on an unreadable
    // index, which is the silence this rule refuses.
    if (forms.has('path')) readTrackedTree();

    /**
     * @param {LocatedComment} comment
     * @param {RegExpExecArray} match
     * @param {string} messageId
     * @param {string} name
     */
    const reportAt = (comment, match, messageId, name) => {
      const start = comment.range[0] + match.index;
      context.report({
        loc: {
          start: sourceCode.getLocFromIndex(start),
          end: sourceCode.getLocFromIndex(start + match[0].length),
        },
        messageId,
        data: { name },
      });
    };

    /**
     * @param {LocatedComment} comment
     * @param {string} body
     * @param {ReadonlySet<string>} bound
     */
    const checkSymbols = (comment, body, bound) => {
      for (const match of body.matchAll(LINK_REFERENCE)) {
        // The pattern's capture group is not optional, so a match always fills it.
        const target = /** @type {string} */ (match[1]);
        // A member reference resolves on its leading segment: the file binds
        // `Foo`, and `Foo.bar` is a member of whatever `Foo` is. JSDoc spells
        // an instance member with a hash, so both separators end the segment.
        if (
          URL_TARGET.test(target) ||
          bound.has(/** @type {string} */ (target.split(MEMBER_SEPARATOR)[0]))
        )
          continue;
        reportAt(comment, match, 'unresolvedSymbol', target);
      }
    };

    /**
     * @param {LocatedComment} comment
     * @param {string} body
     */
    const checkPaths = (comment, body) => {
      for (const match of body.matchAll(BACKTICKED_TOKEN)) {
        // The pattern's capture group is not optional, so a match always fills it.
        const token = /** @type {string} */ (match[1]);
        if (!isPathToken(token) || existsInRepo(token)) continue;
        reportAt(comment, match, 'unresolvedPath', token);
      }
    };

    /** @type {Set<string>} */
    const declared = new Set();
    /** @param {AstNode | null | undefined} node */
    const declare = (node) => {
      if (node?.type === 'Identifier') declared.add(node.name);
    };

    return {
      /** @param {AstNode & { key?: AstNode }} node */
      [DECLARED_MEMBER](node) {
        declare(node.key);
      },
      /** @param {AstNode & { local?: AstNode, exported?: AstNode }} node */
      [RE_EXPORTED_NAME](node) {
        declare(node.local);
        declare(node.exported);
      },
      'Program:exit'() {
        const bound = forms.has('symbol') ? boundNames(sourceCode) : null;
        if (bound !== null) for (const name of declared) bound.add(name);
        const text = sourceCode.getText();

        for (const comment of /** @type {readonly LocatedComment[]} */ (
          sourceCode.getAllComments()
        )) {
          const body = text.slice(comment.range[0], comment.range[1]);
          if (bound !== null) checkSymbols(comment, body, bound);
          if (forms.has('path')) checkPaths(comment, body);
        }
      },
    };
  },
};
