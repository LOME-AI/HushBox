import type { EnvContext } from '@hushbox/shared';

/**
 * Extends EnvContext (the `EmailSenderEnv` pattern): a weak all-optional shape
 * would fail assignability from `Bindings`, which declares neither var.
 */
export interface FrontendUrlEnv extends EnvContext {
  readonly FRONTEND_URL?: string;
}

/**
 * The frontend base URL every email app link is built on. A missing value is a
 * deployment misconfiguration: a fail-fast defect, never a silently unsent email.
 */
export function requireFrontendUrl(env: FrontendUrlEnv): string {
  if (env.FRONTEND_URL === undefined || env.FRONTEND_URL === '') {
    throw new Error('FRONTEND_URL is required to build email links');
  }
  return env.FRONTEND_URL;
}
