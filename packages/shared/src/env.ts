/**
 * Environment context for detecting dev/prod/CI status.
 */
export interface EnvContext {
  NODE_ENV?: string;
  CI?: string;
  E2E?: string;
}

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
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isCI = Boolean(env.CI);
  const isE2E = Boolean(env.E2E);
  // 'test' mode is treated as development (uses mocks, not production services)
  const isDevMode = nodeEnv === 'development' || nodeEnv === 'test';

  return {
    isDev: isDevMode,
    isLocalDev: isDevMode && !isCI,
    isProduction: nodeEnv === 'production',
    isCI,
    isE2E,
    requiresRealServices: nodeEnv === 'production' || isCI,
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
  /** Production mode */
  isProduction: boolean;
  /** Running in CI */
  isCI: boolean;
  /** Running E2E tests (in CI) - uses mocks for some services like OpenRouter */
  isE2E: boolean;
  /** CI or production - require real credentials */
  requiresRealServices: boolean;
}
