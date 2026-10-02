import path from 'node:path';
import { execa } from 'execa';
import { CHECKOUT_DIRECTORY, composeArguments } from './compose.js';
import { canonicalPath } from './lib/canonical-path.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { resolveGitCommonDir } from './lib/cli/git-checkout.js';
import { composeProjectName, isComposeProjectOfThisRepo } from './lib/cli/worktree.js';
import { readOwnership, reapPass, unownedFinding } from './lib/claims/ownership.js';
import {
  RECLAIM_BOUNDARY_PHRASE,
  pastReclaimBoundary,
  unreadAgeClause,
} from './lib/claims/resource-age.js';
import { readSlotClaims } from './lib/claims/slot-claim.js';
import type { Ownership } from './lib/claims/ownership.js';
import type { ResourceAge } from './lib/claims/resource-age.js';

export { resolveGitCommonDir } from './lib/cli/git-checkout.js';

export interface DockerComposeProject {
  projectName: string;
  workingDir: string;
  /**
   * The git common directory the bring-up stamped on the project's containers,
   * or nothing where the project carries no stamp. Absent for every project
   * started before the label existed, and for one another tool brought up.
   */
  cloneDir?: string;
}

export interface ProjectOwnership {
  project: DockerComposeProject;
  /**
   * The git common directory this project belongs to — the one its label names,
   * or the one its recorded working directory resolves into. Null when it
   * carries no label and that directory resolves into no repository.
   */
  commonDir: string | null;
}

interface ProjectTriage {
  /** This repository's, held by no live run, and the worktree listing names its directory not — safe to tear down. */
  orphaned: DockerComposeProject[];
  /** Names no clone: no label, and a recorded directory answering no repository — left running. */
  unresolved: DockerComposeProject[];
  /** Belongs to a different clone of this repository — left running. */
  otherClone: DockerComposeProject[];
  /** A live run recorded it against its claim — left running whatever else says. */
  held: DockerComposeProject[];
  /** This repository's, its checkout is live, and nothing accounts for it — reported and left running. */
  unaccounted: DockerComposeProject[];
  /** Reclaimable, but a live run's record could not be read — left running until it can be. */
  blocked: DockerComposeProject[];
}

interface CleanupResult extends ProjectTriage {
  removed: string[];
  containers: ContainerReclaim;
}

interface ContainerReclaim {
  /** Containers this pass removed: the expired ones and the ones the boundary licensed. */
  removed: string[];
  /** Containers whose owning run is gone. */
  expired: string[];
  /** Containers no claim accounts for that have stood past the boundary. */
  reclaimedByAge: string[];
  /** Containers no claim accounts for that stand. Reported and left running. */
  unowned: string[];
}

/** Prefix every container this repository starts carries, compose-managed or not. */
const CONTAINER_PREFIX = 'hushbox-';

/**
 * The label `docker-compose.yml` stamps this clone's git common directory into,
 * on every container of every project it starts.
 *
 * The compose file cannot import this constant, so `compose-file.test.ts` reads
 * the file and asserts the label it stamps is the one read here.
 *
 * The namespace is one token rather than the reverse-DNS `ai.hushbox`, which
 * would put the bare brand word where `compose-literals.test.ts` reads mapping
 * keys as content — and that word is also the default stack's database name, so
 * the plain spelling is reported as a second spelling of it.
 */
export const CLONE_DIR_LABEL = 'hushbox-stack.clone-dir';

/** Which slot a checkout holds, or null when it has never claimed one. */
type SlotOfWorktree = (worktreePath: string) => number | null;

export const COMMAND_LINE = {
  command: 'pnpm docker:cleanup',
  summary:
    'Removes a compose project only when it names this clone — by its own label, or by the ' +
    'repository its recorded directory resolves into — only when no checkout in ' +
    "the worktree listing runs under that directory, and only when every live run's record " +
    'could be read without naming the project. Removes a container no compose project owns ' +
    'only when the run that claimed it has gone, and one no claim names at all only when it ' +
    `has stood the ${RECLAIM_BOUNDARY_PHRASE} such a container is left standing for.`,
  flags: [
    { flag: '--dry-run', kind: 'boolean', summary: 'Report what would go and remove nothing.' },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

export function parseWorktreePaths(output: string): string[] {
  if (!output.trim()) return [];
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

export function parseDockerProjects(output: string): DockerComposeProject[] {
  if (!output.trim()) return [];
  const seen = new Set<string>();
  const projects: DockerComposeProject[] = [];

  for (const line of output.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2 || !parts[0] || !parts[1]) continue;
    const [projectName, workingDir, cloneDir] = parts as [string, string, string | undefined];
    if (!isComposeProjectOfThisRepo(projectName)) continue;
    if (seen.has(projectName)) continue;
    seen.add(projectName);
    // A container carrying no such label answers the empty string, which names
    // no clone; carried through as one it would be a directory the comparison
    // could only ever mismatch, turning every unstamped project into another
    // clone's instead of an unresolved one.
    projects.push({ projectName, workingDir, ...(cloneDir ? { cloneDir } : {}) });
  }

  return projects;
}

/**
 * Normalize a path for cross-platform set membership.
 * Docker may store working_dir with backslashes (Windows native) while
 * git worktree list emits forward slashes on every platform. Drive-letter
 * casing also differs across tools on Windows.
 *
 * The three spellings compared here come from three sources that canonicalise
 * differently — docker records the directory a project was started from, git
 * prints its own worktree list, and the slot registry records its claimer's
 * path — so a checkout reached through a symlink can reach this function under
 * two absolute spellings. Left uncanonicalised, a live checkout's project
 * matches no active worktree and is torn down. Only an absolute path is
 * canonicalised: a Windows spelling reaching a POSIX host resolves to nothing
 * there, and anchoring it to the working directory would be worse than leaving
 * it alone.
 */
function normalizeProjectPath(input: string): string {
  const canonical = path.isAbsolute(input) ? canonicalPath(input) : input;
  const slashNormalized = canonical.replaceAll('\\', '/');
  const driveLetter = slashNormalized.charAt(0);
  if (/^[A-Za-z]:\//.test(slashNormalized)) {
    return driveLetter.toLowerCase() + slashNormalized.slice(1);
  }
  return slashNormalized;
}

/** What one running compose project turned out to be. */
type ProjectVerdict =
  | 'unresolved'
  | 'otherClone'
  | 'held'
  | 'reclaimable'
  | 'unaccounted'
  | 'current';

/** Everything a verdict is decided against, read once for the whole pass. */
interface TriageWorld {
  /** Every checkout `git worktree list` names, in the comparable spelling. */
  readonly activeCheckouts: ReadonlySet<string>;
  /** This clone's git common directory, in the comparable spelling. */
  readonly repoDir: string;
  readonly slotOfWorktree: SlotOfWorktree;
  readonly ownership: Ownership;
}

/**
 * Which of six things one running compose project is, in the order the
 * questions have to be asked.
 *
 * Two worktrees of one clone share a git common directory; a different clone of
 * the same repository has its own. Comparing common directories is what keeps a
 * sibling clone's stack — absent from this clone's worktree list, and formerly
 * indistinguishable from an orphan — out of the reap set.
 *
 * Inside this clone the claim is asked first and it only ever spares: a project
 * a live run recorded is one a command is working against right now, and no
 * other evidence may overrule that. What licenses a teardown is git's own
 * record — the recorded directory is no checkout `git worktree list` names, so
 * no run under that directory can ever exist again. That is the same evidence
 * the slot registry reissues a slot on.
 *
 * A project whose checkout is still there and which that checkout no longer runs
 * under — one left by the scheme that derived a slot from a hash of the
 * checkout's name, or one stranded by a re-issued slot — is *unaccounted*:
 * reported and left standing. Ending one used to be this decision's job, and a
 * slot registry that had been lost and re-issued was enough to point it at
 * another checkout's live stack. Nothing here can tell that apart from genuine
 * debris, so the human is told instead.
 *
 * WHAT THE WORKTREE QUESTION REACHES DEPENDS ON THE STAMP. Asking it at all
 * needs a common directory. A project carrying a label has one however dead its
 * directory is; a project carrying none gets one only by running git inside the
 * recorded directory, so a checkout deleted along with its directory answers
 * nothing and stops at *unresolved*, two lines above. Nothing stamps a label on
 * a project already running, so every project started before the label existed
 * is in that second set forever.
 */
function verdictFor(found: ProjectOwnership, world: TriageWorld): ProjectVerdict {
  const { project, commonDir } = found;
  if (commonDir === null) return 'unresolved';
  if (normalizeProjectPath(commonDir) !== world.repoDir) return 'otherClone';
  if (world.ownership.stateOfResource('compose-project', project.projectName) === 'owned-live') {
    return 'held';
  }
  if (!world.activeCheckouts.has(normalizeProjectPath(project.workingDir))) return 'reclaimable';
  const slot = world.slotOfWorktree(project.workingDir);
  const abandoned = slot !== null && project.projectName !== composeProjectName(slot);
  return abandoned ? 'unaccounted' : 'current';
}

/**
 * Which clone one running compose project belongs to: the one its own label
 * names, or — where it carries none — the one its recorded working directory
 * still resolves into.
 *
 * The label is the only account of this that survives the checkout. A directory
 * that has been deleted resolves to nothing, and from that answer alone "this
 * belongs to another clone" and "this directory is gone" are the same, so a
 * project whose checkout went away is spared forever. Reading the label first
 * only ever adds an answer: one naming a different clone fails the comparison
 * exactly as a resolved sibling's directory does, and a project carrying none is
 * placed exactly as every project was before the label existed.
 */
export async function ownershipOf(
  project: DockerComposeProject,
  resolveCommonDir: (directory: string) => Promise<string | null>
): Promise<ProjectOwnership> {
  return {
    project,
    commonDir: project.cloneDir ?? (await resolveCommonDir(project.workingDir)),
  };
}

export interface ProjectTriageRequest {
  readonly ownerships: readonly ProjectOwnership[];
  readonly activeWorktreePaths: readonly string[];
  readonly repoCommonDir: string;
  readonly slotOfWorktree: SlotOfWorktree;
  readonly ownership: Ownership;
}

/** Every running compose project sorted into what may be done about it. */
export function triageProjects(request: ProjectTriageRequest): ProjectTriage {
  const world: TriageWorld = {
    activeCheckouts: new Set(request.activeWorktreePaths.map((p) => normalizeProjectPath(p))),
    repoDir: normalizeProjectPath(request.repoCommonDir),
    slotOfWorktree: request.slotOfWorktree,
    ownership: request.ownership,
  };
  const sorted: Record<ProjectVerdict, DockerComposeProject[]> = {
    unresolved: [],
    otherClone: [],
    held: [],
    reclaimable: [],
    unaccounted: [],
    current: [],
  };

  for (const found of request.ownerships) sorted[verdictFor(found, world)].push(found.project);

  // A live run whose record could not be read named no project, so every
  // project of this clone is one it may be using. Nothing is torn down until
  // that record can be read or its run is gone; the next pass reclaims what
  // this one left. A project the checkout is currently running under is in
  // `current` and is reported nowhere — that is the ordinary state of a stack.
  const unreadable = request.ownership.unreadLiveRuns.length > 0;
  return {
    orphaned: unreadable ? [] : sorted.reclaimable,
    unresolved: sorted.unresolved,
    otherClone: sorted.otherClone,
    held: sorted.held,
    unaccounted: sorted.unaccounted,
    blocked: unreadable ? sorted.reclaimable : [],
  };
}

/** Answers which slot each checkout holds, from the machine-wide slot registry. */
export function slotLookup(slotRegistryDir?: string): SlotOfWorktree {
  const claims = [...readSlotClaims(slotRegistryDir)];
  return (worktreePath) => {
    const target = normalizeProjectPath(worktreePath);
    const found = claims.find(([, record]) => normalizeProjectPath(record.worktreePath) === target);
    return found === undefined ? null : found[0];
  };
}

export async function getActiveWorktreePaths(): Promise<string[]> {
  const result = await execa('git', ['worktree', 'list', '--porcelain']);
  return parseWorktreePaths(result.stdout);
}

export async function getRunningDockerProjects(): Promise<DockerComposeProject[]> {
  try {
    const result = await execa('docker', [
      'ps',
      '--filter',
      'label=com.docker.compose.project',
      '--format',
      `{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "${CLONE_DIR_LABEL}"}}`,
    ]);
    return parseDockerProjects(result.stdout);
  } catch (error: unknown) {
    throw new Error('docker-cleanup: could not list running Docker Compose projects', {
      cause: error,
    });
  }
}

/** A container no compose project owns, and what the listing said about its age. */
export interface UnmanagedContainer {
  readonly name: string;
  /**
   * Docker's own rendering of when the container was created, or the empty
   * string where the listing carried none.
   *
   * WHEN IT WAS CREATED, NEVER WHEN IT STARTED. A container that was created
   * and never started has no running time of any kind, and one of those is
   * precisely what stands longest; read for a start time it would be
   * unreadable for ever, and nothing would ever reclaim it.
   */
  readonly createdAt: string;
}

/**
 * Containers from a listing of `<name>TAB<compose project>TAB<creation time>`,
 * keeping only the ones no compose project owns. Those are the containers
 * started by a direct `docker run` — the Android emulators today — which
 * `docker compose down` cannot reach, so nothing but a name collision with the
 * next run of the same shard has ever reclaimed one.
 */
export function parseUnmanagedContainers(output: string): UnmanagedContainer[] {
  if (!output.trim()) return [];
  const found: UnmanagedContainer[] = [];
  for (const line of output.split('\n')) {
    const [name, composeProject, createdAt] = line.split('\t');
    if (name === undefined || name === '') continue;
    if (composeProject !== undefined && composeProject.trim() !== '') continue;
    found.push({ name, createdAt: createdAt?.trim() ?? '' });
  }
  return found;
}

/**
 * The shape docker prints a creation time in: a date, a time, and the offset
 * that places them, followed by the name of the zone they add up to. The name
 * is read past — the offset is what makes the instant unambiguous, and a zone
 * name is not something to resolve here.
 */
const DOCKER_CREATED_AT =
  /^(?<date>\d{4}-\d{2}-\d{2})[ T](?<time>\d{2}:\d{2}:\d{2})(?:\.\d+)?\s*(?<offset>[+-]\d{2}):?(?<offsetMinutes>\d{2})/;

/**
 * How long a container has stood, from the creation time the listing carried
 * for it, or why that could not be established.
 *
 * The creation stamp comes from the daemon's clock, and the `now` it is
 * subtracted from comes from this pass's; nothing here establishes that the
 * two are one clock. The two directions a difference can take are not
 * symmetric: a daemon clock behind this one makes a container look older than
 * it is, which is the direction that reclaims one early, while a daemon clock
 * ahead of it can never make one look older; the subtraction comes out short
 * by the skew, and where the skew outruns the container's own age it comes out
 * negative, which is answered as unread rather than as an age. The only
 * reading this may act on is one it can stand behind.
 */
export function containerAge(createdAt: string, now: number): ResourceAge {
  if (createdAt === '') {
    return { kind: 'unreadable', reason: 'the listing carried no creation time for it' };
  }
  const found = DOCKER_CREATED_AT.exec(createdAt)?.groups;
  if (found === undefined) {
    return { kind: 'unreadable', reason: 'what docker printed is not a creation time' };
  }
  const created = Date.parse(
    `${String(found['date'])}T${String(found['time'])}${String(found['offset'])}:${String(found['offsetMinutes'])}`
  );
  const elapsedMs = now - created;
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return { kind: 'unreadable', reason: 'docker dates it later than this machine says it is' };
  }
  return { kind: 'known', elapsedMs };
}

/**
 * Every container under our prefix no compose project owns, stopped ones
 * included: an exited container still holds its name and its writable layer, so
 * leaving it out would put half of every emulator's afterlife beyond
 * reclamation.
 */
export async function listUnmanagedContainers(): Promise<UnmanagedContainer[]> {
  try {
    const result = await execa('docker', [
      'ps',
      '-a',
      '--filter',
      `name=${CONTAINER_PREFIX}`,
      '--format',
      '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.CreatedAt}}',
    ]);
    return parseUnmanagedContainers(result.stdout);
  } catch (error: unknown) {
    throw new Error('docker-cleanup: could not list containers', { cause: error });
  }
}

/** A container carrying this clone's label, and the state docker has it in. */
export interface LabelledContainer {
  readonly name: string;
  /** Docker's own word for it: `created`, `exited`, `paused` and the rest. */
  readonly state: string;
}

/**
 * Container names and states from a listing of `<name>TAB<state>`, keeping the
 * ones docker is not running.
 *
 * A container of a compose project is left out of {@link parseUnmanagedContainers}
 * by construction — that filter keeps only the containers no project owns — so
 * one a project owns and nothing ever started is in no reading anywhere. That
 * is the shape this listing exists to end: it names them, and naming is the
 * whole of what it does.
 */
export function parseStuckContainers(output: string): LabelledContainer[] {
  if (!output.trim()) return [];
  const found: LabelledContainer[] = [];
  for (const line of output.split('\n')) {
    const [name, state] = line.split('\t');
    if (name === undefined || name === '') continue;
    if (state === undefined || state === '' || state === 'running') continue;
    found.push({ name, state });
  }
  return found;
}

/**
 * Every container of this clone docker is not running, whichever compose
 * project owns it.
 *
 * The label is what selects them, because it is the one thing every container
 * of every project this clone starts carries and nothing else on the machine
 * does. Nothing here removes one: a container a project owns is the project's
 * to take down, and what this answers is a report.
 */
export async function getStuckContainers(): Promise<LabelledContainer[]> {
  try {
    const result = await execa('docker', [
      'ps',
      '-a',
      '--filter',
      `label=${CLONE_DIR_LABEL}`,
      '--format',
      '{{.Names}}\t{{.State}}',
    ]);
    return parseStuckContainers(result.stdout);
  } catch (error: unknown) {
    throw new Error('docker-cleanup: could not list containers', { cause: error });
  }
}

async function removeContainer(name: string): Promise<void> {
  await execa('docker', ['rm', '-f', name], { stdio: 'inherit' });
}

/** The line saying the boundary, and not any claim, is what licensed a removal. */
function describeReclaimedByAge(name: string): string {
  return (
    `container ${name} — no claim accounts for it and it has stood longer than the ` +
    `${RECLAIM_BOUNDARY_PHRASE} such a resource is left standing for, so this pass takes it`
  );
}

/** A container nothing accounts for, and how long it turned out to have stood. */
interface UnownedContainer {
  readonly name: string;
  readonly age: ResourceAge;
}

/** The line naming a container left standing, and the repair for it. */
function describeUnowned(found: UnownedContainer, finding: string): string {
  // The age is said only where the question was put and went unanswered: a
  // line leaving it out reads as a container this pass established to be
  // young, which is the one thing it would then never come back and reclaim.
  const unread = found.age.kind === 'unreadable' ? ` ${unreadAgeClause(found.age.reason)}.` : '';
  return (
    `container ${found.name} is ${finding}. Classify everything with ` +
    `\`pnpm dev:clean --dry-run\`.${unread}`
  );
}

interface ContainerTriage {
  readonly expired: string[];
  readonly reclaimedByAge: string[];
  readonly unowned: UnownedContainer[];
}

/**
 * Which of four things each listed container is: its run's, its dead run's, one
 * nothing accounts for that the boundary has released, or one that stands.
 *
 * The age is asked only of the containers no claim accounts for, and it decides
 * nothing about whether anything is alive: ownership has already answered that,
 * and what an age answers is how long something nothing accounts for is left
 * before the next pass takes it.
 *
 * WHAT THE TWO FAILURES COST IS NOT THE SAME. Leaving a container standing
 * leaves clutter the next pass sees again; taking one early destroys work
 * somebody is doing on a machine every checkout and every run shares. So every
 * reading that is not an established age past the boundary leaves the container
 * where it is — an age nothing could read, and a live run whose record could
 * not be read, which may be the very claim naming this one.
 */
function triageContainers(
  present: readonly UnmanagedContainer[],
  ownership: Ownership,
  now: number
): ContainerTriage {
  const attributable = ownership.unreadLiveRuns.length === 0;
  const expired: string[] = [];
  const reclaimedByAge: string[] = [];
  const unowned: UnownedContainer[] = [];

  for (const { name, createdAt } of present) {
    const state = ownership.stateOfResource('container', name);
    if (state === 'owned-expired') expired.push(name);
    else if (state === 'unowned') {
      const age = containerAge(createdAt, now);
      if (attributable && pastReclaimBoundary(age)) reclaimedByAge.push(name);
      else unowned.push({ name, age });
    }
  }

  return { expired, reclaimedByAge, unowned };
}

/**
 * Reclaims the containers started outside a compose project, by the claim of
 * the run that started each. A container whose run still holds its claim is
 * left alone; one whose run is gone is removed; one no claim names at all is
 * removed once it has stood past the boundary {@link triageContainers} reads it
 * against, and until then reported and left standing.
 */
export async function reclaimUnmanagedContainers(options: {
  dryRun: boolean;
  registryDir?: string | undefined;
}): Promise<ContainerReclaim> {
  const present = await listUnmanagedContainers();
  const ownership = await readOwnership(options.registryDir);
  const { expired, reclaimedByAge, unowned } = triageContainers(present, ownership, Date.now());

  for (const name of reclaimedByAge) console.log(describeReclaimedByAge(name));
  const finding = unownedFinding(ownership);
  for (const found of unowned) console.warn(describeUnowned(found, finding));

  const removed: string[] = [];
  for (const name of [...expired, ...reclaimedByAge]) {
    if (options.dryRun) {
      console.log(`Would remove ${name}.`);
      continue;
    }
    console.log(`Removing ${name}...`);
    await removeContainer(name);
    removed.push(name);
  }

  return { removed, expired, reclaimedByAge, unowned: unowned.map((found) => found.name) };
}

export async function removeProject(projectName: string): Promise<void> {
  await execa('docker', composeArguments(CHECKOUT_DIRECTORY, ['-p', projectName, 'down']), {
    stdio: 'inherit',
  });
}

/** Nothing found, nothing classified, nothing removed. */
function nothingToReclaim(containers: ContainerReclaim): CleanupResult {
  return {
    orphaned: [],
    unresolved: [],
    otherClone: [],
    held: [],
    unaccounted: [],
    blocked: [],
    removed: [],
    containers,
  };
}

/** Says out loud what was left standing, and what a human would have to do to end it. */
function reportSpared(triage: ProjectTriage, unreadRuns: readonly string[]): void {
  for (const p of triage.unresolved) {
    console.warn(
      `Leaving ${p.projectName} running — it carries no label naming its clone and git could ` +
        `not resolve ${p.workingDir}, so nothing here knows which repository that project ` +
        'belongs to: the directory may have been deleted along with its checkout, or may never ' +
        'have been a checkout of this one. A directory that is gone is no evidence the stack it ' +
        'started is dead, and nothing stamps a label on a project already running. End it with ' +
        `\`docker compose -p ${p.projectName} down\` once you have established that nothing is ` +
        'using it.'
    );
  }
  for (const p of triage.otherClone) {
    console.warn(
      `Leaving ${p.projectName} running — ` +
        (p.cloneDir === undefined
          ? `${p.workingDir} resolves into a different clone of this repository`
          : 'it carries the label of a different clone of this repository') +
        ", whose stacks are not this checkout's to end"
    );
  }
  for (const p of triage.unaccounted) {
    console.warn(
      `Leaving ${p.projectName} running — ${p.workingDir} is still a checkout of this ` +
        'repository and now runs a different project, so nothing reclaims this one and nothing ' +
        `here can tell it from a stack in use. End it with \`docker compose -p ${p.projectName} ` +
        'down` once you have established that nothing is using it.'
    );
  }
  for (const p of triage.blocked) {
    console.warn(
      `Leaving ${p.projectName} running — the record of live run ${unreadRuns.join(', ')} could ` +
        'not be read, so it counts as a run that may own anything and no compose project is ' +
        'torn down on its behalf. Remove the run directory by hand once you have established ' +
        'that no run is using it.'
    );
  }
}

export async function cleanupOrphanedProjects(options: {
  dryRun: boolean;
  slotRegistryDir?: string | undefined;
  registryDir?: string | undefined;
}): Promise<CleanupResult> {
  const [activePaths, repoCommonDir] = await Promise.all([
    getActiveWorktreePaths(),
    resolveGitCommonDir(process.cwd()),
  ]);
  if (repoCommonDir === null) {
    throw new Error(`docker-cleanup: ${process.cwd()} is not inside a git repository`);
  }

  const containers = await reclaimUnmanagedContainers({
    dryRun: options.dryRun,
    registryDir: options.registryDir,
  });

  // Every project the pass has seen, so the classification runs over the same
  // listing the pass settled on rather than a fresh one.
  const listed = new Map<string, DockerComposeProject>();
  const classified = await reapPass({
    what: 'compose projects',
    registryDir: options.registryDir,
    scan: async () => {
      const projects = await getRunningDockerProjects();
      for (const project of projects) listed.set(project.projectName, project);
      return projects.map((project) => project.projectName);
    },
    reap: async (present, ownership) => {
      const ownerships = await Promise.all(
        present
          .map((name) => listed.get(name))
          .filter((project) => project !== undefined)
          .map((project) => ownershipOf(project, resolveGitCommonDir))
      );
      return {
        triage: triageProjects({
          ownerships,
          activeWorktreePaths: activePaths,
          repoCommonDir,
          slotOfWorktree: slotLookup(options.slotRegistryDir),
          ownership,
        }),
        unreadRuns: ownership.unreadLiveRuns.map((run) => run.runId),
      };
    },
  });

  if (classified === undefined) return nothingToReclaim(containers);
  const { triage, unreadRuns } = classified;
  const removed: string[] = [];

  reportSpared(triage, unreadRuns);

  if (triage.orphaned.length === 0) return { ...triage, removed, containers };

  console.log(`Found ${String(triage.orphaned.length)} orphaned Docker compose project(s):`);
  for (const p of triage.orphaned) {
    console.log(`  ${p.projectName} → ${p.workingDir}`);
  }

  if (options.dryRun) {
    console.log('Dry run — no containers removed.');
    return { ...triage, removed, containers };
  }

  const failures: { projectName: string; error: unknown }[] = [];
  for (const p of triage.orphaned) {
    try {
      console.log(`Removing ${p.projectName}...`);
      await removeProject(p.projectName);
      removed.push(p.projectName);
    } catch (error: unknown) {
      failures.push({ projectName: p.projectName, error });
    }
  }

  if (failures.length > 0) {
    // Every orphan is attempted before this throws, so one wedged project does
    // not hide the others; the failure itself is never downgraded to a warning.
    throw new Error(
      `docker-cleanup: failed to remove ${failures.map((f) => f.projectName).join(', ')}`,
      { cause: failures[0]?.error }
    );
  }

  console.log(`Cleanup complete: ${String(removed.length)} removed`);
  return { ...triage, removed, containers };
}

export async function main(): Promise<void> {
  const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));
  if (parsed === null) return;
  await cleanupOrphanedProjects({ dryRun: parsed.flags['--dry-run'] });
}

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
const isMain = isMainModule(import.meta.url);
if (isMain) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      console.error('Docker cleanup failed:', error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
