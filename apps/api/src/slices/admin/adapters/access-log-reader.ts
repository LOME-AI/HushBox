import { createEnvUtilities } from '@hushbox/shared';
import { createCloudflareAccessLogReader } from './access-log-cloudflare.js';
import { createFakeAccessLogReader } from './access-log-fake.js';
import type { EnvContext } from '@hushbox/shared';
import type { AccessLogReader } from '../ports/index.js';

interface AccessLogReaderEnv extends EnvContext {
  readonly CLOUDFLARE_ACCESS_LOG_API_TOKEN?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
}

/**
 * Reader selection: the fake (no events, no network) everywhere the real
 * Cloudflare API is not exercisable — local dev, CI, E2E (the honest
 * boundary). Production binds the real adapter and fails fast and loud on a
 * missing token or account id VALUE — never a fake fallback: a production
 * auditor that silently reads canned data would hide a compromised edge wall.
 */
export function createAccessLogReaderFromEnv(env: AccessLogReaderEnv): AccessLogReader {
  const { isProduction } = createEnvUtilities(env);
  if (!isProduction) {
    return createFakeAccessLogReader([]);
  }
  const apiToken = env.CLOUDFLARE_ACCESS_LOG_API_TOKEN;
  if (apiToken === undefined || apiToken === '') {
    throw new Error('access-log audit: CLOUDFLARE_ACCESS_LOG_API_TOKEN is required in production');
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (accountId === undefined || accountId === '') {
    throw new Error('access-log audit: CLOUDFLARE_ACCOUNT_ID is required in production');
  }
  return createCloudflareAccessLogReader({
    accountId,
    apiToken,
    // Bound so the adapter's stored reference keeps its global receiver.
    fetch: globalThis.fetch.bind(globalThis),
  });
}
