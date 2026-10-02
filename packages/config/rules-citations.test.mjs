import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

// The loaded rule files — `docs/CODE-RULES.md` and the E2E rules — cite, per
// rule, the mechanism that enforces it. Those citations and the code have no
// other link, so a rename or a deletion leaves a file asserting a gate that no
// longer exists — and a loaded file is worse than silence when it is wrong,
// because an agent writes to the gate it names.
//
// WHAT THIS CANNOT PROVE: that any rule is HONOURED. It resolves the cited
// mechanism — the lint rule is configured at an enforcing severity, the symbol
// is exported, the spec file is there, the script runs in CI, the config key is
// set to something, the fixture is installed, the reporter is wired. Whether
// the mechanism actually catches the violation the rule describes is outside
// it, and so is whether any spec obeys the rule. Green here means every
// citation points at a live mechanism, and nothing more than that.
const repoRoot = path.resolve(import.meta.dirname, '../..');
const e2eDir = path.join(repoRoot, 'e2e');
const rulesPath = path.join(e2eDir, 'CLAUDE.md');
const rulesText = fs.readFileSync(rulesPath, 'utf8');
const rulesLines = rulesText.split('\n');

const readFile = (absolute) => fs.readFileSync(absolute, 'utf8');

const readIfFile = (absolute) =>
  fs.existsSync(absolute) && fs.statSync(absolute).isFile()
    ? fs.readFileSync(absolute, 'utf8')
    : '';

const escapeRegExp = (value) => value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** Matches `key:` as an object-literal property at any nesting depth. */
const propertyPattern = (key) =>
  new RegExp(String.raw`(?:^|[{,;])\s*['"]?${escapeRegExp(key)}['"]?\s*:`, 'm');

/** From the opening bracket to the one that closes it. */
function balancedRegion(text) {
  const open = text[0];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === open) depth += 1;
    else if (text[index] === close) {
      depth -= 1;
      if (depth === 0) return text.slice(0, index + 1);
    }
  }
  return text;
}

/**
 * The text a key is set to. An object or an array comes back whole rather than
 * cut at the first newline, so a key nested inside one can be looked up in what
 * this returns.
 */
function propertyInitializer(source, key) {
  const match = propertyPattern(key).exec(source);
  if (match === null) return;
  const colon = source.indexOf(':', match.index + match[0].length - 1);
  const rest = source.slice(colon + 1);
  const start = rest.search(/\S/);
  if (start === -1) return '';
  const value = rest.slice(start);
  if (value.startsWith('{') || value.startsWith('[')) return balancedRegion(value);
  const lineEnd = value.indexOf('\n');
  return (lineEnd === -1 ? value : value.slice(0, lineEnd))
    .trim()
    .replace(/[,}]+$/, '')
    .trim();
}

/** The value at a dotted key, walked one object literal at a time. */
function nestedInitializer(source, dottedKey) {
  let scope = source;
  for (const segment of dottedKey.split('.')) {
    if (scope === undefined) return;
    scope = propertyInitializer(scope, segment);
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Parsing the rules file
// ---------------------------------------------------------------------------

/**
 * Read from the trimmed line: GFM renders a row indented by a space or a tab
 * identically, so matching a leading pipe would drop the whole row — every
 * citation on it — out of the gate on a whitespace edit nothing renders and no
 * reviewer sees. Split on unescaped pipes for the same reason from the other
 * direction: `\|` is the only legal way to write a pipe inside a cell, so a
 * rule sentence quoting a shell pipe or a regex alternation would otherwise
 * shift every cell after it and read its Enforcement text out of the wrong one.
 */
function tableCells(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return;
  return trimmed
    .split(/(?<!\\)\|/)
    .slice(1, -1)
    .map((cell) => cell.trim());
}

// Alignment colons included: `:---`, `---:` and `:---:` are standard GFM a
// formatter can introduce. Unrecognised, a separator takes its own header down
// with it, and the table then reads against whatever Enforcement column carried
// over, or none at all. The census catches that but names rows, not the cause.
const isSeparatorRow = (cells) =>
  cells !== undefined && cells.every((cell) => /^:?-+:?$/.test(cell));

/**
 * The rule tables are the ones whose header carries an `Enforcement` column. A
 * header row is any row directly above a `| --- |` separator, so the ladder
 * table (Mechanism/Caught/Blocks) is recognised as its own table and skipped
 * rather than read as a continuation of the previous one.
 */
function enforcementCells() {
  const collected = [];
  let column = -1;
  let header = 0;
  for (const [index, line] of rulesLines.entries()) {
    const cells = tableCells(line);
    if (cells === undefined || isSeparatorRow(cells)) continue;
    if (isSeparatorRow(tableCells(rulesLines[index + 1] ?? ''))) {
      column = cells.indexOf('Enforcement');
      header = cells.length;
      continue;
    }
    if (column === -1) continue;
    collected.push({
      rule: cells[0],
      line: index + 1,
      text: cells[column] ?? '',
      cells: cells.length,
      headerCells: header,
    });
  }
  return collected;
}

/**
 * The census the gate is held to: the rows it reads are exactly the rows that
 * read as rule rows, each yielding its header's cell count. The Enforcement
 * column is loop state — a header carrying no Enforcement cell mutes every row
 * after it until the next header — so any shape that is a table row to a reader
 * and not to this parser drops whole rules and their citations silently. This
 * matches looser than the parser on purpose: a leading blockquote marker or a
 * fence still reads as a rule row here, and a row that splits into more cells
 * than its header has read its Enforcement text out of the wrong cell.
 */
const RULE_ROW = /^\s*>*\s*\|\s*\d+\.\d+\s*\|/;
const ruleRowLines = rulesLines.flatMap((line, index) => (RULE_ROW.test(line) ? [index + 1] : []));

const backtickedTokens = (text) => [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

const codeRulesPath = path.join(repoRoot, 'docs/CODE-RULES.md');

const ENFORCEMENT_HEADING = /^## Enforcement$/m;
const SECTION_HEADING = /^## /m;

const LEGEND_INTRODUCER_TEXT = 'The tags, each machine-checked against the mechanism it names:';

/**
 * Whitespace-relaxed, because the sentence this opens sits inside a hand-wrapped
 * markdown paragraph and any word of it can end a line.
 */
const LEGEND_INTRODUCER = new RegExp(
  escapeRegExp(LEGEND_INTRODUCER_TEXT).replaceAll(/\s+/g, String.raw`\s+`)
);

/**
 * From the introducer to the first full stop outside code font. A stop inside a
 * backticked token, or one glued to the next word, continues the sentence; the
 * clause after the real one is ordinary prose.
 */
const LEGEND_SENTENCE = /^(?:`[^`]*`|[^.`]|\.(?=\S))*/;

/**
 * The canonical tag legend in `docs/CODE-RULES.md` §Enforcement is the single
 * source for how a citation may be spelled: a legend token carrying a colon
 * declares a resolvable kind, one without declares a bare tag that names a tier
 * and no mechanism. Restating the set here would be a sync contract, and a sync
 * contract permits the drift it documents.
 *
 * Bounded twice, and both bounds are load-bearing. To the legend sentence, not
 * to its section: the prose on either side of it code-fonts `Enforcement:`, and
 * admitting a kind of that name would resolve any citation spelled
 * `Enforcement:<anything>` — the relabelling escape {@link taggedToken}
 * describes. Then to the leading token of each `·`-separated item: an item's
 * gloss may code-font a path or a command, which describes the mechanism rather
 * than naming a tag.
 */
function legendTags(text) {
  const heading = ENFORCEMENT_HEADING.exec(text);
  if (heading === null) {
    throw new Error(
      `no "## Enforcement" section in ${path.relative(repoRoot, codeRulesPath)}: its tag legend is what declares the citation kinds`
    );
  }
  const afterHeading = text.slice(heading.index + heading[0].length);
  const nextHeading = afterHeading.search(SECTION_HEADING);
  const section = nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);

  const introducer = LEGEND_INTRODUCER.exec(section);
  if (introducer === null) {
    throw new Error(
      `no tag legend in ${path.relative(repoRoot, codeRulesPath)} §Enforcement: no sentence introduced "${LEGEND_INTRODUCER_TEXT}"`
    );
  }
  const [sentence] = LEGEND_SENTENCE.exec(section.slice(introducer.index + introducer[0].length));

  const tags = sentence.split('·').flatMap((item) => backtickedTokens(item).slice(0, 1));
  return {
    kinds: tags.filter((tag) => tag.includes(':')).map((tag) => tag.slice(0, tag.indexOf(':'))),
    bare: tags.filter((tag) => !tag.includes(':')),
  };
}

const codeRulesText = fs.readFileSync(codeRulesPath, 'utf8');

const { kinds: CITATION_KINDS, bare: BARE_TAGS } = legendTags(codeRulesText);

/**
 * Every backticked token in an Enforcement cell is a legend tag: either a bare
 * tag exactly, or `kind:target` whose kind the legend declares. A mechanism
 * mentioned as prose is left un-backticked, which is what lets this hold with
 * no list of permitted exceptions — and without it, any citation that goes red
 * can be silenced by relabelling it to a kind nothing resolves.
 */
function taggedToken(rule, line, token) {
  const colon = token.indexOf(':');
  return colon === -1
    ? { rule, line, token, target: '' }
    : { rule, line, token, kind: token.slice(0, colon), target: token.slice(colon + 1) };
}

const taggedTokensIn = (blocks) =>
  blocks.flatMap(({ rule, line, text }) =>
    backtickedTokens(text).map((token) => taggedToken(rule, line, token))
  );

// ---------------------------------------------------------------------------
// Parsing the rules document
// ---------------------------------------------------------------------------

/**
 * A clause opens at an `Enforcement:` that is not itself in code font. The
 * legend's own prose names the token twice, backticked, and admitting either
 * would make a clause of the paragraph that defines what a clause is.
 */
const CLAUSE_OPENER = /(?<!`)\bEnforcement:/;

/**
 * A clause is the tail of one bullet or one paragraph, so it ends where that
 * block does. Bounding it matters in the direction a reader cannot see: a
 * clause that ran on would take the next rule's backticked prose for tags,
 * and every one of those would resolve against nothing.
 */
const CLAUSE_END = /^(?:\s*$|#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|-{3,}\s*$)/;

const DOCUMENT_HEADING = /^#{2,6} (.+)$/;

function enforcementClauses(text) {
  const lines = text.split('\n');
  const clauses = [];
  let heading = '';
  for (const [index, line] of lines.entries()) {
    const headingMatch = DOCUMENT_HEADING.exec(line);
    if (headingMatch !== null) {
      heading = headingMatch[1];
      continue;
    }
    const opener = CLAUSE_OPENER.exec(line);
    if (opener === null) continue;
    const body = [line.slice(opener.index + opener[0].length)];
    for (let next = index + 1; next < lines.length; next += 1) {
      if (CLAUSE_END.test(lines[next])) break;
      body.push(lines[next]);
    }
    clauses.push({ rule: `\u00A7${heading}`, line: index + 1, text: body.join('\n') });
  }
  return clauses;
}

const codeRulesClauses = enforcementClauses(codeRulesText);

const isCitation = ({ kind }) => kind !== undefined && CITATION_KINDS.includes(kind);

const tokens = taggedTokensIn(enforcementCells());
const codeRulesTokens = taggedTokensIn(codeRulesClauses);
const e2eCitations = tokens.filter((token) => isCitation(token));
const citations = [...e2eCitations, ...codeRulesTokens.filter((token) => isCitation(token))];

function splitTarget(target) {
  const open = target.indexOf('(');
  if (open === -1 || !target.endsWith(')')) return { name: target };
  return { name: target.slice(0, open), parenthetical: target.slice(open + 1, -1) };
}

/**
 * A citation's parenthetical names the option the rule is cited for
 * (`no-restricted-syntax(describe.serial)`) or the flag the script is cited for
 * (`e2e:prepare(--require-e2e-models)`). Its tokens are checked against the
 * mechanism's own text — but only the ones shaped like code. A word with no
 * code marker is prose describing the option ("numeric", "bare"), and a glob
 * names a file scope rather than option content; neither can be looked up in
 * the mechanism, so neither is asserted.
 *
 * A CLI flag is required whole. Everything else is required sub-word by
 * sub-word, because a name reaches its mechanism reshaped — `Math.random`
 * arrives as an AST selector, `@hushbox/db` as a path group — while a flag
 * arrives verbatim or not at all, and sub-words alone would let a neighbouring
 * script's words satisfy a flag no script passes.
 */
const checkableTokens = (parenthetical) =>
  parenthetical
    .split(/[\s,]+/)
    .map((token) => token.replaceAll(/^[('"]+|[)'":]+$/g, ''))
    .filter((token) => token.length > 0 && !token.includes('*') && /[A-Z._/@-]/.test(token))
    .map((token) => ({
      token,
      subWords: token.startsWith('-')
        ? [token]
        : token.split(/[^A-Za-z\d]+/).filter((word) => word.length >= 2),
    }));

function unmatchedTokens(parenthetical, evidence) {
  const haystack = evidence.toLowerCase();
  return checkableTokens(parenthetical)
    .filter(({ subWords }) => !subWords.every((word) => haystack.includes(word.toLowerCase())))
    .map(({ token }) => token);
}

// ---------------------------------------------------------------------------
// Repository sources the resolvers read
// ---------------------------------------------------------------------------

const SKIPPED_DIRS = new Set([
  '.git',
  '.turbo',
  '.wrangler',
  'android',
  'coverage',
  'dist',
  'ios',
  'node_modules',
  'playwright-report',
]);

function collectSourceFiles(dir, into) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Rule-test fixture trees are created and torn down while other suites
      // run; sweeping into one races its teardown (the read lands ENOENT),
      // and its contents are generated scaffolding, never citation sources —
      // the duplication gate exempts the same pattern for the same reason.
      if (
        SKIPPED_DIRS.has(entry.name) ||
        /^__test-fixtures-.*__$/.test(entry.name) ||
        absolute === path.join(e2eDir, 'report')
      )
        continue;
      collectSourceFiles(absolute, into);
    } else if (/\.[mc]?tsx?$/.test(entry.name)) {
      into.push(absolute);
    }
  }
  return into;
}

let sourceFilesCache;
const sourceFiles = () => (sourceFilesCache ??= collectSourceFiles(repoRoot, []));

const playwrightConfig = readIfFile(path.join(repoRoot, 'playwright.config.ts'));
const vitestConfig = readIfFile(path.join(repoRoot, 'packages/config/vitest.config.ts'));
const rootScripts = JSON.parse(readIfFile(path.join(repoRoot, 'package.json'))).scripts;
const workflowText = fs
  .readdirSync(path.join(repoRoot, '.github/workflows'))
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .map((name) => readIfFile(path.join(repoRoot, '.github/workflows', name)))
  .join('\n');

// ---------------------------------------------------------------------------
// Resolvers, one per citation kind. Each returns the reasons a citation does
// not resolve; an empty list is a citation that does.
// ---------------------------------------------------------------------------

/**
 * One probe per rule set a citation can name: the base every tree inherits,
 * the trees whose rules are scoped to them, and the spellings that carry
 * different rules inside one tree. A probe names no real module — ESLint
 * answers `--print-config` for a path rather than for a file, so a probe on a
 * real module would tie the answer to that module outliving the citation.
 */
const LINT_PROBES = [
  ['e2e', 'billing/probe.spec.ts'],
  ['e2e', 'admin/probe.spec.ts'],
  ['e2e', 'pages/probe.page.ts'],
  ['e2e', 'helpers/probe.ts'],
  ['e2e', 'fixtures.ts'],
  ['apps/api', 'src/slices/chat/probe.ts'],
  ['apps/api', 'src/slices/chat/probe.test.ts'],
  ['apps/web', 'src/probe.tsx'],
  ['packages/shared', 'src/probe.ts'],
];

/**
 * Each config is resolved in a child process on purpose. Resolving it in this
 * one would load the vendored rule modules natively, while every other suite
 * in this package reaches them through vite-node — and a module measured under
 * two loader identities silently corrupts the package's coverage merge.
 */
let lintConfigsCache;
function lintConfigs() {
  lintConfigsCache ??= Promise.all(
    LINT_PROBES.map(async ([workspace, file]) => {
      const { stdout } = await execFileAsync(
        path.join(repoRoot, 'node_modules/.bin/eslint'),
        ['--print-config', file],
        { cwd: path.join(repoRoot, workspace), maxBuffer: 64 * 1024 * 1024 }
      );
      return { probe: `${workspace}/${file}`, rules: JSON.parse(stdout).rules ?? {} };
    })
  );
  return lintConfigsCache;
}

const SEVERITY_WORDS = { off: 0, warn: 1, error: 2 };

function severityOf(entry) {
  const value = Array.isArray(entry) ? entry[0] : entry;
  return typeof value === 'string' ? SEVERITY_WORDS[value] : value;
}

async function resolveLint({ name, parenthetical }, injected) {
  const configs = injected ?? (await lintConfigs());
  const configured = configs.filter(({ rules }) => rules[name] !== undefined);
  if (configured.length === 0) return [`no rule "${name}" in any resolved config`];

  const enforcing = configured.filter(({ rules }) => severityOf(rules[name]) === 2);
  if (enforcing.length === 0) {
    const severities = configured.map(({ probe, rules }) => `${probe}=${severityOf(rules[name])}`);
    return [`"${name}" resolves to a non-enforcing severity everywhere (${severities.join(', ')})`];
  }
  if (parenthetical === undefined) return [];

  // One rule id carries a different option set in each tree that configures it,
  // so the claim a parenthetical makes is satisfied by the tree the rule is
  // cited for — asking only the first enforcing config reads the option out of
  // whichever tree the probe order happened to reach first.
  const missing = enforcing.map(({ rules }) => {
    const entry = rules[name];
    return unmatchedTokens(
      parenthetical,
      JSON.stringify(Array.isArray(entry) ? entry.slice(1) : [])
    );
  });
  return missing.some((absent) => absent.length === 0)
    ? []
    : [
        `"${name}" is enforced but its options name none of: ${[...new Set(missing.flat())].join(', ')}`,
      ];
}

const EXPORT_KEYWORDS = 'const|let|var|function|class|type|interface|enum';

function resolveType({ name }, files = sourceFiles(), read = readFile) {
  const declaration = new RegExp(
    String.raw`export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:${EXPORT_KEYWORDS})\s+${escapeRegExp(name)}\b`
  );
  const reExport = new RegExp(
    String.raw`export\s*(?:type\s*)?\{[^}]*\b${escapeRegExp(name)}\b`,
    's'
  );
  const found = files.some((file) => {
    const source = read(file);
    return declaration.test(source) || reExport.test(source);
  });
  return found ? [] : [`no exported declaration of "${name}" in the repository's TypeScript`];
}

const TEST_FILE = /\.(?:test|spec)\.[mc]?[jt]sx?$/;

const holdsATest = (directory) => fs.readdirSync(directory).some((entry) => TEST_FILE.test(entry));

/**
 * A repo-relative path to a test file, or to a directory holding one. The
 * E2E tables name a spec by its path under `e2e/` without the suffix, so that
 * spelling answers second — the citation is still a claim about a file, and
 * the suffix is the whole of what it leaves out.
 */
function resolveTestPath(absolute, label) {
  if (!fs.existsSync(absolute)) return;
  if (fs.statSync(absolute).isDirectory()) {
    return holdsATest(absolute) ? [] : [`${label} holds no test file`];
  }
  return TEST_FILE.test(absolute) ? [] : [`${label} is not a test file`];
}

function resolveTest({ name }) {
  const direct = resolveTestPath(path.join(repoRoot, name), name);
  if (direct !== undefined) return direct;
  if (fs.existsSync(path.join(e2eDir, `${name}.spec.ts`))) return [];
  return (
    resolveTestPath(path.join(e2eDir, name), `e2e/${name}`) ?? [
      `no test file at ${name}, and no spec at e2e/${name}.spec.ts`,
    ]
  );
}

const fixtureModules = () =>
  sourceFiles().filter(
    (file) => path.basename(file) === 'fixtures.ts' && file.startsWith(`${e2eDir}${path.sep}`)
  );

function resolveFixture({ name }, modules = fixtureModules(), read = readFile) {
  const declaration = new RegExp(
    String.raw`(?:function|const|let)\s+${escapeRegExp(name)}\b|(?:^|[{,;])\s*${escapeRegExp(name)}\s*:`,
    'm'
  );
  const uses = new RegExp(String.raw`\b${escapeRegExp(name)}\b`, 'g');
  for (const file of modules) {
    const source = read(file);
    if (!declaration.test(source)) continue;
    // Declared but never referenced is a fixture that is defined, not installed.
    return (source.match(uses) ?? []).length >= 2
      ? []
      : [`"${name}" is declared in ${path.relative(repoRoot, file)} but never used there`];
  }
  return [`no fixture "${name}" declared in any e2e fixtures module`];
}

/**
 * The scripts a command reaches: the ones it names as `pnpm <script>`, plus the
 * ones it reaches through the two wrappers that take a task rather than a
 * command line. A root-level turbo task is written `//#<script>` and runs the
 * root script of that name, so following the wrapper is what keeps a script
 * reached only that way from reading as unwired.
 */
const invokedScripts = (text) => [
  ...[...text.matchAll(/pnpm (?:run )?(?:--filter \S+ )?([\w.:-]+)/g)].map((match) => match[1]),
  ...[...text.matchAll(/turbo-(?:run|pool)\.ts run ([\w.:/#-]+)/g)].map((match) =>
    match[1].replace(/^\/\/#/, '')
  ),
];

/**
 * A script is CI-wired if a workflow runs it, or runs a script that runs it.
 * The transitive step is load-bearing: CI runs `pnpm e2e`, and the preparation
 * step two rules cite rides that script's own command.
 */
function ciWiredScripts(scripts, workflows) {
  const wired = new Set();
  const frontier = invokedScripts(workflows);
  while (frontier.length > 0) {
    const name = frontier.pop();
    if (wired.has(name) || scripts[name] === undefined) continue;
    wired.add(name);
    frontier.push(...invokedScripts(scripts[name]));
  }
  return wired;
}

function commandClosure(name, scripts, seen = new Set()) {
  if (seen.has(name) || scripts[name] === undefined) return '';
  seen.add(name);
  const command = scripts[name];
  const nested = invokedScripts(command).map((nestedName) =>
    commandClosure(nestedName, scripts, seen)
  );
  return [command, ...nested].join(' ');
}

function resolveCi({ name, parenthetical }, scripts = rootScripts, workflows = workflowText) {
  if (scripts[name] === undefined) return [`no root package.json script "${name}"`];
  if (!ciWiredScripts(scripts, workflows).has(name)) {
    return [`script "${name}" is reached by no workflow step`];
  }
  if (parenthetical === undefined) return [];
  const missing = unmatchedTokens(parenthetical, commandClosure(name, scripts));
  return missing.length === 0 ? [] : [`script "${name}" runs without: ${missing.join(', ')}`];
}

const FALSY_INITIALIZER = /^(?:false|undefined|null|0|''|""|\[]|\{})$/;

/**
 * A key set to a value that configures nothing. An object counts as empty by
 * holding no property of its own: a citation of a settings group that has been
 * emptied names a key the tool still reads and nothing acts on.
 */
const enforcesNothing = (initializer) =>
  FALSY_INITIALIZER.test(initializer) ||
  (initializer.startsWith('{') && !initializer.includes(':'));

/**
 * The object literal `defineConfig` is called with: the configuration the run
 * itself takes, as against the per-project settings objects the same file
 * builds its projects from.
 */
function runLevelObject(source) {
  const call = source.indexOf('defineConfig(');
  if (call === -1) return '';
  const open = source.indexOf('{', call);
  if (open === -1) return '';
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return '';
}

const propertyOccurrences = (source, key) =>
  source.match(new RegExp(propertyPattern(key).source, 'gm'))?.length ?? 0;

/**
 * The initializer a `config:` citation is a claim about, or the reason no
 * occurrence of the key can stand for one.
 *
 * A citation is a claim about the run, so the run's own configuration answers
 * first: the file sets some of these names on a per-project settings object
 * too, and a scan of the whole text answers with whichever occurrence it
 * reaches first — a per-project cap standing in for the run-level count the
 * rule is about. A key the run configuration leaves to its projects answers
 * from the rest of the file only while the file sets it once, so an ambiguous
 * name is reported rather than guessed at.
 */
function runConfigKey(source, key) {
  const runLevel = propertyInitializer(runLevelObject(source), key);
  if (runLevel !== undefined) return { initializer: runLevel };
  if (propertyOccurrences(source, key) > 1) {
    return {
      problems: [
        `playwright.config.ts sets "${key}" away from the run configuration in more than one place, so no occurrence of it certifies the rule`,
      ],
    };
  }
  return { initializer: propertyInitializer(source, key) };
}

/** What the citation claims of the value it found, or nothing left to say. */
function initializerProblems(where, key, initializer, expected) {
  if (enforcesNothing(initializer)) {
    return [`${where} sets "${key}" to ${initializer}, which enforces nothing`];
  }
  if (expected !== undefined && !initializer.includes(expected)) {
    return [`${where} sets "${key}" to ${initializer}, not ${expected}`];
  }
  return [];
}

function resolveConfig({ name }, source = playwrightConfig, vitestSource = vitestConfig) {
  const [key, expected] = name.split('=');
  const { problems, initializer } = runConfigKey(source, key);
  if (problems !== undefined) return problems;
  if (initializer !== undefined) {
    return initializerProblems('playwright.config.ts', key, initializer, expected);
  }

  // The second configuration surface a rule can cite is the shared vitest
  // config, where a settings group is reached by its dotted path.
  const declared = nestedInitializer(vitestSource, key);
  if (declared !== undefined) {
    return initializerProblems('the shared vitest config', key, declared, expected);
  }

  // The other config surface a rule can cite is the env registry, where the
  // resolution bar is that something reads the variable — a registry entry
  // nothing consumes configures nothing.
  const envRegistry = path.join(repoRoot, 'packages/shared/src/env/env.config.ts');
  if (!propertyPattern(key).test(readIfFile(envRegistry))) {
    return [`"${key}" is set in no config file and in no env registry entry`];
  }
  // Excluded by the `.test.`/`.spec.` infix, not a `.test.ts` suffix: the file
  // collector also returns `.test.tsx`, `.test.mts` and e2e's own `.spec.ts`,
  // and a key mentioned only by a test is read by nothing that configures.
  const reader = sourceFiles().find(
    (file) =>
      file !== envRegistry &&
      !/\.(?:test|spec)\./.test(path.basename(file)) &&
      new RegExp(String.raw`\b${escapeRegExp(key)}\b`).test(fs.readFileSync(file, 'utf8'))
  );
  return reader === undefined ? [`env variable "${key}" is declared but read nowhere`] : [];
}

function reporterEntries() {
  const start = playwrightConfig.indexOf('reporter:');
  if (start === -1) return [];
  const rest = playwrightConfig.slice(start + 'reporter:'.length);
  const end = rest.search(/\n {2}[A-Za-z_$][\w$]*:/);
  const region = end === -1 ? rest : rest.slice(0, end);
  return [...region.matchAll(/'(\.\/[^']+)'/g)].map((match) => match[1]);
}

function resolveReport({ name }) {
  const module = path.join(repoRoot, 'scripts', `${name}.ts`);
  if (!fs.existsSync(module)) return [`no reporting module at scripts/${name}.ts`];
  const wiredIn = reporterEntries().find((entry) =>
    new RegExp(String.raw`\b${escapeRegExp(name)}\b`).test(
      readIfFile(path.resolve(repoRoot, entry))
    )
  );
  return wiredIn === undefined
    ? [`scripts/${name}.ts is imported by no reporter in playwright.config.ts`]
    : [];
}

const ARCH_RULES_DIR = 'packages/config/arch/rules';

/**
 * Every name a rule module declares, each read through the module constant
 * where the property names one. The runner reports a violation under this
 * value, so a module whose filename and declared name have parted company is
 * cited by a tag naming something no run can report.
 */
function declaredRuleNames(source) {
  return [...source.matchAll(/\bname:\s*(?:'([^']*)'|([A-Z][A-Z\d_]*))/g)].flatMap(
    ([, literal, identifier]) => {
      if (literal !== undefined) return [literal];
      const binding = new RegExp(
        String.raw`\b(?:const|let|var)\s+${identifier}\s*=\s*'([^']*)'`
      ).exec(source);
      return binding === null ? [] : [binding[1]];
    }
  );
}

function resolveArch({ name }, source) {
  const file = `${ARCH_RULES_DIR}/${name}.rule.ts`;
  const module = source ?? readIfFile(path.join(repoRoot, file));
  if (module === '') return [`no rule module at ${file}`];
  const declared = declaredRuleNames(module);
  return declared.includes(name)
    ? []
    : [`${file} declares no rule named "${name}" (it declares: ${declared.join(', ') || 'none'})`];
}

const RESOLVERS = {
  lint: resolveLint,
  arch: resolveArch,
  type: resolveType,
  test: resolveTest,
  fixture: resolveFixture,
  ci: resolveCi,
  config: resolveConfig,
  report: resolveReport,
};

// ---------------------------------------------------------------------------

/**
 * A legend sentence surrounded by prose that backticks tokens of its own: the
 * clause before it and the clause after it both code-font `Enforcement:`, one
 * item's gloss code-fonts a path, and the next section code-fonts tags of its
 * own. None of those is a tag.
 */
const legendFixture = (introducer) => `## Enforcement

A rule that is not enforced is a suggestion. Every rule names the mechanism that
holds it, as an \`Enforcement:\` clause of tags; a rule whose only mechanism is
review says \`doc\`. ${introducer} \`lint:<rule>\` (an ESLint rule id) ·
\`arch:<rule>\` (an architecture rule under \`packages/config/arch/rules/\`) ·
\`doc\`. A mechanism named in prose stays in plain text; a backticked token in an
\`Enforcement:\` clause is a tag.

- Custom rules live in \`packages/config\`

## Documentation

A later section naming \`report:<name>\` · \`doc\`.
`;

describe('the tag legend', () => {
  it('harvests only the tags the legend sentence declares', () => {
    expect(legendTags(legendFixture(LEGEND_INTRODUCER_TEXT))).toEqual({
      kinds: ['lint', 'arch'],
      bare: ['doc'],
    });
  });

  it('reads a legend whose introducing clause wraps across lines', () => {
    const wrapped = LEGEND_INTRODUCER_TEXT.replace(' ', '\n');
    expect(legendTags(legendFixture(wrapped))).toEqual({
      kinds: ['lint', 'arch'],
      bare: ['doc'],
    });
  });

  it('refuses a document whose Enforcement section is gone', () => {
    const renamed = legendFixture(LEGEND_INTRODUCER_TEXT).replace('## Enforcement', '## Testing');
    expect(() => legendTags(renamed)).toThrow('no "## Enforcement" section in');
  });

  it('refuses an Enforcement section whose legend sentence is gone', () => {
    expect(() => legendTags(legendFixture(''))).toThrow('§Enforcement: no sentence introduced');
  });
});

describe('the E2E rules file', () => {
  it('carries enforcement citations to resolve', () => {
    expect(e2eCitations.length).toBeGreaterThan(0);
  });

  it('reads an Enforcement cell out of every row that reads as a rule', () => {
    const read = enforcementCells().map(({ line }) => line);
    expect(read, 'rows the gate reads vs rows that read as rule rows').toEqual(ruleRowLines);
  });

  it('splits every rule row into the cell count its own header declares', () => {
    const miscounted = enforcementCells()
      .filter(({ cells, headerCells }) => cells !== headerCells)
      .map(
        ({ rule, line, cells, headerCells }) =>
          `rule ${rule} (line ${line}): ${cells}/${headerCells}`
      );
    expect(miscounted, 'a row split into more cells than its header reads the wrong cell').toEqual(
      []
    );
  });

  it('backticks nothing in an Enforcement cell but a legend tag', () => {
    const offenders = tokens
      .filter(({ token, kind }) =>
        kind === undefined ? !BARE_TAGS.includes(token) : !CITATION_KINDS.includes(kind)
      )
      .map(({ rule, line, token }) => `rule ${rule} (line ${line}): ${token}`);
    expect(
      offenders,
      `not a legend tag (kinds: ${CITATION_KINDS.join(', ')}; bare: ${BARE_TAGS.join(', ')})`
    ).toEqual([]);
  });

  it('cites every kind this file carries a resolver for', () => {
    // The legend is the whole repository's, so it may declare a kind these
    // tables never cite; that is not drift. What must not go unexercised is a
    // resolver written here — a kind whose last citation disappears would
    // otherwise leave its resolver checking nothing and still report green.
    const unexercised = Object.keys(RESOLVERS).filter(
      (kind) => !citations.some((citation) => citation.kind === kind)
    );
    expect(unexercised, 'resolvers no citation exercises').toEqual([]);
  });

  it('names in its ladder exactly the rungs whose own row blocks nothing', () => {
    // The sentence above the ladder generalises the table below it. Both are
    // prose in one file, so nothing but this keeps them agreeing when a rung's
    // mechanism changes what it blocks.
    const blocksNothing = rulesLines
      .map((line) => tableCells(line))
      .filter((cells) => cells !== undefined && /^nothing\b/.test(cells.at(-1) ?? ''))
      .map((cells) => cells[0]);
    const sentence = rulesLines.find((line) => line.includes('merge-gating enforcement'));
    expect(sentence).toBeDefined();
    const named = [...sentence.matchAll(/\bRungs?\b[^.]*?(\d+)|(?:\band\b|,)\s*(\d+)/g)].map(
      (match) => match[1] ?? match[2]
    );
    expect([...new Set(named)].toSorted()).toEqual(blocksNothing.toSorted());
  });
});

/**
 * The run-level worker count: the property on the object `defineConfig`
 * receives, which the browser runner's config indents one level. Its
 * per-project siblings sit deeper, inside the per-project settings objects.
 */
const RUN_LEVEL_WORKERS = /^ {2}workers:.*$/gm;

describe('config citations resolve the run configuration', () => {
  it('reads a run-level worker count this file can mutate on its own', () => {
    expect(playwrightConfig.match(RUN_LEVEL_WORKERS)).toHaveLength(1);
  });

  it('resolves the configuration as it stands', () => {
    expect(resolveConfig({ name: 'workers' })).toEqual([]);
  });

  it('reports a key the run configuration no longer carries', () => {
    const source = playwrightConfig.replaceAll(RUN_LEVEL_WORKERS, '');
    expect(resolveConfig({ name: 'workers' }, source)).not.toEqual([]);
  });

  it('reports a run-level value that enforces nothing, past a per-project one that would', () => {
    const source = playwrightConfig.replaceAll(RUN_LEVEL_WORKERS, '  workers: 0,');
    expect(resolveConfig({ name: 'workers' }, source)).toEqual([
      expect.stringContaining('enforces nothing'),
    ]);
  });

  it('still resolves a key the run configuration leaves to its projects', () => {
    expect(resolveConfig({ name: 'grepInvert' })).toEqual([]);
  });
});

/**
 * A clause standing alone, a clause trailing a bullet whose prose code-fonts a
 * path of its own, and a bullet mentioning the clause form in code font. Only
 * the first two are clauses.
 */
const clauseFixture = `## Error Handling

- Every caught error is handled or rethrown

Enforcement: \`lint:catch-swallow/no-silent-catch\` ·
\`arch:cron-hosts-no-delivery\` · \`doc\`

## Changing the Architecture

- Before adopting an excluded service, consult \`docs/DECISIONS.md\` — the
  re-entry conditions are the decision. Enforcement: \`doc\`
- A backticked token in an \`Enforcement:\` clause is a tag
`;

const clauseTags = (text) =>
  enforcementClauses(text).map(({ rule, text: body }) => ({ rule, tags: backtickedTokens(body) }));

describe('enforcement clauses', () => {
  it('reads a clause that wraps to the end of its own paragraph', () => {
    expect(clauseTags(clauseFixture).at(0)?.tags).toEqual([
      'lint:catch-swallow/no-silent-catch',
      'arch:cron-hosts-no-delivery',
      'doc',
    ]);
  });

  it('names each clause by the heading it sits under', () => {
    expect(clauseTags(clauseFixture).map(({ rule }) => rule)).toEqual([
      '§Error Handling',
      '§Changing the Architecture',
    ]);
  });

  it('takes no tag from its bullet before the clause opened, nor from the one after', () => {
    expect(clauseTags(clauseFixture).at(1)?.tags).toEqual(['doc']);
  });

  it('opens on no code-fonted mention of a clause', () => {
    expect(enforcementClauses('A token in an `Enforcement:` clause is a tag.')).toEqual([]);
  });
});

describe('the rules document', () => {
  it('carries enforcement citations to resolve', () => {
    expect(codeRulesTokens.filter((token) => isCitation(token)).length).toBeGreaterThan(0);
  });

  it('leaves no clause naming nothing in code font', () => {
    const untagged = codeRulesClauses
      .filter(({ text }) => backtickedTokens(text).length === 0)
      .map(({ rule, line }) => `${rule} (line ${line})`);
    expect(untagged, 'an Enforcement clause whose mechanisms are all prose').toEqual([]);
  });

  it('backticks nothing in an Enforcement clause but a legend tag', () => {
    const offenders = codeRulesTokens
      .filter(({ token, kind }) =>
        kind === undefined ? !BARE_TAGS.includes(token) : !CITATION_KINDS.includes(kind)
      )
      .map(({ rule, line, token }) => `${rule} (line ${line}): ${token}`);
    expect(
      offenders,
      `not a legend tag (kinds: ${CITATION_KINDS.join(', ')}; bare: ${BARE_TAGS.join(', ')})`
    ).toEqual([]);
  });
});

describe('the lint resolver', () => {
  const configured = (entry) => [{ probe: 'a/probe.ts', rules: { 'a-plugin/a-rule': entry } }];

  it('resolves a rule configured at error severity', async () => {
    expect(await resolveLint({ name: 'a-plugin/a-rule' }, configured('error'))).toEqual([]);
  });

  it('refuses a rule no resolved config carries', async () => {
    expect(await resolveLint({ name: 'a-plugin/another' }, configured('error'))).toEqual([
      expect.stringContaining('in any resolved config'),
    ]);
  });

  it('refuses a rule configured below error severity', async () => {
    expect(await resolveLint({ name: 'a-plugin/a-rule' }, configured('warn'))).toEqual([
      expect.stringContaining('non-enforcing severity'),
    ]);
  });

  it('resolves a parenthetical the enforcing options name', async () => {
    const entry = [
      'error',
      { selector: "CallExpression[callee.object.name='vi'][callee.property.name='mock']" },
    ];
    expect(
      await resolveLint({ name: 'a-plugin/a-rule', parenthetical: 'vi.mock' }, configured(entry))
    ).toEqual([]);
  });

  it('refuses a parenthetical the enforcing options name nowhere', async () => {
    const entry = ['error', { selector: 'Identifier' }];
    expect(
      await resolveLint({ name: 'a-plugin/a-rule', parenthetical: 'vi.mock' }, configured(entry))
    ).toEqual([expect.stringContaining('name none of')]);
  });
});

describe('the arch resolver', () => {
  it('resolves a module declaring the cited name', () => {
    expect(resolveArch({ name: 'a-rule' }, "const rule = { name: 'a-rule' };")).toEqual([]);
  });

  it('resolves a name the module declares through a constant', () => {
    const module = "const RULE = 'a-rule';\nconst rule = { name: RULE, check() {} };";
    expect(resolveArch({ name: 'a-rule' }, module)).toEqual([]);
  });

  it('refuses a module whose declared name is another rule', () => {
    expect(resolveArch({ name: 'a-rule' }, "const rule = { name: 'another-rule' };")).toEqual([
      expect.stringContaining('declares no rule named'),
    ]);
  });

  it('refuses a citation no rule module answers', () => {
    expect(resolveArch({ name: 'no-such-architecture-rule' })).toEqual([
      expect.stringContaining('no rule module at'),
    ]);
  });
});

describe('the test resolver', () => {
  it('resolves a repo-relative test file', () => {
    expect(resolveTest({ name: 'packages/config/rules-citations.test.mjs' })).toEqual([]);
  });

  it('resolves a spec the E2E tables name without its suffix', () => {
    expect(resolveTest({ name: 'contracts/signals' })).toEqual([]);
  });

  it('refuses a path that resolves to something other than a test', () => {
    expect(resolveTest({ name: 'docs/CODE-RULES.md' })).toEqual([
      expect.stringContaining('is not a test file'),
    ]);
  });

  it('refuses a path naming nothing', () => {
    expect(resolveTest({ name: 'packages/config/no-such-suite.test.ts' })).toEqual([
      expect.stringContaining('no test file at'),
    ]);
  });
});

describe('the fixture resolver', () => {
  const modules = ['e2e/fixtures.ts'];

  it('resolves a fixture declared and installed', () => {
    const source =
      'const aFixture = async () => {};\nexport const test = base.extend({ aFixture });';
    expect(resolveFixture({ name: 'aFixture' }, modules, () => source)).toEqual([]);
  });

  it('refuses a fixture declared and never installed', () => {
    expect(
      resolveFixture({ name: 'aFixture' }, modules, () => 'const aFixture = async () => {};')
    ).toEqual([expect.stringContaining('never used')]);
  });

  it('refuses a fixture no module declares', () => {
    expect(resolveFixture({ name: 'aFixture' }, modules, () => 'const other = 1;')).toEqual([
      expect.stringContaining('no fixture'),
    ]);
  });
});

describe('the type resolver', () => {
  it('resolves an exported declaration', () => {
    expect(resolveType({ name: 'ATag' }, ['a.ts'], () => 'export type ATag = string;')).toEqual([]);
  });

  it('refuses a declaration nothing exports', () => {
    expect(resolveType({ name: 'ATag' }, ['a.ts'], () => 'type ATag = string;')).toEqual([
      expect.stringContaining('no exported declaration'),
    ]);
  });
});

describe('the ci resolver', () => {
  const scripts = {
    gate: 'tsx scripts/gate.ts --strict',
    wrapper: 'pnpm gate',
    wrapped: 'node --import tsx scripts/turbo-run.ts run //#gate',
  };

  it('resolves a script a workflow step runs', () => {
    expect(resolveCi({ name: 'gate' }, scripts, 'run: pnpm gate')).toEqual([]);
  });

  it('resolves a script a workflow step reaches through another script', () => {
    expect(resolveCi({ name: 'gate' }, scripts, 'run: pnpm wrapper')).toEqual([]);
  });

  it('resolves a script a workflow step reaches through the task wrapper', () => {
    expect(resolveCi({ name: 'gate' }, scripts, 'run: pnpm wrapped')).toEqual([]);
  });

  it('refuses a script no workflow step reaches', () => {
    expect(resolveCi({ name: 'gate' }, scripts, 'run: pnpm install')).toEqual([
      expect.stringContaining('reached by no workflow step'),
    ]);
  });

  it('refuses a name that is no root script', () => {
    expect(resolveCi({ name: 'absent' }, scripts, 'run: pnpm absent')).toEqual([
      expect.stringContaining('no root package.json script'),
    ]);
  });

  it('refuses a flag the wired script never passes', () => {
    expect(
      resolveCi({ name: 'gate', parenthetical: '--lenient' }, scripts, 'run: pnpm gate')
    ).toEqual([expect.stringContaining('runs without')]);
  });
});

describe('the config resolver', () => {
  it('resolves a settings group the shared vitest config sets at a dotted key', () => {
    expect(resolveConfig({ name: 'coverage.thresholds' })).toEqual([]);
  });

  it('refuses a settings group emptied of every setting', () => {
    expect(
      resolveConfig({ name: 'gate.limits' }, '', 'export default { gate: { limits: {} } };')
    ).toEqual([expect.stringContaining('enforces nothing')]);
  });

  it('refuses a key no config file and no registry entry carries', () => {
    expect(resolveConfig({ name: 'noSuchConfigurationKey' })).toEqual([
      expect.stringContaining('no config file'),
    ]);
  });
});

describe('the report resolver', () => {
  it('refuses a module no reporter imports', () => {
    expect(resolveReport({ name: 'gitleaks-scan' })).toEqual([
      expect.stringContaining('imported by no reporter'),
    ]);
  });

  it('refuses a name with no reporting module', () => {
    expect(resolveReport({ name: 'no-such-reporter' })).toEqual([
      expect.stringContaining('no reporting module'),
    ]);
  });
});

describe.each(CITATION_KINDS)('%s citations', (kind) => {
  const forKind = citations.filter((citation) => citation.kind === kind);

  const cases = forKind.map((citation) => [`${citation.rule} — ${citation.token}`, citation]);
  it.each(cases.length === 0 ? [['no citation of this kind', undefined]] : cases)(
    'resolve: %s',
    async (_label, citation) => {
      const resolve =
        RESOLVERS[kind] ?? (() => [`the legend declares kind "${kind}" but nothing resolves it`]);
      const problems = citation === undefined ? [] : await resolve(splitTarget(citation.target));
      expect(problems, problems.join('; ')).toEqual([]);
    },
    // The first lint case waits on one child ESLint process per probe and the
    // first type case walks every TypeScript file in the repository.
    60_000
  );
});
