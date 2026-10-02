/**
 * The one affirmative spelling of a boolean environment variable. The env
 * registry writes it and this module compares against it, so the emitted value
 * and the coercion are one decision rather than two that must agree.
 *
 * There is no denial to pair with it. A mode that is not answering yes states
 * nothing, and the loader that puts a stack's files in force removes what the
 * mode that generated them states nothing about, so an absent variable is the
 * denial — see `scripts/with-env.ts`. That is why the comparison is exact: under a
 * truthiness coercion an absent variable and a stated denial agree only by
 * accident, and the first spelling of a denial anyone wrote would diverge.
 */
export const ENV_FLAG_TRUE = 'true';

/**
 * Environment context for detecting dev/prod/CI status.
 */
export interface EnvContext {
  NODE_ENV?: string;
  /**
   * Whether this environment is a continuous-integration one, under the name
   * every CI platform already sets. Absent means no, for the modes that run a
   * stack: they state nothing here, and the loader that puts a stack's
   * generated files in force clears what the mode that generated them states
   * nothing about, so nothing a machine set of its own reaches this field. The
   * mode that runs no stack loads no files and clears nothing, so there a value
   * the machine holds survives.
   */
  CI?: string;
  E2E?: string;
  /**
   * Set to `'true'` when running under the Vitest runner. Vitest exposes this
   * as `process.env.VITEST` (Node) / `import.meta.env.VITEST` (browser); the
   * caller that builds this context forwards it. Distinguishes a local vitest
   * run from the local dev server — both of which are otherwise `NODE_ENV=
   * development` with no CI/E2E — so `isDevServer` can stay honest.
   */
  VITEST?: string;
}

/**
 * The registry-carried variables the environment utilities build their flags
 * from, and so the variables a mode's silence has to be able to speak for.
 *
 * `VITEST` is deliberately not among them: the vitest runner sets it in the
 * process it starts, no mode declares it, and clearing it would make a local
 * vitest run indistinguishable from the dev server.
 */
export const CLASSIFICATION_VARIABLES = [
  'NODE_ENV',
  'CI',
  'E2E',
] as const satisfies readonly (keyof EnvContext)[];

/**
 * Create environment utilities from runtime env vars.
 * This is THE source of truth for all dev/prod/CI detection.
 *
 * @example Backend (Hono)
 * ```typescript
 * const env = createEnvUtilities(c.env);
 * if (env.isLocalDev) { return createMockClient(); }
 * ```
 *
 * @example Frontend (Vite) - initialize once
 * ```typescript
 * export const env = createEnvUtilities({
 *   NODE_ENV: import.meta.env.MODE,
 *   CI: import.meta.env.VITE_CI,
 * });
 * ```
 */
export function createEnvUtilities(env: EnvContext): EnvUtilities {
  // Fail fast: a fallback here would silently classify a misconfigured
  // production isolate as local dev (mock clients).
  if (env.NODE_ENV === undefined) {
    throw new Error('NODE_ENV is not set: createEnvUtilities requires an explicit NODE_ENV');
  }
  const nodeEnv = env.NODE_ENV;
  // Compared against the one affirmative spelling rather than coerced, so that
  // only the value a mode states answers yes. `Boolean` would read every
  // spelling but the empty one as an affirmation, which is what let the word
  // `false` and a machine's own `CI=1` both classify as CI.
  const isCI = env.CI === ENV_FLAG_TRUE;
  const isE2E = env.E2E === ENV_FLAG_TRUE;
  // Vitest sets `VITEST='true'` in its process. The backend stays on
  // `NODE_ENV=development` under vitest (via .dev.vars), so without this signal
  // a local vitest run is indistinguishable from the dev server. Kept private —
  // its only purpose is to make `isDevServer` honest (no direct consumers).
  const isVitest = Boolean(env.VITEST);
  const isProduction = nodeEnv === 'production';
  // An end-to-end run always drives a local stack, so it is a development
  // environment whatever word NODE_ENV carries. The frontends pass Vite's
  // `MODE` here, and a bundle built for the end-to-end stack carries that
  // stack's name — outside NODE_ENV's development/production/test vocabulary —
  // so without this term such a bundle answers `isDev` false and reaches for
  // the real payment tokenizer against the local stack. `!isProduction` is a
  // defense-in-depth pin, matching the one on the admin dev-auth gate: a
  // production build stays production even if an E2E flag were ever baked in.
  const isDevMode = nodeEnv === 'development' || (isE2E && !isProduction);
  const isLocalDev = isDevMode && !isCI;

  return {
    isDev: isDevMode,
    isLocalDev,
    // A real interactive dev server with no automated test harness attached —
    // the only place human-facing dev affordances (visible mock streaming, the
    // media-generation placeholder delay) should fire. A strict subset of
    // `isLocalDev`, which also covers local vitest and local E2E.
    isDevServer: isLocalDev && !isE2E && !isVitest,
    isProduction,
    isCI,
    isE2E,
    requiresRealServices: isProduction || isCI,
  };
}

/**
 * Environment utilities returned by createEnvUtilities.
 */
export interface EnvUtilities {
  /** Development mode (local OR CI in dev mode) - for UI visibility */
  isDev: boolean;
  /** Local development only (not CI, not production) - for using mocks */
  isLocalDev: boolean;
  /**
   * A real interactive dev server — local dev mode, but NOT under vitest or
   * E2E. Strict subset of `isLocalDev`. Use this (not `isLocalDev`) to gate
   * human-facing dev affordances like visible mock-stream timing.
   */
  isDevServer: boolean;
  /** Production mode */
  isProduction: boolean;
  /** Running in CI */
  isCI: boolean;
  /** Running E2E tests (in CI) - uses mocks for some services like the AI Gateway */
  isE2E: boolean;
  /** CI or production - require real credentials */
  requiresRealServices: boolean;
}
