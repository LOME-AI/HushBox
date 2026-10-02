/**
 * The privacy gate as the hooks run it: both content gates over the blobs a
 * stage would publish, plus the push-stage checks no content gate can see.
 *
 * Both gates run, always. Each one's silence covers only its own domain — the
 * text gate defers every blob the binary format registry claims, and the binary
 * gate never reads a blob that is text — so mounting either alone reads a
 * half-verdict as a clean one. The blob set is dispatched by the same registry
 * both gates consult, and a blob neither recognises is still handed to both:
 * over-reporting is the safe direction, silence is not.
 *
 * Blobs come from git rather than the worktree at both stages, addressed by
 * object id: the commit stage judges what is staged, the push stage judges what
 * the push would publish, and a worktree read would answer for neither.
 */
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { readStdin } from './lib/cli/read-stdin.js';
import { runMain } from './lib/cli/run-main.js';
import { checkPushDestination, readRepositories } from './configure-git-clone.js';
import { checkCommitWindow } from './git-window.js';
import { detectBinaryFormat } from './lib/privacy/binary/format-registry.js';
import { classifyBinaryBlob, isBinaryBlob } from './lib/privacy/binary/scan.js';
import { isDayBoundarySeconds } from './lib/privacy/instants.js';
import { formatPrivacyReport } from './lib/privacy/report.js';
import { PRIVACY_ALLOWLIST_PATH, parsePrivacyAllowlist } from './lib/privacy/allowlist.js';
import { LIVE_RULE_NAMES, scanTextBlobs } from './lib/privacy/rules.js';
import { withoutHostPaths } from './lib/privacy/host-paths.js';
import {
  advertisedObjectIds,
  hasNewRef,
  parsePushReferences,
  resolvePushedRefRanges,
} from './lib/cli/pushed-range.js';
import {
  readAllowlistFromIndex,
  readBlobsByEntries,
  readIndexBlobs,
} from './lib/privacy/verify-content-privacy.js';
import type { PrivacyAllowlistEntry } from './lib/privacy/allowlist.js';
import type { BinaryFinding, BinaryVerdict } from './lib/privacy/binary/scan.js';
import type { PrivacyFinding, TextBlobEntry } from './lib/privacy/rules.js';
import type { DestinationReferences, PushedRefRange } from './lib/cli/pushed-range.js';
import type { IndexEntry } from './lib/privacy/verify-content-privacy.js';

const UTC_OFFSET = '+0000';

export interface BinaryOutcome {
  readonly file: string;
  readonly verdict: BinaryVerdict;
  readonly findings: readonly BinaryFinding[];
}

export interface GateFindings {
  readonly text: readonly PrivacyFinding[];
  readonly binary: readonly BinaryOutcome[];
}

/** A check that stops the stage outright, with no content finding to point at. */
interface Refusal {
  readonly check: string;
  readonly detail: string;
}

export interface GateOutcome {
  readonly report: string;
  readonly code: number;
}

/**
 * The object ids this push publishes, taken from `git rev-list --objects` — and
 * **only** the ids. The range's own commits are among them, harmlessly: no
 * commit id ever appears as a blob in a tree listing.
 *
 * That command answers with one path per object, chosen from however many the
 * object has, on a line-framed stream that truncates a path at its first
 * newline. Both properties blinded this gate: a blob reached at an out-of-scope
 * path and at a live one was judged only at the out-of-scope one, and a path
 * carrying a newline was read as a shorter path belonging to nothing. An object
 * id has no grammar, so it is the half of the answer worth keeping; the paths
 * come from a framing that cannot lie.
 */
export function parsePublishedObjectIds(stdout: string): Set<string> {
  const ids = new Set<string>();
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf(' ');
    const objectId = separator === -1 ? line : line.slice(0, separator);
    if (objectId !== '') ids.add(objectId);
  }
  return ids;
}

/**
 * Every object-and-path pair in a tree listing. `git ls-tree -r -z` writes
 * `<mode> <type> <object id>\t<path>` per record with NUL between records, so a
 * path keeps every byte it has — tab, space and newline included — and one blob
 * appears once per path rather than once in total.
 *
 * The pair is the unit because every scope decision downstream is path-keyed:
 * the prose-only rules and the allowlist. Two paths to one blob are
 * two decisions, and taking either as the answer publishes the other unexamined.
 */
export function parseTreeListing(stdout: string): IndexEntry[] {
  const entries = new Map<string, IndexEntry>();
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const [, type = '', objectId = ''] = record.slice(0, tab).split(' ');
    // A gitlink names another repository's commit, and carries no blob to read.
    if (type !== 'blob') continue;
    const path = record.slice(tab + 1);
    entries.set(`${objectId}\0${path}`, { objectId, path });
  }
  return [...entries.values()];
}

/**
 * Whether the binary gate examines this blob: it does when the blob carries a
 * NUL *or* when the format registry claims it. Both arms are load-bearing. The
 * NUL is git's own text-versus-binary test; the registry catches a container
 * with no NUL in its head, which the text gate skips precisely *because* the
 * registry claims it — a two-frame MPEG file of ASCII payload bytes is examined
 * by nobody if this reads only the first arm.
 */
export function needsBinaryGate(bytes: Uint8Array): boolean {
  return isBinaryBlob(bytes) || detectBinaryFormat(bytes) !== undefined;
}

/**
 * Both gates over one blob set. A blob claimed by neither still reaches the
 * text gate, so every blob in scope is examined by at least one gate that
 * actually looked at it.
 */
export function scanBlobs(
  blobs: readonly TextBlobEntry[],
  allowlist: readonly PrivacyAllowlistEntry[]
): GateFindings {
  const binary: BinaryOutcome[] = [];
  for (const entry of blobs) {
    if (!needsBinaryGate(entry.bytes)) continue;
    const { verdict, findings } = classifyBinaryBlob(entry.path, entry.bytes, allowlist);
    if (verdict !== 'clean') binary.push({ file: entry.path, verdict, findings });
  }
  return { text: scanTextBlobs(blobs, allowlist), binary };
}

/**
 * Whether a finding set stops the stage. Exported because the CI sweep decides
 * the same question over the same shape, and a second reading of it would be
 * free to disagree about whether a third-party binary admission blocks.
 */
export function isBlocked(findings: GateFindings): boolean {
  return findings.text.length > 0 || findings.binary.some((outcome) => outcome.verdict === 'dirty');
}

function binaryFindingLine(finding: BinaryFinding): string {
  // The location is a position inside the container's own structure, and for a
  // whole-blob finding there is none; the kind already names the region.
  const inside = finding.location === '' || finding.kind.endsWith(`:${finding.location}`);
  const where = inside ? finding.kind : `${finding.kind} ${finding.location}`;
  // These fields are composed by the binary gate from structure it parsed out of
  // the blob. Every parser sampled bounds them to a known set, so nothing forges
  // a line today — but a report that stays line-safe only while another
  // component keeps a promise is trusting rather than checking, and the escape
  // is already here.
  return `    ${reportablePath(finding.rule)}  ${reportablePath(where)}  shape ${reportablePath(finding.shape)}`;
}

function binaryOutcomeLines(outcome: BinaryOutcome): string[] {
  return [
    `  ${outcome.verdict}  ${outcome.file}`,
    ...outcome.findings.map((finding) => binaryFindingLine(finding)),
  ];
}

function formatBinaryFindings(outcomes: readonly BinaryOutcome[]): string {
  const dirty = outcomes.filter((outcome) => outcome.verdict === 'dirty');
  return [
    `Binary gate: ${String(dirty.length)} blob(s) needing a human, ${String(outcomes.length - dirty.length)} admitted as third-party.`,
    ...outcomes.flatMap((outcome) => binaryOutcomeLines(outcome)),
    ...(dirty.length === 0
      ? []
      : [
          '',
          'Remedy: pnpm fix:binary-privacy <path> strips metadata losslessly, or refuses and',
          'leaves the file alone. A refusal means the gate could not read what it was asked to',
          'clean, which is a decision for a person rather than a pass.',
        ]),
  ].join('\n');
}

export function formatGateReport(findings: GateFindings): string {
  if (findings.text.length === 0 && findings.binary.length === 0) {
    return 'Privacy gate: no findings. Both gates examined every blob in scope.';
  }
  return [
    ...(findings.text.length > 0 ? [formatPrivacyReport(findings.text)] : []),
    ...(findings.binary.length > 0 ? [formatBinaryFindings(findings.binary)] : []),
  ].join('\n\n');
}

function formatRefusals(refusals: readonly Refusal[]): string {
  return [
    `Privacy gate: ${String(refusals.length)} refusal(s). A refusal is a stop, not a pass.`,
    '',
    ...refusals.map((refusal) => `  ${refusal.check}  ${refusal.detail}`),
  ].join('\n');
}

const BYPASS_NOTE =
  'This hook is skippable (--no-verify, HUSKY=0); CI runs the same gate over the whole tree of the commit under test.';

function outcomeOf(findings: GateFindings, refusals: readonly Refusal[]): GateOutcome {
  const blocked = isBlocked(findings) || refusals.length > 0;
  // A refusal means nothing was examined, so a "no findings" line beside one
  // would be the silence-as-verdict this gate exists to refuse.
  const silent = findings.text.length === 0 && findings.binary.length === 0;
  const report = [
    ...(refusals.length > 0 ? [formatRefusals(refusals)] : []),
    ...(refusals.length > 0 && silent ? [] : [formatGateReport(findings)]),
  ].join('\n\n');
  return { report: blocked ? `${report}\n\n${BYPASS_NOTE}` : report, code: blocked ? 1 : 0 };
}

async function gitOutput(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa('git', ['-C', cwd, ...args], { reject: false });
  // Success is the narrow branch here for the reason it is narrow in the
  // advertisement: a timeout or a spawn failure leaves no exit code, and a guard
  // that only rejects positive codes reads that absence as a pass.
  if (result.exitCode === 0) return result.stdout;
  const [subcommand = 'command'] = args;
  const diagnosis = withoutHostPaths(result.stderr.split('\n')[0] ?? '');
  throw new Error(`git ${subcommand} failed (exit ${String(result.exitCode)}): ${diagnosis}`);
}

/** A config read whose absence is an answer rather than a failure. */
async function configuredValue(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execa('git', ['-C', cwd, 'config', ...args], { reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

/**
 * The paths this commit would write. Deletions are dropped: a path being
 * removed carries no blob to scan.
 */
async function stagedPaths(cwd: string): Promise<string[]> {
  const stdout = await gitOutput(cwd, ['diff', '--cached', '--name-only', '-z', '--diff-filter=d']);
  return stdout.split('\0').filter((entry) => entry.length > 0);
}

/**
 * The characters that can forge a line of output, each with the escape a
 * developer reads back: everything below the space, plus DEL. Built as a band
 * rather than tested one member at a time, because a band tested at one member
 * is a band pinned nowhere. JSON escaping covers the band's familiar members and
 * stops below DEL, which is why DEL is spelled out.
 */
const CONTROL_ESCAPES = new Map<string, string>([
  ...Array.from({ length: 0x20 }, (_unused, code): [string, string] => [
    String.fromCodePoint(code),
    JSON.stringify(String.fromCodePoint(code)).slice(1, -1),
  ]),
  ['\u007F', String.raw`\u007f`],
]);

/**
 * A path as the report may print it. Both gates report one finding per line and
 * a path is file-controlled, so a path carrying a newline would forge a line —
 * the same class of trust as the git framing, one consumer along. Every
 * scope decision is made on this rendering too, which fails closed: an allowlist
 * entry cannot be written to match a control character it does not contain.
 *
 * The commit stage needs none of this. The index listing refuses a path with a
 * newline outright, which predates this and stays.
 */
export function reportablePath(path: string): string {
  return Array.from(path, (character) => CONTROL_ESCAPES.get(character) ?? character).join('');
}

/**
 * One commit's whole tree as object-and-path pairs. `--full-tree` is what makes
 * the answer the commit's tree rather than the part of it below the working
 * directory: without it a caller one directory down is told a tree with nothing
 * in it, and a listing that under-reports is a scope decision nobody made.
 */
export async function listTreePairs(cwd: string, commit: string): Promise<IndexEntry[]> {
  return parseTreeListing(await gitOutput(cwd, ['ls-tree', '-r', '-z', '--full-tree', commit]));
}

const pairKey = (entry: IndexEntry): string => `${entry.objectId}\0${entry.path}`;

/**
 * The objects this push publishes that no pair locates and no walk visited.
 *
 * This is the closed-world half of the enumeration. A guard tests the shapes you
 * enumerated; a reconciliation tests the ones you did not — a ref whose tip is a
 * blob walks no commits, produces no pair, and is caught here without anyone
 * having anticipated it. Over this repository's whole history the
 * residue under this rule is the walk's own commits and nothing else, so the
 * check does not fire on ordinary work.
 */
export function unaccountedObjects(
  published: ReadonlySet<string>,
  pairs: readonly IndexEntry[],
  commits: readonly string[]
): string[] {
  const located = new Set<string>([...pairs.map((entry) => entry.objectId), ...commits]);
  return [...published].filter((objectId) => !located.has(objectId));
}

/**
 * A revision list with nothing in it is not a scope, and the two commands it
 * reaches disagree about what it means: `git log` reads it as every commit
 * reachable from HEAD, `git rev-list` rejects it as a usage error. Neither
 * reading is "nothing", so an empty list is refused before either command sees
 * it rather than left to be interpreted.
 */
export function assertScopedRevisions(revisions: readonly string[]): void {
  if (revisions.length === 0) {
    throw new Error('A range naming no revisions cannot scope a push.');
  }
}

interface RangeWalk {
  /** The commits this range publishes. */
  readonly commits: string[];
  /** The excluded commits the walk stopped at: the state the remote already has. */
  readonly boundary: string[];
}

function parseBoundaryWalk(stdout: string): RangeWalk {
  const walk: RangeWalk = { commits: [], boundary: [] };
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('-')) walk.boundary.push(line.slice(1));
    else walk.commits.push(line);
  }
  return walk;
}

interface PushedContent {
  readonly blobs: TextBlobEntry[];
  readonly refusals: Refusal[];
}

/**
 * Everything one ref publishes, at every path it publishes it at, and an account
 * of anything the enumeration could not place.
 *
 * Novelty is a property of the **pair**, not of the object. A blob already on
 * the remote is not new, but the path it now sits at may be — which is exactly
 * what happens when a file moves out from under a path-scoped allowlist entry, and
 * judging that by the object alone publishes it unexamined. The pairs the
 * boundary commits already carry are what the remote has; everything else in
 * this range's trees is what the push adds.
 *
 * A blob at two paths is read twice rather than once. That is deliberate: the
 * scan is per path because the scope decisions are.
 */
async function readPushedContent(
  cwd: string,
  revisions: readonly string[]
): Promise<PushedContent> {
  assertScopedRevisions(revisions);
  const walk = parseBoundaryWalk(await gitOutput(cwd, ['rev-list', '--boundary', ...revisions]));
  const published = parsePublishedObjectIds(
    await gitOutput(cwd, ['rev-list', '--objects', '--filter=object:type=blob', ...revisions])
  );
  const pairs = new Map<string, IndexEntry>();
  for (const commit of walk.commits) {
    for (const entry of await listTreePairs(cwd, commit)) pairs.set(pairKey(entry), entry);
  }
  const prior = new Set<string>();
  for (const commit of walk.boundary) {
    for (const entry of await listTreePairs(cwd, commit)) prior.add(pairKey(entry));
  }
  const unaccounted = unaccountedObjects(published, [...pairs.values()], walk.commits);
  const novel = [...pairs.entries()]
    .filter(([key]) => !prior.has(key))
    .map(([, entry]) => ({ objectId: entry.objectId, path: reportablePath(entry.path) }));
  return {
    blobs: await readBlobsByEntries(cwd, novel),
    refusals: unaccounted.map((objectId) => ({
      check: 'unaccounted object',
      detail: `this push publishes ${objectId.slice(0, 12)} and the enumeration cannot say where it sits`,
    })),
  };
}

/**
 * The allowlist the judged commit itself carries. An exemption read from the
 * index can be staged and never committed, which would let a developer suppress
 * a finding on a push whose commits do not contain the suppression.
 */
export async function readAllowlistFromTip(
  cwd: string,
  tip: string
): Promise<PrivacyAllowlistEntry[]> {
  const tipPairs = await listTreePairs(cwd, tip);
  const entry = tipPairs.find((pair) => pair.path === PRIVACY_ALLOWLIST_PATH);
  const blobs = await readBlobsByEntries(cwd, entry === undefined ? [] : [entry]);
  return blobs.flatMap((blob) =>
    parsePrivacyAllowlist(Buffer.from(blob.bytes).toString('utf8'), LIVE_RULE_NAMES)
  );
}

interface CommitStamp {
  readonly commit: string;
  readonly role: string;
  readonly epoch: number;
  readonly offset: string;
  /** Who committed it, which is the only provenance a commit carries. */
  readonly committerEmail: string;
}

/**
 * The address the forge commits under whenever it mints a commit itself — the
 * squash a merge queue lands on a trunk, a merge it builds for a queue group,
 * an edit made through the web. It is not the no-reply address a person is
 * given, which carries an account in front of the domain.
 */
const FORGE_COMMITTER_EMAIL = 'noreply@github.com';

/**
 * A commit the forge minted, which no hook of this repository ever saw. Its
 * stamps are the platform's clock and there is nothing in them a developer
 * could have coarsened, so they are read past rather than refused.
 *
 * Keyed to provenance rather than to the event that surfaced the commit,
 * because one such commit is surfaced by all of them: the queue's own run, the
 * push that lands it on the public trunk, and the sync bot's push carrying it
 * onto staging — by fast-forward, or under a merge whose second parent it is. A
 * rule keyed to arrival holds only on the arms someone thought of, and the arm
 * nobody thought of is where the trunk stops being publishable.
 *
 * A clone can spell this address, so the exemption is forgeable — as every
 * stage of this gate family is, the hooks being skippable by design. What it
 * must never do is read past a commit written under any other address.
 */
const mintedByForge = (stamp: CommitStamp): boolean =>
  stamp.committerEmail === FORGE_COMMITTER_EMAIL;

/**
 * `<commit>\0<author raw date>\0<committer raw date>\0<committer email>`, one
 * record per commit.
 */
function parseCommitStamps(stdout: string): CommitStamp[] {
  const stamps: CommitStamp[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [commit = '', author = '', committer = '', committerEmail = ''] = line.split('\0');
    for (const [role, raw] of [
      ['author', author],
      ['committer', committer],
    ] as const) {
      const [epoch = '', offset = ''] = raw.split(' ');
      stamps.push({ commit, role, epoch: Number(epoch), offset, committerEmail });
    }
  }
  return stamps;
}

/**
 * Why this stamp fails, or null when it does not. The two grounds are
 * independent and their remedies are different: a stamp at midnight in another
 * zone needs its zone changed, and telling that developer to coarsen a time of
 * day sends them to a fix that changes nothing.
 */
function stampFailure(stamp: CommitStamp): string | null {
  if (stamp.offset !== UTC_OFFSET) return 'is rendered in a zone other than UTC';
  return isDayBoundarySeconds(stamp.epoch) ? null : 'is finer than a UTC day';
}

/**
 * Every commit this push would publish carries day resolution on both stamps.
 * The normalizer that produces conforming commits refuses some of them by
 * design, and this is what stops a refused commit reaching a remote.
 *
 * The stamps are all this check reads. Message text and the remaining headers
 * are deliberately unscanned: machine-composed merge, revert, and squash
 * messages were each examined and carry no timestamp, host path, or machine
 * identity, and the body is what a developer types — prose discipline
 * (`docs/AGENT-RULES.md` §Privacy), not a scanner, is the control there.
 */
export async function commitDateRefusals(
  cwd: string,
  revisions: readonly string[]
): Promise<Refusal[]> {
  assertScopedRevisions(revisions);
  const stdout = await gitOutput(cwd, [
    'log',
    // The raw committer field, not its mapped form — one letter apart. The
    // forge exemption turns on that address, and a mailmap file in the
    // repository rewrites addresses for the mapped form, so reading it mapped
    // would let a committed file map a developer's commits out of this check.
    '--format=%H%x00%ad%x00%cd%x00%ce',
    '--date=raw',
    ...revisions,
  ]);
  return parseCommitStamps(stdout).flatMap((stamp) => {
    if (mintedByForge(stamp)) return [];
    const failure = stampFailure(stamp);
    return failure === null
      ? []
      : [
          {
            check: 'commit-date',
            detail: `the ${stamp.role} date on commit ${stamp.commit.slice(0, 12)} ${failure}`,
          },
        ];
  });
}

/**
 * An annotated tag is an object of its own, and it seals a tagger stamp no
 * commit rewrite can reach. A lightweight tag is a name for a commit and
 * carries nothing.
 *
 * The test is the object's type, never the ref's namespace: the stamp belongs
 * to the object, so a tag object pushed under any other ref name carries it
 * just the same — and would otherwise reach the blob reader, which fails on an
 * object that is not a blob with a message naming neither the check nor the
 * cause.
 */
async function annotatedTagRefusals(
  cwd: string,
  references: readonly PushedRefRange[]
): Promise<Refusal[]> {
  const refusals: Refusal[] = [];
  for (const { ref, tip } of references) {
    const result = await execa('git', ['-C', cwd, 'cat-file', '-t', tip], { reject: false });
    if (result.stdout.trim() === 'tag') {
      refusals.push({
        check: 'annotated tag',
        detail: `${withoutHostPaths(ref)} names an annotated tag, whose tagger stamp carries a time of day`,
      });
    }
  }
  return refusals;
}

/**
 * An OpenPGP signature packet embeds its own second-precision creation time, so
 * a clone that signs in that format publishes a clock however conforming its
 * commit dates are. The check keys on the clone's configuration, which is what
 * decides the format of the next signature.
 */
async function signingRefusal(cwd: string): Promise<Refusal | null> {
  const signs = await configuredValue(cwd, ['--type=bool', '--get', 'commit.gpgsign']);
  if (signs !== 'true') return null;
  const format = await configuredValue(cwd, ['--default', 'openpgp', '--get', 'gpg.format']);
  if (format === 'ssh') return null;
  return {
    check: 'signature format',
    detail: `commit.gpgsign is on with gpg.format ${withoutHostPaths(format)}: only ssh signatures carry no timestamp`,
  };
}

interface PushStageOptions {
  readonly stdin: string;
  /** The remote git named on the hook's command line, never a guess. */
  readonly remote: string;
  readonly remoteUrl: string;
}

const NOTHING_SCANNED: GateFindings = { text: [], binary: [] };

/**
 * The clone's own commit/push window, which both stages consult before they do
 * any work: it needs no blob, no remote and no range, and nothing either stage
 * could discover would change its answer. Unset on every clone by default,
 * which is when it returns nothing at all.
 */
async function windowRefusals(cwd: string): Promise<Refusal[]> {
  const detail = await checkCommitWindow(cwd);
  return detail === null ? [] : [{ check: 'commit window', detail }];
}

/**
 * The refs are resolved once and handed to every check that needs them. The
 * remote decides what a range excludes, so a second resolution is a second
 * chance to resolve it differently — which is how one call site came to be
 * pinned while its sibling one line away failed open.
 */
async function pushRefusals(
  cwd: string,
  options: PushStageOptions,
  references: readonly PushedRefRange[]
): Promise<Refusal[]> {
  const destination = await checkPushDestination(cwd, options.remoteUrl, await readRepositories());
  const signing = await signingRefusal(cwd);
  const dates: Refusal[] = [];
  for (const { range } of references)
    dates.push(...(await commitDateRefusals(cwd, range.revisions)));
  return [
    // First, because it is the one refusal here that needs no range, no remote
    // and no blob: whatever else this push turns out to carry, a clone outside
    // its window is not pushing it.
    ...(await windowRefusals(cwd)),
    ...(destination === null ? [] : [{ check: 'push destination', detail: destination }]),
    ...(await annotatedTagRefusals(cwd, references)),
    ...(signing === null ? [] : [signing]),
    ...dates,
  ];
}

export async function runCommitStage(cwd: string): Promise<GateOutcome> {
  const window = await windowRefusals(cwd);
  if (window.length > 0) return outcomeOf(NOTHING_SCANNED, window);
  const paths = await stagedPaths(cwd);
  if (paths.length === 0) {
    return { report: 'Privacy gate: nothing staged, nothing to scan.', code: 0 };
  }
  const [blobs, allowlist] = await Promise.all([
    readIndexBlobs(cwd, paths),
    readAllowlistFromIndex(cwd),
  ]);
  return outcomeOf(scanBlobs(blobs, allowlist), []);
}

/**
 * What the destination already holds, asked of the destination itself.
 *
 * Only a new ref needs asking: for every other ref git's own protocol line
 * carries the destination's answer, so the common push costs no round trip. A
 * question that cannot be asked is a refusal rather than a guess — the guess
 * available here is this clone's remote-tracking refs, which describe where it
 * fetches from and not where it pushes to.
 */
async function destinationHolding(
  cwd: string,
  options: PushStageOptions
): Promise<DestinationReferences> {
  if (!hasNewRef(parsePushReferences(options.stdin))) {
    return { established: true, objectIds: [] };
  }
  return advertisedObjectIds(cwd, options.remoteUrl);
}

/**
 * The refusals run first because they stop the stage: a push that cannot
 * proceed is not worth reading blobs for, and a report that led with content
 * findings would bury the reason the push was refused.
 */
export async function runPushStage(cwd: string, options: PushStageOptions): Promise<GateOutcome> {
  if (options.remote === '' && options.stdin.trim() !== '') {
    throw new Error('The push stage needs the remote git is pushing to; none was given.');
  }
  const advertised = await destinationHolding(cwd, options);
  if (!advertised.established) {
    // Both halves of this line come from outside and both go through the rule.
    // git passes the *location* as the remote name for `git push <location>
    // <ref>`, so the field that looks like a name carries a path routinely.
    const named = options.remote === '' ? 'the destination' : withoutHostPaths(options.remote);
    const detail = `cannot establish what ${named} already holds: ${withoutHostPaths(advertised.reason)}`;
    return {
      report: `${formatRefusals([{ check: 'destination advertisement', detail }])}\n\n${BYPASS_NOTE}`,
      code: 1,
    };
  }
  const references = resolvePushedRefRanges(options.stdin, false, advertised.objectIds);
  const refusals = await pushRefusals(cwd, options, references);
  if (refusals.length > 0) {
    return { report: `${formatRefusals(refusals)}\n\n${BYPASS_NOTE}`, code: 1 };
  }
  if (references.length === 0) {
    return { report: 'Privacy gate: this push publishes no commits.', code: 0 };
  }
  const text: PrivacyFinding[] = [];
  const binary: BinaryOutcome[] = [];
  const unaccounted: Refusal[] = [];
  for (const { tip, range } of references) {
    const content = await readPushedContent(cwd, range.revisions);
    unaccounted.push(...content.refusals);
    // The tip's own tree is only readable once the enumeration has accounted for
    // everything the ref publishes: a tip that is not a commit has no tree.
    if (content.refusals.length > 0) continue;
    const findings = scanBlobs(content.blobs, await readAllowlistFromTip(cwd, tip));
    text.push(...findings.text);
    binary.push(...findings.binary);
  }
  return outcomeOf({ text, binary }, unaccounted);
}

/* v8 ignore start -- CLI entry point, exercised through the hooks */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const [stage = '', remote = '', remoteUrl = ''] = process.argv.slice(2);
    if (stage !== 'commit' && stage !== 'push') {
      throw new Error('Usage: privacy-gate.ts commit | privacy-gate.ts push <remote> <url>');
    }
    const outcome =
      stage === 'commit'
        ? await runCommitStage(process.cwd())
        : await runPushStage(process.cwd(), {
            stdin: process.stdin.isTTY ? '' : await readStdin(),
            remote,
            remoteUrl,
          });
    console.log(outcome.report);
    return outcome.code;
  });
}
/* v8 ignore stop */
