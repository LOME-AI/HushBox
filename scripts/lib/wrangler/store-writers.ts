/**
 * What in this repository can cause a wrangler-shaped local store to be written
 * so far as reading its text can tell, and what each one says about where those
 * writes land.
 *
 * The store is miniflare's, and there are two doors to it, so a check written
 * over either one alone answers a narrower question than it appears to:
 *
 * - **The `wrangler` program**, run from a shell or a spawn. Its local-capable
 *   commands take local mode when neither `--local` nor `--remote` is given —
 *   `isLocal` defaults to `true` — and a local write with no `--persist-to`
 *   lands in one directory per checkout that every process shares.
 * - **A module that embeds the runtime**, configured in-process. Here the
 *   persistence is an option rather than a flag, and the file need not contain
 *   the word `wrangler` at all.
 *
 * Both are judged, and neither is judged completely, because this scan reads
 * text and the property is about writes. **What holds the property is the
 * default store itself, left behind as a directory nothing can write.** The two
 * doors meet it differently, and only one of them says so: the program exits
 * non-zero with an `EACCES` naming the path, while the embedded runtime logs
 * that same error and then never settles, which inside a test runner is a
 * timeout no assertion accounts for. This scan is the layer in front of that —
 * it catches the ordinary spelling while somebody is still reading the diff —
 * and a green from it is fast feedback rather than a guarantee.
 *
 * What it does read, it reads over what makes something a writer rather than
 * over the writers that exist while it is being written: every tracked file
 * whose extension it knows and every one whose name declares no kind, the
 * program token by what puts a token in program position rather than by the
 * spellings in front of it, a character that means one thing in one language
 * and another in the next by the language of the file it sits in, and the
 * second door through every dependency from which the runtime is reachable at
 * any depth.
 *
 * Most of what it can get wrong it gets wrong loudly: an invocation whose
 * window carries no declaration is `none`, a command absent from the small
 * exception set is held to the rule rather than excused by it, and a dependency
 * that reaches the runtime and nobody has classified fails the derivation.
 * The limits it is known to have are stated once at
 * {@link findLocalStoreWriters}, each naming the reading that decides it. That
 * list is short of the whole of what this cannot see, which is why the store
 * above rather than this scan is what holds the property.
 */

import path from 'node:path';

/**
 * The file kinds this scan opens. It is a list of names rather than a property
 * of a file, so it is also the first of the limits at
 * {@link findLocalStoreWriters}: a tracked kind absent from it goes unread
 * whether or not it runs a program.
 *
 * A name carrying no extension declares no kind at all, so it is read rather
 * than assumed inert: this repository tracks its git hooks, a container
 * definition and its mobile build files that way, and several of those run
 * programs.
 */
export const SCANNED_EXTENSIONS: readonly string[] = [
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
];

/**
 * A lockfile carries a resolved dependency graph in a file kind that otherwise
 * runs programs, and names every package in it thousands of times.
 */
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json']);

/**
 * What a runtime-embedding module does when its configuration says nothing
 * about persistence. The two answers differ, so one rule for both would be
 * wrong in one direction or the other, and each was established by running it.
 *
 * - `default-location` — wrangler's own worker API persists to
 *   `<config dir>/.wrangler/state` when given no `persist`. Silence is the
 *   defect.
 * - `ephemeral` — `@cloudflare/vitest-pool-workers` sets no persist root at
 *   all, so miniflare falls back to a per-instance temp directory its own exit
 *   hook removes. Verified by running this repository's `api` and `db` workers
 *   projects with a stamped tree: neither modified anything under any
 *   `.wrangler` in the checkout. Silence is correct; switching persistence on
 *   without naming a path is the defect.
 *
 * The set is held complete by a test that derives it from the workspace's own
 * declared dependencies through {@link runtimeEmbedders} — every dependency
 * from which miniflare is reachable, by a direct declaration, a peer
 * declaration or any depth of further dependencies, must be classified here —
 * so a new door to the runtime fails rather than passing unseen.
 */
export type SilenceMeaning = 'default-location' | 'ephemeral';

export const RUNTIME_MODULES: ReadonlyMap<string, SilenceMeaning> = new Map(
  // Written as mapping keys rather than argv-shaped pairs: a specifier in the
  // head of an array is a program argument by shape, so a table spelled that
  // way is a writer by this scan's own rule and the module would need an
  // exemption from itself.
  Object.entries({
    wrangler: 'default-location',
    '@cloudflare/vitest-pool-workers': 'ephemeral',
    miniflare: 'ephemeral',
  } satisfies Readonly<Record<string, SilenceMeaning>>)
);

/** The package every one of those modules embeds, and the reason they are the set. */
export const RUNTIME_PACKAGE = 'miniflare';

/**
 * The dependency edges a manifest declares. All three kinds reach the same
 * installed package, and a runtime declared as a peer is one the importing
 * package still starts, so the walk below follows them alike.
 */
export interface DependencyManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/** What is installed under `from` for `name`, or nothing when it is not installed there. */
export type InstalledManifests = (
  from: string,
  name: string
) => { readonly directory: string; readonly manifest: DependencyManifest } | undefined;

function declaredEdges(manifest: DependencyManifest): string[] {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  });
}

/**
 * Which of `declared` can reach {@link RUNTIME_PACKAGE} — the package itself, a
 * dependency that declares it, or one that reaches it through any depth of
 * further dependencies, which is how the second door is usually installed: a
 * test pool declares the CLI, and the CLI declares the runtime.
 *
 * Reachability, not a direct edge: a package one hop further away opens the
 * same door, so a predicate reading only the immediate declarations would pass
 * a new door silently. Each resolved package is walked once.
 */
export function runtimeEmbedders(
  installed: InstalledManifests,
  from: string,
  declared: readonly string[]
): string[] {
  const walked = new Map<string, boolean>();
  const reaches = (directory: string, name: string): boolean => {
    if (name === RUNTIME_PACKAGE) return true;
    const found = installed(directory, name);
    if (found === undefined) return false;
    const already = walked.get(found.directory);
    if (already !== undefined) return already;
    walked.set(found.directory, false);
    const embeds = declaredEdges(found.manifest).some((edge) => reaches(found.directory, edge));
    walked.set(found.directory, embeds);
    return embeds;
  };
  return declared.filter((name) => reaches(from, name));
}

/**
 * wrangler subcommands that reach the Cloudflare API and offer no local mode:
 * each was run with `--help` against the installed wrangler and declares
 * neither `--local`, `--remote` nor `--persist-to`, so no declaration can be
 * asked of them.
 *
 * The set names exceptions rather than the rule, which is what keeps it safe as
 * wrangler grows: a command absent from it is held to the declaration rule, so
 * a newly used local-capable command fails until somebody looks at it.
 */
const COMMANDS_WITHOUT_LOCAL_MODE: readonly string[] = [
  'deploy',
  'pages deploy',
  'secret list',
  'secret put',
];

/**
 * The one shared builder of `r2 object put` argv. Recognised by name because
 * the mode flags it emits are the same two literals this scan looks for, and
 * its own tests hold it to emitting one of them for every target; a
 * second builder would go unrecognised here and fail, which is the direction
 * that keeps the rule honest.
 */
const SHARED_ARGV_BUILDER = 'r2PutArgs';

/**
 * What a writer says about where its writes land. `no-local-mode` and
 * `ephemeral` are the writer answering for itself; `none` is the failure this
 * scan exists to catch.
 */
export type ModeDeclaration =
  | 'remote'
  | 'persist'
  | 'shared-builder'
  | 'no-local-mode'
  | 'ephemeral'
  | 'none';

export interface LocalStoreWriter {
  /** Repository-relative path of the file that can write a store. */
  readonly file: string;
  /** 1-based line of the program token or the module specifier. */
  readonly line: number;
  /** The subcommand words, or `(module <specifier>)` for an embedded runtime. */
  readonly command: string;
  readonly declares: ModeDeclaration;
}

/** The paths from a `git ls-files -z` listing whose files this scan reads. */
export function scanTrackedFiles(listing: string): string[] {
  return listing
    .split('\0')
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      const extension = path.extname(entry);
      return extension === '' || SCANNED_EXTENSIONS.includes(extension);
    })
    .filter((entry) => !LOCKFILES.has(path.basename(entry)));
}

/** The writers that say nothing about where their writes land. */
export function undeclared(writers: readonly LocalStoreWriter[]): readonly LocalStoreWriter[] {
  return writers.filter((one) => one.declares === 'none');
}

/**
 * The `wrangler` word wherever it names the program: the bare command, the same
 * word pinned to a version (which is how a package runner is told which one to
 * fetch), the head of an identifier (the binary is sometimes reached through a
 * resolved path held in one), and the executable JavaScript entry point that
 * path ends at. Never a directory segment (`.wrangler`) or a sibling file
 * (`wrangler.toml`, `wrangler-dev.js`).
 *
 * A dependency declaration is kept out by the mapping-key lookahead alone,
 * pinned or not — `"wrangler":` and `'wrangler@4.129.0':` are both keys — which
 * is why the pinned form can be admitted here without admitting the manifest
 * that names it.
 *
 * Widening the word costs nothing, because program position decides what counts
 * — and a spelling this narrows away is one the rule would never see again.
 */
const VERSION_PIN = String.raw`[\w.^~+-]`;
const PROGRAM_TOKEN = new RegExp(
  String.raw`(?<![\w.@-])wrangler(?:\.[cm]?js)?(?:@${VERSION_PIN}+(?!${VERSION_PIN}))?(?![./@-]|["'\`]?\s*:)`,
  'g'
);

/**
 * What puts a token in program position: it opens a command string, and a
 * command string opens in exactly three places.
 *
 * - **A shell line** — the start of a line, or whatever a shell treats as the
 *   start of the next command on one.
 * - **A structured-data scalar value** — the value half of `key: value`, which
 *   is how a package manifest's script and a workflow's `run` name a program.
 * - **An argv element** — the program argument of a spawn, or the head of the
 *   array carrying its argv.
 *
 * Everywhere else the word is passed over, which is right where it is prose — a
 * test name, an error message, a sentence in a string — and wrong where it is a
 * command line none of these three openings reaches.
 */
const COMMAND_STRING_OPENS = String.raw`(?:^|\n|\|\||\||&&|;|\$\()`;
const SHELL_LINE_START = new RegExp(String.raw`${COMMAND_STRING_OPENS}[^\S\n]*$`);
const SCALAR_VALUE_START = /:[^\S\n]*$/;
const SPAWN_PROGRAM_ARGUMENT = /[([]\s*$/;
const SPAWN_ARGV_HEAD = /\[\s*$/;

/**
 * An argv element in structured data. The three openings above are spelled in a
 * JavaScript source's punctuation; a workflow spells the same argv element as a
 * block-sequence item — `- wrangler` under an `args` key is that list with
 * different punctuation — and reading only the bracket form leaves the whole
 * list invisible in a file kind this scan reads.
 *
 * A sequence has no bracket to close it, so indentation is what bounds it: the
 * element ends where its own line does, and the sequence ends at the first line
 * that is not an item indented at least as far as the item carrying the
 * program.
 */
const BLOCK_SEQUENCE_ITEM = /^[^\S\n]*-[^\S\n]+["']?$/;
const BLOCK_SEQUENCE_ELEMENT_ENDS = /^["']?[^\S\n]*(?:\n|$)/;
const BLOCK_SEQUENCE_CONTINUES = /^[^\S\n]*-[^\S\n]/;

/** The program's own line: everything from the last line break onwards. */
function currentLine(head: string): string {
  return head.slice(head.lastIndexOf('\n') + 1);
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * A sequence element carrying a version pin is a dependency declaration rather
 * than a program: `- wrangler@4.129.0` in a version list is the sequence
 * spelling of the mapping `\"wrangler\": \"4.129.0\"`, which the program token's
 * mapping-key lookahead already keeps out. Both name a package at a version and
 * neither runs anything — what makes a pin a program is a package runner in
 * front of it, telling the runner which one to fetch, and an element standing
 * alone has none.
 */
function carriesAVersionPin(token: string): boolean {
  return token.includes('@');
}

/**
 * Outside quotes there is no bound on what stands between the opening and the
 * program, and no need for one: the environment a line exports, the runner, its
 * filters and its argument separator are all head, and none of them can carry a
 * quote character — a quote would put the program inside a string, where the
 * rules below take over. So the head is read back to the opening rather than
 * counted in words, and a count is what every spelling missed so far had in
 * common.
 */
const UNQUOTED_HEAD = String.raw`[^\n'"\`]*`;
const UNQUOTED_SHELL_LINE = new RegExp(String.raw`${COMMAND_STRING_OPENS}${UNQUOTED_HEAD}$`);
const UNQUOTED_SCALAR_VALUE = new RegExp(String.raw`:${UNQUOTED_HEAD}$`);

/**
 * A scalar value is a command string whether or not its own syntax quotes it —
 * a manifest's script and a workflow's `run` are the same opening, and one of
 * them is written inside quotes because JSON has no other way to write a
 * string. So the head inside those quotes is read like any other unquoted head,
 * which is what lets a manifest script name a runner, a workspace filter or an
 * environment variable before it names the program.
 */
const QUOTED_SCALAR_VALUE = new RegExp(String.raw`:\s*["'\`]${UNQUOTED_HEAD}$`);

/**
 * Some characters mean one thing in one language and another in the next, and
 * the file says which language it is in. Every reading below was established by
 * running the wrong one over the tree, and every wrong one reported a line that
 * runs nothing or read a line that runs something as declared when it is not.
 *
 * - **A backtick** opens a command substitution in a shell — including a git
 *   hook, which carries no extension at all — and a template literal in a
 *   JavaScript source, where the tag in front of it rather than the character
 *   itself decides whether what follows is a command line or a sentence.
 * - **A quoted scalar value** is data in a manifest or a workflow, so a program
 *   named in one is a program something runs; the same shape in a JavaScript
 *   source is an object property, and its value is arbitrary text.
 * - **A comment opener** is a slash pair in a JavaScript source and a hash in a
 *   shell, a workflow or a file whose name declares no kind; JSON has neither.
 *   Reading one language's opener in another's file cuts a line mid-expression
 *   — a shell parameter substitution carries a slash pair — which leaves a
 *   bracket unbalanced and the invocation window open past the end of its own
 *   command, so a later command's flag reads as this one's declaration.
 * - **A block-sequence item** is an argv element in a workflow and nothing at
 *   all in the other kinds, which is why {@link BLOCK_SEQUENCE_ITEM} is asked
 *   of one and not the others.
 */
interface FileSyntax {
  /** Where a comment begins on a line, or nothing where the language has none. */
  readonly commentOpens: RegExp | undefined;
  /**
   * Whether the file is a JavaScript source, which is one fact deciding four
   * readings: a comment runs over lines whose continuations open with `*`, a
   * backtick opens a tagged template rather than a command substitution, a
   * quoted scalar is an object property rather than a command string, and a
   * quote is the language's own string delimiter rather than shell quoting, so
   * none of the openings below is held to {@link quotesClose}.
   *
   * {@link commentBegins} is the exception, and it is asked of every kind
   * including this one — one of the limits at {@link findLocalStoreWriters}.
   */
  readonly javaScriptSource: boolean;
  readonly quotedScalarIsACommandString: boolean;
  readonly blockSequenceIsArgv: boolean;
}

const JAVASCRIPT_SOURCES = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);
const STRUCTURED_DATA_SOURCES = new Set(['.json', '.yml', '.yaml']);
const BLOCK_SEQUENCE_SOURCES = new Set(['.yml', '.yaml']);
const SLASH_COMMENT = /(?<![:/])\/\/(?!\/)/g;
const HASH_COMMENT = /(?<=^|\s)#/g;
const SUBSTITUTION_OPENS = new RegExp(String.raw`\`${UNQUOTED_HEAD}$`);

/**
 * A tagged template is a call, so the tag decides what the template means and
 * the backtick alone cannot: `$({ cwd })\`…\`` and `execa\`…\`` run what
 * follows, while the same character after `(`, `,` or `=` opens an argument or
 * an assignment whose content is as often a sentence. What a tag expression
 * ends in is what is read — a name, or the closing bracket of the call or index
 * that produced it — rather than any one spelling of a tag.
 */
const TAG_EXPRESSION_ENDS = String.raw`[\w$)\]]`;
const TAGGED_TEMPLATE_OPENS = new RegExp(String.raw`${TAG_EXPRESSION_ENDS}\`${UNQUOTED_HEAD}$`);

function commentOpenerOf(extension: string): RegExp | undefined {
  if (JAVASCRIPT_SOURCES.has(extension)) return SLASH_COMMENT;
  if (extension === '.json') return undefined;
  return HASH_COMMENT;
}

function syntaxOf(file: string): FileSyntax {
  const extension = path.extname(file);
  return {
    commentOpens: commentOpenerOf(extension),
    javaScriptSource: JAVASCRIPT_SOURCES.has(extension),
    quotedScalarIsACommandString: STRUCTURED_DATA_SOURCES.has(extension),
    blockSequenceIsArgv: BLOCK_SEQUENCE_SOURCES.has(extension),
  };
}

/**
 * Where a comment begins on a line: the first opener the line's own quotes do
 * not hold inside a string, because a hash in an echoed message and a slash
 * pair in a string literal open nothing. Cutting the line at one of those would
 * take the rest of it — a whole invocation, and silently.
 *
 * The quote reading is asked of every file kind, a JavaScript source included,
 * where the language's own quote characters are what it counts; what that costs
 * is a limit at {@link findLocalStoreWriters}.
 */
function commentBegins(line: string, opener: RegExp): number {
  for (const match of line.matchAll(opener)) {
    if (quotesClose(line.slice(0, match.index))) return match.index;
  }
  return -1;
}

/**
 * Blanks comments while keeping every newline, so reported line numbers stay
 * the file's own. Dropped in both directions for one reason: a commented-out
 * invocation runs nothing, and a comment beside a live one is prose the
 * invocation's window would otherwise read as its own flags.
 *
 * A block comment opening a line is blanked with that line.
 */
function withoutComments(text: string, syntax: FileSyntax): string {
  const opener = syntax.commentOpens;
  if (opener === undefined) return text;
  return text
    .split('\n')
    .map((line) => {
      const start = line.trimStart();
      if (
        syntax.javaScriptSource &&
        (start.startsWith('//') || start.startsWith('*') || start.startsWith('/*'))
      ) {
        return '';
      }
      const at = commentBegins(line, opener);
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

/**
 * The head inside quotes, where the rule above cannot reach: prose and a
 * command line have the same shape there, so a leading word counts only where
 * it is a separate argv element of its own or where the run begins with a
 * package manager, however many words stand in between.
 *
 * Which words name a package manager is a property of the JavaScript ecosystem
 * rather than of this repository; what a manager calls its own subcommand stays
 * unenumerated, so `exec`, `dlx` and whatever the next one is called all reach
 * the program the same way. Where the binary lives is head wherever it appears,
 * and is taken off first.
 */
const LEADING_PATH = /[\w.@~${}/-]*\/$/;
const QUOTED_ARGV_ELEMENT = /["'`][\w@.-]+["'`][\s,]*["'`]?$/;
const BARE_WORD = /[\w@.-]+[\s,]*$/;
/**
 * A quote the program sits inside. All three of the language's quote characters
 * count — a template literal is the ordinary way a script here builds a binary
 * path — except where a tag expression precedes the backtick, which makes it an
 * opening rather than a quote and is read by {@link TAGGED_TEMPLATE_OPENS}.
 */
const OPENING_QUOTE = new RegExp(String.raw`(?:["']|(?<!${TAG_EXPRESSION_ENDS})\`)$`);
const PACKAGE_MANAGERS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'deno']);

/**
 * A subcommand follows the program, which is what separates it from a name
 * being assigned (`wrangler = execa(…)`). Only whitespace may stand between
 * them, and the subcommand is a lowercase word — anything else written there
 * ends the read, which is one of the limits at {@link findLocalStoreWriters}.
 */
const SUBCOMMAND_FOLLOWS = /^\s+[a-z][a-z0-9-]*/;

/**
 * The token is the whole argv element, nothing following it inside the quotes.
 * An argv element is held to this rather than to {@link SUBCOMMAND_FOLLOWS},
 * because a quoted string in code is as often a sentence as a command line and
 * the two are indistinguishable by shape.
 */
const ARGV_ELEMENT_ENDS = /^[\w.]*(?:\(\))?["'`)\]]*\s*,/;

/** What the command string carries between its opening and the program. */
interface RunnerPrefix {
  readonly words: readonly string[];
  /** Whether every word so far is a quoted argv element of its own. */
  readonly separateElements: boolean;
}

const NO_RUNNER: RunnerPrefix = { words: [], separateElements: true };

function runnerReachesTheProgram(prefix: RunnerPrefix, quoted: boolean): boolean {
  if (prefix.words.length === 0 || !quoted || prefix.separateElements) return true;
  return PACKAGE_MANAGERS.has(prefix.words[0] ?? '');
}

/**
 * Whether a command string opens where `head` ends and what follows the program
 * agrees with the shape that opened it. `quoted` says the head's own trailing
 * quote has been taken off, because a program argument is a quoted one while an
 * unquoted `(` is an ordinary call.
 */
function opensACommandString(
  head: string,
  quoted: boolean,
  after: string,
  shellQuoting: boolean
): boolean {
  if (
    (SPAWN_ARGV_HEAD.test(head) || (quoted && SPAWN_PROGRAM_ARGUMENT.test(head))) &&
    ARGV_ELEMENT_ENDS.test(after)
  )
    return true;
  const line =
    opensOn(head, SHELL_LINE_START, shellQuoting) ||
    opensOn(head, SCALAR_VALUE_START, shellQuoting);
  return line && SUBCOMMAND_FOLLOWS.test(after);
}

/**
 * The head with one more runner word taken off it, and that word recorded. A
 * runner argument can itself be a path — a workspace filter names one — so
 * where the binary lives is taken off at every step, not only at the program.
 */
function takeRunnerWord(
  full: string,
  prefix: RunnerPrefix
): { readonly head: string; readonly prefix: RunnerPrefix } | undefined {
  const head = full.replace(LEADING_PATH, '');
  const element = QUOTED_ARGV_ELEMENT.exec(head);
  const word = element ?? BARE_WORD.exec(head);
  if (word === null) return undefined;
  return {
    head: head.slice(0, word.index),
    prefix: {
      words: [word[0].replaceAll(/[^\w@.-]/g, ''), ...prefix.words],
      separateElements: prefix.separateElements && element !== null,
    },
  };
}

const QUOTE_CHARACTERS: readonly string[] = ['"', "'", '`'];

/**
 * Whether the quotes on a line close in front of a position. A shell
 * metacharacter inside a quoted string is not a metacharacter and a colon
 * inside one is not a mapping's, so an opening counts only where nothing on its
 * own line still holds it open — the `;` in the middle of an `echo \"…\"` opens
 * no command, and reading it as one is how a sentence about the program was
 * read as a command line.
 */
function quotesClose(before: string): boolean {
  return QUOTE_CHARACTERS.every((quote) => before.split(quote).length % 2 === 1);
}

/**
 * Whether `reading` opens a command string at the end of `head`, on the
 * program's own line — none of the line readings crosses a line break — and,
 * where the quotes on that line are the shell's, with them closed in front of
 * the opening.
 */
function opensOn(head: string, reading: RegExp, shellQuoting: boolean): boolean {
  const line = currentLine(head);
  const match = reading.exec(line);
  if (match === null) return false;
  return !shellQuoting || quotesClose(line.slice(0, match.index));
}

/**
 * Whether a command string opens behind `head` with nothing quoting the
 * program. Every reading is taken on the program's own line, which is the whole
 * of what they can reach: none of them crosses a line break.
 */
function opensUnquoted(head: string, syntax: FileSyntax): boolean {
  const readings = [
    UNQUOTED_SHELL_LINE,
    UNQUOTED_SCALAR_VALUE,
    syntax.quotedScalarIsACommandString ? QUOTED_SCALAR_VALUE : undefined,
    syntax.javaScriptSource ? TAGGED_TEMPLATE_OPENS : SUBSTITUTION_OPENS,
  ];
  return readings.some(
    (reading) => reading !== undefined && opensOn(head, reading, !syntax.javaScriptSource)
  );
}

/**
 * How the command string carrying the program opened, or nothing where none
 * did. A block sequence records the indentation that bounds it, because its
 * window is the rest of the sequence rather than a bracket group.
 */
interface ProgramOpening {
  readonly sequenceIndent: number | undefined;
}

const OPENED_BY_PUNCTUATION: ProgramOpening = { sequenceIndent: undefined };

function opensABlockSequenceElement(
  head: string,
  token: string,
  after: string,
  syntax: FileSyntax
): ProgramOpening | undefined {
  if (!syntax.blockSequenceIsArgv || carriesAVersionPin(token)) return undefined;
  const line = currentLine(head);
  if (!BLOCK_SEQUENCE_ITEM.test(line) || !BLOCK_SEQUENCE_ELEMENT_ENDS.test(after)) return undefined;
  return { sequenceIndent: indentOf(line) };
}

/**
 * Whether a command string opens somewhere behind a runner prefix. Separate
 * from the readings above because those take the line whole and this one takes
 * it apart, one runner word at a time, until an opening stands at the end of
 * what is left or nothing does.
 */
function opensBehindARunner(head: string, after: string, syntax: FileSyntax): boolean {
  let rest = head;
  let prefix = NO_RUNNER;
  let quoted = false;
  for (;;) {
    const closes = OPENING_QUOTE.test(rest);
    quoted ||= closes;
    if (
      runnerReachesTheProgram(prefix, quoted) &&
      opensACommandString(
        closes ? rest.slice(0, -1) : rest,
        closes,
        after,
        !syntax.javaScriptSource
      )
    ) {
      return true;
    }
    const shorter = takeRunnerWord(rest, prefix);
    if (shorter === undefined) return false;
    rest = shorter.head;
    prefix = shorter.prefix;
  }
}

/** Whether the program token between `before` and `after` is being run. */
function runsTheProgram(
  before: string,
  token: string,
  after: string,
  syntax: FileSyntax
): ProgramOpening | undefined {
  const stripped = before.replace(LEADING_PATH, '');
  const sequence = opensABlockSequenceElement(stripped, token, after, syntax);
  if (sequence !== undefined) return sequence;
  const punctuation =
    (opensUnquoted(stripped, syntax) && SUBCOMMAND_FOLLOWS.test(after)) ||
    opensBehindARunner(stripped, after, syntax);
  return punctuation ? OPENED_BY_PUNCTUATION : undefined;
}

/**
 * The argv-array reading of a line ending: a next line opening with a quote, a
 * bracket, a separator or the dot of a spread is the same element list carried
 * on. It is the only reading there is, so it is applied to every file kind
 * — a shell line, a manifest script, a workflow block — where a next line
 * opening with one of those characters is as often the next command, whose
 * flags then answer for this one. That is a limit at
 * {@link findLocalStoreWriters} rather than a rule to add here.
 */
const CONTINUES_INVOCATION = new Set(['[', '(', '{', "'", '"', '`', ',', ']', ')', '}', '.']);

const OPENS_A_GROUP = new Set(['(', '[', '{']);
const CLOSES_A_GROUP = new Set([')', ']', '}']);

/** Whether a line ending closes the invocation rather than continuing it. */
function endsAtLineBreak(text: string, index: number): boolean {
  if (text[index - 1] === '\\') return false;
  const rest = text.slice(index + 1);
  const next = rest.search(/\S/);
  return next === -1 || !CONTINUES_INVOCATION.has(rest.charAt(next));
}

/**
 * The text an invocation's flags can appear in: everything from the program
 * token to the close of the expression carrying it.
 *
 * Two shapes reach here — a shell command line and a multi-line argv array —
 * so the window ends at whichever comes first: the closer of a bracket group
 * opened before the token, or a line ending outside any group that nothing
 * continues ({@link endsAtLineBreak}). A window cut short reports `none` on an
 * invocation that was in fact declared, which is loud and gets looked at.
 * Neither bound is the end of a command, and that is the silent direction,
 * stated with the other limits at {@link findLocalStoreWriters}.
 */
function invocationWindow(text: string, from: number): string {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const character = text.charAt(index);
    if (OPENS_A_GROUP.has(character)) depth += 1;
    else if (CLOSES_A_GROUP.has(character)) {
      depth -= 1;
      if (depth < 0) return text.slice(from, index);
    } else if (character === '\n' && depth === 0 && endsAtLineBreak(text, index)) {
      return text.slice(from, index);
    }
  }
  return text.slice(from);
}

/**
 * A block sequence's window is the rest of the sequence: the element carrying
 * the program, and every following item indented at least as far.
 */
function blockSequenceWindow(text: string, from: number, indent: number): string {
  const [element = '', ...rest] = text.slice(from).split('\n');
  const taken = [element];
  for (const line of rest) {
    if (!BLOCK_SEQUENCE_CONTINUES.test(line) || indentOf(line) < indent) break;
    taken.push(line.slice(indentOf(line) + 2));
  }
  return taken.join('\n');
}

/**
 * The subcommand words that open the window, read through the quoting and
 * punctuation of both shapes. Used only to recognise the commands that have no
 * local mode, so a window whose words are unreadable is held to the rule.
 */
function commandOf(window: string): string {
  const words: string[] = [];
  for (const token of window
    .replaceAll(/[^A-Za-z0-9_-]+/g, ' ')
    .trim()
    .split(' ')) {
    if (words.length === 3 || !/^[a-z][a-z0-9]*$/.test(token)) break;
    words.push(token);
  }
  return words.join(' ');
}

function declarationOf(window: string, command: string): ModeDeclaration {
  if (/(?<![\w-])--remote(?![\w-])/.test(window)) return 'remote';
  if (/(?<![\w-])--persist-to(?![\w-])/.test(window)) return 'persist';
  if (window.includes(`${SHARED_ARGV_BUILDER}(`)) return 'shared-builder';
  if (COMMANDS_WITHOUT_LOCAL_MODE.some((one) => command === one || command.startsWith(`${one} `))) {
    return 'no-local-mode';
  }
  return 'none';
}

/**
 * An embedded runtime takes its persistence from an option rather than a flag,
 * and the option is set on a runtime the import starts, which can be anywhere
 * in the importing module — so the whole module is the window, and what a
 * window that wide answers for is a limit at {@link findLocalStoreWriters}.
 * Switching persistence on without naming a path is the default location under
 * another spelling, whichever module family it is.
 */
const PERSIST_OPTION = /(?<![\w-])(?:persist|defaultPersistRoot|\w*Persist)\s*:/;
const PERSIST_SWITCHED_ON = /(?<![\w-])(?:persist|defaultPersistRoot|\w*Persist)\s*:\s*true\b/;

function moduleDeclaration(text: string, whenSilent: SilenceMeaning): ModeDeclaration {
  if (PERSIST_SWITCHED_ON.test(text)) return 'none';
  if (PERSIST_OPTION.test(text)) return 'persist';
  return whenSilent === 'ephemeral' ? 'ephemeral' : 'none';
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function importsOf(specifier: string): RegExp {
  const escaped = specifier.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return new RegExp(String.raw`(?:from|require\(|import\()\s*["']${escaped}["']`, 'g');
}

/**
 * Every way one file can cause a wrangler-shaped local store to be written that
 * this scan can read — which is not every way one can.
 *
 * **The limits, stated here alone, each naming the reading that decides it and
 * each pinned by a case that goes red when that reading moves.** A limit whose
 * correct statement needed a paragraph, an enumeration, or a set nobody had
 * closed was deleted rather than restated — three attempts at writing one that
 * way each shipped a sentence later found false — so this list is short of the
 * whole rather than wrong about what it holds, and a spelling absent from it is
 * not thereby one this can see. What covers the difference is the store
 * described at the head of this module, not the list below:
 *
 * 1. **A file it never opens.** Which extensions are read is a list of names
 *    ({@link SCANNED_EXTENSIONS}) rather than anything a file does, so a
 *    tracked extension absent from it goes unread however the file runs a
 *    program.
 * 2. **A program it cannot name.** A program is the literal token
 *    ({@link PROGRAM_TOKEN}) standing where {@link runsTheProgram} finds a
 *    command string opening, so a binary reached under any other spelling is
 *    never asked about.
 * 3. **A module it cannot name.** A runtime module is matched by its exact
 *    specifier ({@link importsOf}), so the same package reached by a subpath is
 *    a different string and no door at all.
 * 4. **A subcommand it will not read across.** Where a command string opens as
 *    a shell line or a scalar value, only whitespace and a lowercase word may
 *    stand between the program and its subcommand
 *    ({@link SUBCOMMAND_FOLLOWS}); anything else written there ends the read.
 * 5. **A window wider than the command that opened it.** Every window ends
 *    where the shape that opened it ends ({@link invocationWindow},
 *    {@link blockSequenceWindow}, {@link moduleDeclaration}), and none of those
 *    is the end of a command, so whatever the bound leaves inside answers for
 *    this invocation. **This is the direction that fails silently**: the answer
 *    reads as declared where this invocation declared nothing.
 * 6. **A comment it does not cut.** {@link commentBegins} cuts at the first
 *    opener the line's own quotes close in front of, so a line reaching it with
 *    a quote left open keeps its comment, and the prose in that comment is read
 *    like any other text.
 * 7. **An answer it takes on trust.** A command in
 *    {@link COMMANDS_WITHOUT_LOCAL_MODE} is excused whether or not wrangler
 *    still gives it no local mode, and {@link SHARED_ARGV_BUILDER} is a
 *    declaration because that builder's own tests hold it to emitting one.
 */
export function findLocalStoreWriters(file: string, text: string): readonly LocalStoreWriter[] {
  const syntax = syntaxOf(file);
  const source = withoutComments(text, syntax);
  const writers: LocalStoreWriter[] = [];

  for (const [specifier, whenSilent] of RUNTIME_MODULES) {
    for (const match of source.matchAll(importsOf(specifier))) {
      writers.push({
        file,
        line: lineOf(source, match.index),
        command: `(module ${specifier})`,
        declares: moduleDeclaration(source, whenSilent),
      });
    }
  }

  for (const match of source.matchAll(PROGRAM_TOKEN)) {
    const at = match.index;
    const ends = at + match[0].length;
    const opening = runsTheProgram(source.slice(0, at), match[0], source.slice(ends), syntax);
    if (opening === undefined) continue;
    const window =
      opening.sequenceIndent === undefined
        ? invocationWindow(source, ends)
        : blockSequenceWindow(source, ends, opening.sequenceIndent);
    const command = commandOf(window);
    writers.push({
      file,
      line: lineOf(source, at),
      command,
      declares: declarationOf(window, command),
    });
  }

  return writers;
}
