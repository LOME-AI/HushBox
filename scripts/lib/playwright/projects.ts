/**
 * The registry of Playwright projects: the single statement of which projects
 * exist. Every other list — the browser-matrix axes, the config's project names,
 * the seed's persona cross-product and its username suffixes — is derived from
 * this array, so a project cannot exist in one place and be missing from
 * another. Three hand-maintained lists disagreed before this module existed, and
 * the disagreement is what let a whole suite run in no CI job.
 *
 * Deliberately import-free and free of any `process` read at module scope, so a
 * generator, a vitest run and `playwright.config.ts` can all import it without
 * inheriting each other's environment or argv (`playwright.config.ts` itself is
 * unimportable for exactly that reason: it parses `process.argv`).
 *
 * There is no opt-out field, deliberately: "this project skips X" is the shape
 * of hole this registry exists to close.
 */

/** The browser binary a project runs on — what `playwright install` takes. */
type ProjectBrowser = 'chromium' | 'firefox' | 'webkit';

/**
 * What a project is for. `desktop`/`mobile` are the two form-factor axes of the
 * engine matrix; a `plane` project is a separate surface (its spec set is fixed
 * by its directory), never a carrier for engine-any work.
 */
type ProjectRole = 'desktop' | 'mobile' | 'plane';

interface E2eProject {
  readonly name: string;
  readonly browser: ProjectBrowser;
  readonly role: ProjectRole;
  /**
   * Two-character username suffix for this project's seeded personas. Its
   * presence is also what says the project has a persona universe of its own,
   * hence a setup project that logs those personas in and a storage state.
   */
  readonly personaCode?: string;
  /**
   * The one project whose CI job carries the webhook-dependent work. Exactly one
   * project may declare it (pinned by test): the lane installs a single listener
   * and the specs behind it are not idempotent across parallel jobs.
   */
  readonly webhookLane?: true;
}

export const E2E_PROJECTS = [
  { name: 'chromium', browser: 'chromium', role: 'desktop', personaCode: 'cr', webhookLane: true },
  { name: 'firefox', browser: 'firefox', role: 'desktop', personaCode: 'ff' },
  { name: 'webkit', browser: 'webkit', role: 'desktop', personaCode: 'wk' },
  { name: 'iphone-15', browser: 'webkit', role: 'mobile', personaCode: 'ih' },
  { name: 'pixel-7', browser: 'chromium', role: 'mobile', personaCode: 'px' },
  { name: 'ipad-pro', browser: 'webkit', role: 'mobile', personaCode: 'ip' },
  { name: 'admin', browser: 'chromium', role: 'plane' },
] as const satisfies readonly E2eProject[];

/** Every project name the registry defines (excluding the derived setup projects). */
export type ProjectName = (typeof E2E_PROJECTS)[number]['name'];

/**
 * Desktop projects, in carrier-preference order — array order IS the preference
 * order the engine-any carrier election reads.
 */
export const DESKTOP_PROJECTS = E2E_PROJECTS.flatMap((project) =>
  project.role === 'desktop' ? [project.name] : []
);

/** Device projects, in carrier-preference order. */
export const MOBILE_PROJECTS = E2E_PROJECTS.flatMap((project) =>
  project.role === 'mobile' ? [project.name] : []
);

/** The projects that are surfaces rather than engines, in registry order. */
export const PLANE_PROJECTS = E2E_PROJECTS.flatMap((project) =>
  project.role === 'plane' ? [project.name] : []
);

/** Every project the two engine axes route across. */
export const BROWSER_MATRIX_PROJECTS = [...DESKTOP_PROJECTS, ...MOBILE_PROJECTS];

/** A browser-matrix project name. */
export type MatrixProject = (typeof BROWSER_MATRIX_PROJECTS)[number];

const SEEDED_PROJECTS = E2E_PROJECTS.flatMap((project) =>
  'personaCode' in project ? [project] : []
);

/** A project whose personas the seed creates. */
export type E2EProjectName = (typeof SEEDED_PROJECTS)[number]['name'];

/** Playwright project names; persona×project seeds per-project wallets. */
export const E2E_PROJECT_NAMES = SEEDED_PROJECTS.map((project) => project.name);

/**
 * 2-char project codes used to suffix usernames. `username` is `varchar(20)` and
 * must stay unique across the persona×project cross-product — full project names
 * (e.g. "chromium" + a 20-char base displayName) would overflow.
 */
export const PROJECT_CODE = Object.fromEntries(
  SEEDED_PROJECTS.map((project) => [project.name, project.personaCode])
) as Record<E2EProjectName, string>;

/**
 * The setup project a given project waits on: a seeded project's logs its
 * personas in, a plane's proves the plane's shared preconditions once.
 */
export function setupProjectName(project: ProjectName): string {
  return `setup-${project}`;
}

/**
 * Every project name the config defines, in the order the config declares them:
 * each seeded project's setup project, then each plane's, then the planes, then
 * the engine matrix. `playwright.config.ts` builds its `projects` array from the
 * same four parts in the same order, so this list and that array cannot disagree.
 */
export const ALL_PROJECT_NAMES = [
  ...E2E_PROJECT_NAMES.map((project) => setupProjectName(project)),
  ...PLANE_PROJECTS.map((project) => setupProjectName(project)),
  ...PLANE_PROJECTS,
  ...BROWSER_MATRIX_PROJECTS,
];
