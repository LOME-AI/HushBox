/**
 * How every automation that crosses between the two repositories obtains the
 * sync bot's token.
 *
 * One implementation rather than one per workflow: the two environment names
 * and the refusal are exactly what separate copies would drift on, and a copy
 * that read a misspelled name would fail as "no installation" rather than as
 * "nothing was provided".
 */
import { installationAccessToken } from './github-app-token.js';

export const APP_ID_VARIABLE = 'HUSHBOX_SYNC_APP_ID';
export const PRIVATE_KEY_VARIABLE = 'HUSHBOX_SYNC_PRIVATE_KEY';

interface AppCredentials {
  readonly appId: string;
  readonly privateKey: string;
}

/** `what` names the caller, so a refusal says which automation stopped. */
export function readSyncAppCredentials(what: string, env: NodeJS.ProcessEnv): AppCredentials {
  const appId = env[APP_ID_VARIABLE] ?? '';
  const privateKey = env[PRIVATE_KEY_VARIABLE] ?? '';
  if (appId === '' || privateKey === '') {
    throw new Error(`${what} needs the sync bot's credentials; they were not both provided.`);
  }
  return { appId, privateKey };
}

export async function syncBotToken(
  what: string,
  repository: string,
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch
): Promise<string> {
  return installationAccessToken(
    readSyncAppCredentials(what, env),
    repository,
    Math.floor(Date.now() / 1000),
    fetchImpl
  );
}
