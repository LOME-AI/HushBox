/**
 * The environment a mobile-test run reads, and the refusal when a variable it
 * needs is absent.
 */

/**
 * Fail-fast env read — no fallback values. A missing variable means the
 * environment was never generated or the script ran outside its wrapper;
 * defaulting silently would mask that (CODE-RULES bans env fallbacks).
 */
export function requireEnv(name: string, hint?: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(hint === undefined ? `${name} not set.` : `${name} not set. ${hint}`);
  }
  return value;
}

export const WITH_ENV_HINT = 'Ensure the script is run via with-env.';

export function requireApiPort(): string {
  return requireEnv('HB_API_PORT', WITH_ENV_HINT);
}

export function requireSandboxPort(): string {
  return requireEnv('HB_SANDBOX_PORT', WITH_ENV_HINT);
}
