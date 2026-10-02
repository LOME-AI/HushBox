/**
 * The browser matrix: which projects a spec runs on, derived from what the spec
 * DECLARES rather than from a tag naming a browser.
 *
 * Two orthogonal axes, both mandatory:
 *  - engine — `engine-matrix` (the behaviour can break per rendering engine, so
 *    run every engine), `engine-any` (it cannot, so one engine proves it), or
 *    `engine-pinned` (only the named engine can run it, so it is never handed to
 *    another: a run that would otherwise drop it refuses instead), or
 *    `engine-fixed` (the enclosing plane fixes the engine, so the spec claims
 *    nothing about engine independence and elects no carrier).
 *  - form factor — `desktop` / `mobile` / `either`.
 *
 * `engine-any` does NOT mean "chromium". It means "exactly one project, chosen
 * from those the RUN comprises, matching the spec's form factor". That is the
 * whole point: a browser-named tag with a static per-project `grepInvert` makes
 * the spec unreachable whenever the named project is not in the run, which
 * silently deletes coverage from every narrowed invocation. A carrier chosen
 * from the run cannot do that — narrowing the run moves the spec, it never
 * drops it.
 *
 * A run is not always a process: CI splits one run across one single-project
 * process per project, which is why the run is declared to each of them rather
 * than read off argv (see {@link resolveRunProjects}).
 *
 * The carrier is a fixed preference order intersected with the run, so a given
 * run always resolves to the same project — the routing is reproducible, not
 * "whichever project happened to be first".
 *
 * The project names themselves live in `projects.ts`; the two axes are
 * derived from each project's declared role there.
 */

import {
  BROWSER_MATRIX_PROJECTS,
  DESKTOP_PROJECTS,
  E2E_PROJECTS,
  MOBILE_PROJECTS,
} from './projects.js';

type FormFactor = 'desktop' | 'mobile' | 'either';

/** The browser binaries the registry runs projects on. */
type ProjectEngine = (typeof E2E_PROJECTS)[number]['browser'];

const PROJECT_ENGINE = new Map<string, ProjectEngine>(
  E2E_PROJECTS.map((project) => [project.name, project.browser])
);

/** An engine some spec pins, and the form factor it pins it for. */
interface PinnedEngineWork {
  readonly pinnedEngine: ProjectEngine;
  readonly formFactor: FormFactor;
}

/**
 * The pinned work the suite actually contains — the ONE statement of it.
 *
 * A pinned declaration's engine and form factor are typed against these entries,
 * so a spec cannot pin an engine the run-refusal below does not know to demand:
 * the two would have to disagree for a pinned spec to be silently dropped, and
 * the compiler will not let them. Entries earn their place from a constraint
 * (a harness capability the other engines lack, or an infrastructure singleton),
 * never from a preference.
 */
const PINNED_WORK = [
  { pinnedEngine: 'chromium', formFactor: 'desktop' },
] as const satisfies readonly PinnedEngineWork[];

/**
 * A spec's declaration. `engine-any` and `engine-pinned` both require a reason:
 * "this behaviour cannot break per engine" and "only this engine can run it" are
 * both judgements, and an unexplained judgement is indistinguishable from a
 * paste.
 *
 * `engine-fixed` carries none, and the asymmetry is the point: it states no
 * judgement about the behaviour at all, only that the enclosing plane fixes the
 * engine — which the project registry already says. A per-spec sentence
 * restating a registry fact is the paste the reason bar exists to catch.
 *
 * The reason is a parameter so {@link matrix} can refuse a blank one; every
 * other reference wants the default.
 *
 * `rules-citations.test.mjs` resolves the citations in `e2e/CLAUDE.md` by
 * matching the `export` keyword in this file's text, never by importing it.
 */
export type MatrixDeclaration<Reason extends string = string> =
  | { readonly engine: 'engine-matrix'; readonly formFactor: FormFactor }
  | { readonly engine: 'engine-any'; readonly formFactor: FormFactor; readonly reason: Reason }
  | ({ readonly engine: 'engine-pinned'; readonly reason: Reason } & (typeof PINNED_WORK)[number])
  | {
      readonly engine: 'engine-fixed';
      readonly formFactor: FormFactor;
      /**
       * Declared as `never` rather than omitted: excess-property checking against
       * a union admits any property some other member declares, so leaving it out
       * would let a `reason` through on this arm — the one thing it must refuse.
       */
      readonly reason?: never;
    };

type Whitespace = ' ' | '\t' | '\n' | '\r';

/** `Reason` with its outer whitespace removed, so a blank one reduces to `''`. */
type Trimmed<Reason extends string> = Reason extends `${Whitespace}${infer Rest}`
  ? Trimmed<Rest>
  : Reason extends `${infer Rest}${Whitespace}`
    ? Trimmed<Rest>
    : Reason;

/**
 * Retypes `reason` as `never` when the declared one says nothing, so an empty or
 * whitespace-only string is refused where the field's own `string` type admits
 * it. A required field satisfied by `''` is a required field in form only, and
 * rule 4.6 is about the judgement the reason states.
 */
type RejectsBlankReason<Reason extends string> =
  Trimmed<Reason> extends '' ? { readonly reason: never } : unknown;

/** Playwright `describe`/`test` options carrying a declaration. */
interface MatrixOptions {
  readonly tag: string[];
  readonly annotation?: { type: string; description: string }[];
}

/**
 * Turns a declaration into Playwright options.
 *
 * The engine-any routing tag embeds the form factor (`@engine-any-desktop`)
 * rather than pairing a bare `@engine-any` with a separate form-factor tag,
 * because project filtering matches ONE regex against the composed title: a
 * two-tag conjunction would have to assume the order Playwright joins tags in.
 * One tag per routing decision keeps the matching order-independent.
 *
 * The pinned tag embeds the ENGINE for the same reason and no form factor: a
 * pin elects no carrier, so its only routing decision is which engine, and the
 * form-factor tag beside it makes the other one.
 */
export function matrix<Reason extends string = string>(
  declaration: MatrixDeclaration<Reason> & RejectsBlankReason<Reason>
): MatrixOptions {
  return optionsFor(declaration);
}

function optionsFor(declaration: MatrixDeclaration): MatrixOptions {
  const formFactorTag = `@${declaration.formFactor}`;
  if (declaration.engine === 'engine-matrix') {
    return { tag: ['@engine-matrix', formFactorTag] };
  }
  // Routing-inert by construction, and deliberately so: a plane's spec set is
  // fixed by its testDir, and the engine projects never collect these files. The
  // tag exists to be greppable and to keep one tag per declaration, not to
  // route — which is why it names no form-factor bucket the way engine-any does.
  if (declaration.engine === 'engine-fixed') {
    return { tag: ['@engine-fixed', formFactorTag] };
  }
  if (declaration.engine === 'engine-pinned') {
    return {
      tag: [`@engine-pinned-${declaration.pinnedEngine}`, formFactorTag],
      annotation: [{ type: 'engine-pinned', description: declaration.reason }],
    };
  }
  return {
    tag: [`@engine-any-${declaration.formFactor}`, formFactorTag],
    annotation: [{ type: 'engine-any', description: declaration.reason }],
  };
}

/** Glob metacharacters Playwright accepts in `--project` but this derivation will not guess at. */
const GLOB_CHARACTERS = /[*?[\]{}]/;

const PROJECT_FLAG = '--project';

/**
 * commander's own `maybeOption` test: a token longer than one character that
 * starts with `-` ends variadic consumption.
 */
function maybeOption(argument: string): boolean {
  return argument.length > 1 && argument.startsWith('-');
}

/** Every consecutive non-flag token from `start`, which is what a variadic option eats. */
function collectVariadicValues(argv: readonly string[], start: number): string[] {
  const values: string[] = [];
  for (let offset = start; offset < argv.length; offset += 1) {
    const next = argv[offset];
    if (next === undefined || maybeOption(next)) break;
    values.push(next);
  }
  return values;
}

/**
 * Reads the `--project` values at `index`, if there are any there.
 *
 * Playwright declares the option variadic (`--project <project-name...>`), and
 * commander's two spellings differ: the space-separated form keeps eating bare
 * tokens until the next flag, while the `=` form emits one value and stops — a
 * following operand there is a test-path filter, not a project. Mirroring that
 * split exactly is what keeps this parser from under-selecting, which would put
 * projects in the run that the carrier derivation never saw.
 *
 * Returns how many argv entries were consumed so the caller advances correctly.
 */
function readProjectValues(
  argv: readonly string[],
  index: number
): { values: string[]; consumed: number } {
  const argument = argv[index];
  if (argument === undefined) return { values: [], consumed: 1 };

  if (argument === PROJECT_FLAG) {
    const values = collectVariadicValues(argv, index + 1);
    if (values.length === 0) {
      throw new Error(
        `${PROJECT_FLAG} was given no value. Name a project explicitly, e.g. ${PROJECT_FLAG}=chromium.`
      );
    }
    return { values, consumed: values.length + 1 };
  }

  if (argument.startsWith(`${PROJECT_FLAG}=`)) {
    const value = argument.slice(PROJECT_FLAG.length + 1);
    if (value === '') {
      throw new Error(
        `${PROJECT_FLAG}= was given an empty value. Name a project explicitly, e.g. ${PROJECT_FLAG}=chromium.`
      );
    }
    return { values: [value], consumed: 1 };
  }

  return { values: [], consumed: 1 };
}

/** Rejects anything this derivation would have to guess at. */
function assertRoutableProject(value: string, knownProjects: readonly string[]): void {
  if (GLOB_CHARACTERS.test(value)) {
    throw new Error(
      `${PROJECT_FLAG}="${value}" uses a glob. The browser matrix derives which project carries ` +
        `each engine-any spec from the exact selection, and will not guess at a pattern. ` +
        `Name the projects explicitly: ${knownProjects.join(', ')}.`
    );
  }
  if (!knownProjects.includes(value)) {
    throw new Error(
      `${PROJECT_FLAG}="${value}" is not a project this config defines. ` +
        `Known projects: ${knownProjects.join(', ')}.`
    );
  }
}

/**
 * The projects the invocation selected, read off argv.
 *
 * argv is the only channel: Playwright filters the project list AFTER this
 * config module has been evaluated, and exposes the selection to it nowhere.
 * Reading process state here is already how the config learns `CI` and the
 * per-worktree ports.
 *
 * Every form this parser does not fully understand throws. A silent fallback to
 * "all projects" would recreate the very bug this module removes — coverage
 * quietly differing from what the invocation asked for — and falling back to
 * none would be worse. Failing at config load costs one clear error message.
 */
export function resolveSelectedProjects(
  argv: readonly string[],
  knownProjects: readonly string[]
): readonly string[] {
  const selected: string[] = [];

  let index = 0;
  while (index < argv.length) {
    const { values, consumed } = readProjectValues(argv, index);
    index += consumed;
    for (const value of values) {
      assertRoutableProject(value, knownProjects);
      selected.push(value);
    }
  }

  return selected.length > 0 ? selected : knownProjects;
}

/**
 * The variable naming the projects the whole run comprises.
 *
 * CI issues one single-project process per matrix job, so a process cannot see
 * its run from its own argv. Without this, every job elects itself carrier and
 * an `engine-any` spec runs once per job instead of once per run.
 */
export const RUN_PROJECTS_VARIABLE = 'E2E_RUN_PROJECTS';

const RUN_PROJECTS_SEPARATOR = ',';

/** Writes a run set for {@link RUN_PROJECTS_VARIABLE} to carry. */
export function formatRunProjects(projects: readonly string[]): string {
  return projects.join(RUN_PROJECTS_SEPARATOR);
}

interface RunProjectsQuery {
  readonly argv: readonly string[];
  /** The raw {@link RUN_PROJECTS_VARIABLE} value, absent for a run of one process. */
  readonly runSet: string | undefined;
  readonly knownProjects: readonly string[];
  readonly isCI: boolean;
}

/**
 * The projects the run comprises, which is what carrier election reads.
 *
 * With no run set declared the process is the whole run, which is every local
 * invocation. A declared run set must cover what this process runs, or the two
 * statements disagree and the routing derived from either one is wrong.
 */
export function resolveRunProjects({
  argv,
  runSet,
  knownProjects,
  isCI,
}: RunProjectsQuery): readonly string[] {
  const selected = resolveSelectedProjects(argv, knownProjects);

  if (runSet === undefined || runSet.trim() === '') {
    // A narrowed CI process is one job of a wider run it cannot see. Electing
    // carriers from its own selection is what ran engine-any work once per job.
    if (isCI && knownProjects.some((project) => !selected.includes(project))) {
      throw new Error(
        `${RUN_PROJECTS_VARIABLE} must name the projects the run comprises: ` +
          `this process runs only ${selected.join(', ')} and cannot elect carriers for the rest.`
      );
    }
    return selected;
  }

  const run = runSet
    .split(RUN_PROJECTS_SEPARATOR)
    .map((project) => project.trim())
    .filter((project) => project !== '');

  for (const project of run) {
    if (!knownProjects.includes(project)) {
      throw new Error(
        `${RUN_PROJECTS_VARIABLE} names ${project}, which the config does not define. ` +
          `Known projects: ${knownProjects.join(', ')}`
      );
    }
  }

  for (const project of selected) {
    if (!run.includes(project)) {
      throw new Error(
        `${RUN_PROJECTS_VARIABLE} does not include ${project}, which this process runs.`
      );
    }
  }

  return run;
}

/** The single project carrying each bucket of `engine-any` work for a run. */
interface Carriers {
  readonly desktop: string | undefined;
  readonly mobile: string | undefined;
  readonly either: string | undefined;
}

/**
 * Resolves the carrier for each bucket against the projects a run comprises.
 *
 * `either` collapses to one project across BOTH form factors — an engine-any
 * spec that runs on any form factor still needs proving exactly once — and
 * prefers desktop only because desktop projects are the cheaper ones to run.
 */
export function resolveCarriers(run: readonly string[]): Carriers {
  const firstInRun = (preference: readonly string[]): string | undefined =>
    preference.find((project) => run.includes(project));

  const desktop = firstInRun(DESKTOP_PROJECTS);
  const mobile = firstInRun(MOBILE_PROJECTS);
  return { desktop, mobile, either: desktop ?? mobile };
}

const isDesktopProject = (project: string): boolean =>
  (DESKTOP_PROJECTS as readonly string[]).includes(project);

const isMobileProject = (project: string): boolean =>
  (MOBILE_PROJECTS as readonly string[]).includes(project);

/**
 * Whether a project runs specs of a form factor, read off the one exclusion the
 * routing below already applies — so hosting and routing cannot disagree.
 */
const runsFormFactor = (project: string, formFactor: FormFactor): boolean =>
  !formFactorExclusion(project).test(`@${formFactor}`);

const formFactorExclusion = (project: string): RegExp =>
  isDesktopProject(project) ? /@mobile\b/ : /@desktop\b/;

/**
 * Refuses a run that would drop pinned work instead of running it.
 *
 * A pin is never substituted, so the only honest answers are "a project in this
 * run carries it" and "this run refuses". Silence is what the declared matrix
 * exists to remove. A run that comprises no project of the pinned form factor at
 * all is not a drop — the form-factor axis excluded that work for every project
 * in it, exactly as it does for `engine-matrix` and `engine-any`.
 *
 * The pinned set is a parameter rather than a closure over {@link PINNED_WORK}
 * so the refusal stays a pure function of (run, pins).
 */
export function assertPinnedWorkRunnable(
  run: readonly string[],
  pinnedWork: readonly PinnedEngineWork[]
): void {
  // Planes take a fixed testDir and are routed across neither axis, so they can
  // never carry pinned work however the selection names them.
  const routed = run.filter((project) => isDesktopProject(project) || isMobileProject(project));

  for (const { pinnedEngine, formFactor } of pinnedWork) {
    const hosts = routed.filter((project) => runsFormFactor(project, formFactor));
    if (hosts.length === 0) continue;
    if (hosts.some((project) => PROJECT_ENGINE.get(project) === pinnedEngine)) continue;

    const candidates = BROWSER_MATRIX_PROJECTS.filter(
      (project) =>
        runsFormFactor(project, formFactor) && PROJECT_ENGINE.get(project) === pinnedEngine
    );
    throw new Error(
      `This run cannot carry engine-pinned ${pinnedEngine} work: it comprises ` +
        `${run.join(', ')}, and no ${formFactor} project in it runs ${pinnedEngine}. ` +
        `A pinned spec is never handed to an engine that cannot run it, so the run ` +
        `refuses rather than losing it. Add one of: ${candidates.join(', ')}.`
    );
  }
}

/**
 * Tag patterns a project must NOT run, given the projects the run comprises.
 *
 * Anchoring on `@` plus a word boundary is what keeps the two axes disjoint:
 * `/@desktop\b/` does not match `@engine-any-desktop` (the character before
 * `desktop` there is `-`, not `@`), so a routing tag never satisfies a
 * form-factor exclusion or the reverse.
 *
 * A spec carrying no declaration matches nothing here and therefore runs
 * wherever its directory already put it. That default is deliberate and it is
 * the max-coverage direction: an undeclared spec is over-run, never skipped.
 * Forgetting to declare is caught by lint, not by silently losing a project.
 */
export function computeProjectGrepInvert(project: string, run: readonly string[]): RegExp[] {
  // Every project's routing is computed from the same run, so refusing here
  // refuses the whole invocation before a single spec is collected.
  assertPinnedWorkRunnable(run, PINNED_WORK);

  if (!isDesktopProject(project) && !isMobileProject(project)) return [];

  const patterns = [formFactorExclusion(project)];

  const carriers = resolveCarriers(run);
  for (const bucket of ['desktop', 'mobile', 'either'] as const) {
    if (carriers[bucket] !== project)
      patterns.push(new RegExp(String.raw`@engine-any-${bucket}\b`));
  }

  // A pin is not a carrier election: every project of the pinned engine that
  // the form-factor tag allows runs it, and every other engine excludes it.
  for (const pinnedEngine of new Set(PINNED_WORK.map((pinned) => pinned.pinnedEngine))) {
    if (PROJECT_ENGINE.get(project) !== pinnedEngine)
      patterns.push(new RegExp(String.raw`@engine-pinned-${pinnedEngine}\b`));
  }
  return patterns;
}
