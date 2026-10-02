import path from 'node:path';
import { REGISTRY_MODULE, REGISTRY_OBJECT, registryMembers } from '../lib/evidence-registry.js';
import { failWith } from '../lib/paths.js';
import { REPO_ROOT } from '../lib/source-scope.js';
import type { RegistryMember } from '../lib/evidence-registry.js';
import type { FileSystemHost, Project } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A service name the evidence registry declares has to be required by a step a
 * commit runs.
 *
 * `verify:evidence --require=<name>` is what turns a written row into a gate:
 * the name is declared in one module, the row is written by the seam that made
 * the real call, and the step demanding the name is the only thing that fails
 * when the call stops happening. Declare the name and write no step and the
 * first two still look finished — a registry entry, a write site, a passing
 * suite — while nothing anywhere goes red if the seam goes dark. Two names sat
 * in exactly that state before this rule existed, and neither was visible from
 * any file either of them touched.
 *
 * SO THE WORKFLOW FILES ARE THE ONLY SOURCE FOR "REQUIRED". A list of required
 * names kept in TypeScript would be a second registry: it would agree with the
 * workflow on the day it was written and drift silently afterwards, which is
 * the failure this rule exists to stop rather than a cheaper way to detect it.
 * A generated file standing between the two is the same thing with an extra
 * step. The requirement is therefore read out of `.github/workflows/` at check
 * time, and nothing stands between the step that runs and the rule that reads
 * it.
 *
 * ONLY A WORKFLOW A COMMIT REACHES COUNTS. A requirement written into a
 * scheduled or manually dispatched workflow gates nothing on the way to the
 * default branch, so counting one would report a name as proven that no commit
 * ever proves. The trigger block is read for that, and a workflow reached only
 * through `workflow_call` counts for nothing here: its reachability is a
 * property of whoever calls it, which this does not follow. That limit falls in
 * the safe direction — a requirement hidden behind a caller edge is refused,
 * never quietly credited.
 *
 * WHAT THE PARSE ACCEPTS IS WHAT THE ENTRY POINT ACCEPTS, never what the
 * workflow happens to write today. `--require=a`, `--require=a,b` and the
 * detached `--require a` all reach `scripts/verify-evidence.ts`, which splits
 * the value on commas; a second `--require` on one invocation replaces the
 * first, exactly as the shared argument grammar's value flag does, so only the
 * last one contributes. A spelling this cannot read is REFUSED by name — an
 * argument it does not know, a trigger it cannot resolve, a registry member
 * carrying no inline name, an invocation carrying a shell quote, which it
 * deliberately does not model because a quote left in the text lands inside a
 * name rather than around one. A requirement that escapes even that leaves the
 * name it carried reading as unrequired, so an unread requirement refuses the
 * commit rather than passing it.
 *
 * WHAT IS CREDITED IS TEXT, WHICH IS LESS THAN ENFORCEMENT — this rule's one
 * accepted limit, stated because the refusals it does make read as a stronger
 * promise than it keeps. It reads lines; it holds no model of the step or job a
 * line sits in, and none of what decides whether a step's failure fails the
 * build. So a `verify:evidence --require` written anywhere in a workflow a
 * commit reaches credits its names, whatever that workflow would do with the
 * line — under `continue-on-error: true`, inside another key's block scalar, or
 * in any further shape that reads as a command without running as one. Each is
 * declined only by a step-and-job model of the file, more machine than this
 * whole reader, so the limit is accepted rather than closed. Its cost is
 * bounded by what it takes to reach: a requirement someone wrote and then
 * disarmed. The drift this exists to stop — a declared name with no requirement
 * written anywhere — is refused as before, and so is one written in a spelling
 * this cannot read.
 *
 * A DECLARED NAME IS AN INLINE STRING LITERAL on its member. A member written
 * any other way — a value held in another binding, a template, a spread from
 * elsewhere — is refused by name rather than passed over, because a member
 * passed over contributes nothing and the run would then hold the workflow
 * against part of the registry while reporting success over the whole of it.
 * That is the empty-registry abort's own reason, one member at a time.
 *
 * WHERE A COMMAND IS WRITTEN is a line that reads as a `run:` value — the
 * value on the key's own line, or the indented body below it, with the key
 * standing alone or first behind a step's sequence dash, and a block header
 * writing its indentation and chomping indicators in either order, as YAML
 * allows. A step named after the command, and a commented-out invocation, are
 * both prose, and reading either as a requirement would credit a name nothing
 * runs.
 *
 * THERE IS NO EXEMPTION HERE, deliberately. A seam that should be proven and
 * cannot be yet has its home in `docs/DECISIONS.md`, with the reason and the
 * condition that would reopen it; it does not get a declared name that nothing
 * demands.
 */

const RULE_NAME = 'declared-evidence-names-are-required';

const refuse: (message: string) => never = failWith(RULE_NAME);

/** Where a requirement is written, and the command that carries one. */
const WORKFLOWS_DIR = '.github/workflows';
const EVIDENCE_COMMAND = 'verify:evidence';
const REQUIRE_FLAG = '--require';

/** The events that put a workflow in a commit's path to the default branch. */
const COMMIT_EVENTS: readonly string[] = ['push', 'pull_request', 'merge_group'];

const MISSING_REGISTRY_REMEDY =
  'The declared names are read from that module so this rule holds no second copy of them; with ' +
  'it gone there is no set to hold the workflow against, and every name there is would read as ' +
  'required. Point this rule at the registry module in the change that moved it.';

const EMPTY_REGISTRY_MESSAGE =
  `${REGISTRY_MODULE} declares no \`${REGISTRY_OBJECT}\` names this rule can read. This is a ` +
  'LIVENESS failure of the rule, not a finding about a name: with nothing resolved it reports ' +
  'success over an invariant it has stopped enforcing. If the registry was renamed or changed ' +
  'shape, give this rule the new spelling in the same change.';

const MISSING_WORKFLOWS_MESSAGE =
  `\`${WORKFLOWS_DIR}\` holds no directory this rule can read, and the workflow files are its ` +
  'only source for which names a commit proves. With them gone every declared name would read ' +
  'as unrequired or as required depending on nothing at all, so this aborts rather than ' +
  'reporting either.';

const NO_COMMIT_GATED_MESSAGE =
  `No workflow under \`${WORKFLOWS_DIR}\` is reached by a commit (${COMMIT_EVENTS.join(', ')}), ` +
  'so there is no step whose requirement could prove anything. A requirement only gates what ' +
  'runs on the way to the default branch; with nothing running there, this rule has no subject ' +
  'and aborts rather than accusing every declared name at once.';

/** One declared name, and the line a violation about it points at. */
interface DeclaredName {
  readonly name: string;
  readonly line: number;
}

function unreadableMember(member: RegistryMember): string {
  return (
    `\`${REGISTRY_OBJECT}\` in ${REGISTRY_MODULE}:${String(member.line)} ` +
    `writes \`${member.written}\`, whose name this rule cannot read: a declared name is an ` +
    'inline string literal on its member, and anything else is a value only the compiler ' +
    'resolves. Passing the member over would hold the workflow against the rest of the registry ' +
    'while reporting success over the whole of it, which is the same silent green the ' +
    'empty-registry arm aborts on, one member at a time. Write the name inline, or teach this ' +
    'rule the spelling in the change that introduces one.'
  );
}

/** The name one registry member declares; one written in a shape the walk could not read aborts. */
function declaredMember(member: RegistryMember): DeclaredName {
  if (member.name === undefined) refuse(unreadableMember(member));
  return { name: member.name, line: member.line };
}

/** Every declared name, over the shared read of the registry module. */
function declaredNames(project: Project): DeclaredName[] {
  return registryMembers(
    RULE_NAME,
    project,
    { missingModule: MISSING_REGISTRY_REMEDY, emptyRegistry: EMPTY_REGISTRY_MESSAGE },
    (member) => declaredMember(member)
  );
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A line with its comment dropped: a `#` starting the line, or following whitespace. */
function stripComment(line: string): string {
  const comment = /(?:^|\s)#/.exec(line);
  return comment === null ? line : line.slice(0, comment.index);
}

/** One line of a `run:` value, and where it is written. */
interface CommandLine {
  readonly line: number;
  readonly text: string;
}

const RUN_KEY = 'run:';

/** YAML's sequence marker: what a step's first key sits behind, and a trigger written as an item. */
const SEQUENCE_DASH = '-';

/**
 * A `run:` value written below the key: a block-scalar header, or nothing at
 * all. YAML writes the header's indentation and chomping indicators in either
 * order, so both are read.
 */
const WRITTEN_BELOW = /^(?:[|>](?:[+-]?\d*|\d+[+-]?))?$/;

function commandLine(index: number, text: string): CommandLine {
  return { line: index + 1, text };
}

/** A body written below its key runs until a line comes back out to the key's own indentation. */
function continuesBody(line: string, indent: number): boolean {
  return line.trim() === '' || indentOf(line) > indent;
}

/** What one `run:` key carries on its own line, and the indentation a body below it clears. */
interface RunValue {
  readonly indent: number;
  readonly text: string;
}

/** What sits past a sequence dash, for a step whose first key is written beside it. */
function pastSequenceDash(content: string): string {
  const item = content.startsWith(SEQUENCE_DASH) ? content.slice(SEQUENCE_DASH.length) : content;
  return item.startsWith(' ') ? item.trimStart() : content;
}

function runValue(line: string): RunValue | undefined {
  const key = pastSequenceDash(line.trimStart());
  if (!key.startsWith(RUN_KEY)) return undefined;
  return {
    indent: line.length - key.length,
    text: stripComment(key.slice(RUN_KEY.length)).trim(),
  };
}

/**
 * Every line that reads as a `run:` value, and the body below one, as against
 * the many places a workflow writes the command's name.
 */
function commandLines(text: string): CommandLine[] {
  const lines = text.split('\n');
  const commands: CommandLine[] = [];
  let bodyBelow: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (bodyBelow !== undefined && continuesBody(line, bodyBelow)) {
      commands.push(commandLine(index, line));
      continue;
    }
    bodyBelow = undefined;
    const written = runValue(line);
    if (written === undefined) continue;
    if (WRITTEN_BELOW.test(written.text)) bodyBelow = written.indent;
    else commands.push(commandLine(index, written.text));
  }
  return commands;
}

/** How a refusal names the invocation it could not read. */
function at(file: string, command: CommandLine): string {
  return `${file}:${String(command.line)}, \`${command.text.trim()}\``;
}

/** The token at a position, or nothing past the end — the read carries its own bound. */
function tokenAt(tokens: readonly string[], index: number): string {
  return tokens.slice(index, index + 1).join('');
}

/** The one group a match carries, read without an index whose bound nothing checks. */
function captured(match: RegExpExecArray): string {
  return match.slice(1).join('');
}

/** The names one `--require` value carries, as the entry point splits it. */
function namesIn(value: string, where: string): string[] {
  const names = value.split(',').map((name) => name.trim());
  if (names.includes('')) {
    refuse(
      `${where} carries a \`${REQUIRE_FLAG}\` value with an empty name in it, which the ` +
        'verifier refuses at run time. Write the names it means, so this rule and that run ' +
        'read the same requirement.'
    );
  }
  return names;
}

/**
 * The value the invocation's last `--require` carries.
 *
 * Last rather than every one, because the shared argument grammar reads a value
 * flag that way: a second `--require` replaces the first, and crediting both
 * would report a name as required that the step never demands.
 */
function requiredValue(tokens: readonly string[], where: string): string {
  let value: string | undefined;
  for (let index = 0; index < tokens.length; ) {
    const token = tokenAt(tokens, index);
    if (token === REQUIRE_FLAG) {
      const next = tokenAt(tokens, index + 1);
      if (next === '' || next.startsWith('-')) {
        refuse(`${where} writes \`${REQUIRE_FLAG}\` with no value after it.`);
      }
      value = next;
      index += 2;
      continue;
    }
    if (token.startsWith(`${REQUIRE_FLAG}=`)) {
      value = token.slice(REQUIRE_FLAG.length + 1);
      index += 1;
      continue;
    }
    refuse(
      `${where} writes \`${token}\`, which this rule cannot read. It reads what ` +
        `\`${EVIDENCE_COMMAND}\` accepts, and passing over an argument it does not know would ` +
        'credit or drop a requirement silently. Teach it the spelling in the change that ' +
        'introduces one.'
    );
  }
  if (value === undefined) {
    refuse(
      `${where} names no service, and the verifier refuses an invocation without ` +
        `\`${REQUIRE_FLAG}\` at run time.`
    );
  }
  return value;
}

const SHELL_QUOTE = /['"]/;

/** The names one command line requires; a line invoking something else requires none. */
function requiredBy(command: CommandLine, file: string): string[] {
  const text = stripComment(command.text);
  const invoked = text.indexOf(EVIDENCE_COMMAND);
  if (invoked === -1) return [];
  const where = at(file, command);
  if (SHELL_QUOTE.test(text)) {
    refuse(
      `${where} carries a shell quote, which this rule does not model. A quote left in the text ` +
        'lands inside a name: the command reads as requiring one the shell never passes it, and ' +
        'the name it does require reads as required by nothing. Write the invocation unquoted, ' +
        'so this rule and that run read the same requirement.'
    );
  }
  const tokens = text
    .slice(invoked + EVIDENCE_COMMAND.length)
    .split(/\s+/)
    .filter((token) => token !== '');
  return namesIn(requiredValue(tokens, where), where);
}

const ON_KEY = /^(?:on|'on'|"on"):(.*)$/;
const EVENT_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const KEY_COLON = ':';

function unquoted(value: string): string {
  return value.replaceAll(/^['"]|['"]$/g, '');
}

function readEvent(event: string, written: string, file: string): string {
  if (!EVENT_NAME.test(event)) {
    refuse(`${file} writes a trigger this rule cannot read: \`${written}\`.`);
  }
  return event;
}

/** `on: push` and `on: [push, merge_group]` — the spellings written beside the key. */
function inlineEvents(written: string, file: string): string[] {
  const sequence = /^\[(.*)]$/.exec(written);
  const items = sequence === null ? [written] : captured(sequence).split(',');
  return items.map((item) => readEvent(unquoted(item.trim()), written, file));
}

/** A trigger written below the key, as either a mapping key or a sequence item. */
function blockEvent(line: string, file: string): string {
  const content = stripComment(line).trim();
  const written = content.startsWith(SEQUENCE_DASH)
    ? content.slice(SEQUENCE_DASH.length).trim()
    : withoutColon(content);
  return readEvent(unquoted(written), content, file);
}

function withoutColon(content: string): string {
  return content.endsWith(KEY_COLON) ? content.slice(0, -KEY_COLON.length) : content;
}

/** The events written below the key, at whichever indentation the block's own entries sit. */
function blockEvents(lines: readonly string[], onLine: number, file: string): string[] {
  const block: string[] = [];
  for (const line of lines.slice(onLine + 1)) {
    if (line.trim() === '') continue;
    if (indentOf(line) === 0) break;
    block.push(line);
  }
  const entries = block.filter((line) => !line.trimStart().startsWith('#'));
  if (entries.length === 0) refuse(`${file} writes an \`on:\` block holding no trigger.`);
  const outermost = Math.min(...entries.map((line) => indentOf(line)));
  return entries
    .filter((line) => indentOf(line) === outermost)
    .map((line) => blockEvent(line, file));
}

/** The trigger key's position, and whatever it carries on its own line. */
interface TriggerKey {
  readonly index: number;
  readonly written: string;
}

function triggerKey(lines: readonly string[]): TriggerKey | undefined {
  for (const [index, line] of lines.entries()) {
    const key = ON_KEY.exec(line);
    if (key === null) continue;
    return { index, written: stripComment(captured(key)).trim() };
  }
  return undefined;
}

/** Every event that fires one workflow. */
function triggerEvents(text: string, file: string): string[] {
  const lines = text.split('\n');
  const key = triggerKey(lines);
  if (key === undefined) {
    refuse(
      `${file} declares no top-level \`on:\` block, so this rule cannot tell whether a commit ` +
        'reaches the requirements written in it.'
    );
  }
  return key.written === '' ? blockEvents(lines, key.index, file) : inlineEvents(key.written, file);
}

function workflowFiles(fileSystem: FileSystemHost): string[] {
  const directory = path.join(REPO_ROOT, WORKFLOWS_DIR);
  if (!fileSystem.directoryExistsSync(directory)) refuse(MISSING_WORKFLOWS_MESSAGE);
  return fileSystem
    .readDirSync(directory)
    .filter((entry) => entry.isFile && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name);
}

/** Every name a commit-reached step demands, read out of the workflows themselves. */
function requiredNames(project: Project): Set<string> {
  const fileSystem = project.getFileSystem();
  const required = new Set<string>();
  let reached = 0;
  for (const filePath of workflowFiles(fileSystem)) {
    const file = `${WORKFLOWS_DIR}/${path.basename(filePath)}`;
    const text = fileSystem.readFileSync(filePath);
    if (!triggerEvents(text, file).some((event) => COMMIT_EVENTS.includes(event))) continue;
    reached += 1;
    for (const command of commandLines(text)) {
      for (const name of requiredBy(command, file)) required.add(name);
    }
  }
  if (reached === 0) refuse(NO_COMMIT_GATED_MESSAGE);
  return required;
}

function violationMessage(name: string): string {
  return (
    `\`${name}\` is declared in ${REGISTRY_MODULE}, and no \`${EVIDENCE_COMMAND} ` +
    `${REQUIRE_FLAG}\` in a workflow a commit reaches demands it. A declared name nothing ` +
    'demands proves nothing: the seam can stop making its real call and every gate stays green, ' +
    'which is the drift this rule exists to make unwritable. Require the name in the job that ' +
    'exercises the seam, or drop the declaration — a seam that should be proven and cannot be ' +
    'yet is recorded in `docs/DECISIONS.md` instead of carrying a name here.'
  );
}

const rule: ArchRule = {
  name: RULE_NAME,
  check(project) {
    const declared = declaredNames(project);
    const required = requiredNames(project);
    return declared
      .filter((entry) => !required.has(entry.name))
      .map(
        (entry): ArchViolation => ({
          file: REGISTRY_MODULE,
          line: entry.line,
          message: violationMessage(entry.name),
        })
      );
  },
};

export default rule;
