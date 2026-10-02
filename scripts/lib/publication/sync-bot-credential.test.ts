import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  APP_ID_VARIABLE,
  PRIVATE_KEY_VARIABLE,
  readSyncAppCredentials,
  syncBotToken,
} from './sync-bot-credential.js';

const REPOSITORY = 'Example-Org/Example';

/** A real key, because the JWT is signed for real before anything is asked of it. */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const present = (): NodeJS.ProcessEnv => ({
  [APP_ID_VARIABLE]: '1234',
  [PRIVATE_KEY_VARIABLE]: privateKey,
});

describe('readSyncAppCredentials', () => {
  it('answers the credentials the environment carries', () => {
    expect(readSyncAppCredentials('the mirror', present())).toEqual({
      appId: '1234',
      privateKey,
    });
  });

  it('names what refused when the app id is missing', () => {
    expect(() =>
      readSyncAppCredentials('the mirror', { [PRIVATE_KEY_VARIABLE]: privateKey })
    ).toThrow(/the mirror/);
  });

  it('refuses when the key is missing, so both halves are required', () => {
    expect(() => readSyncAppCredentials('the mirror', { [APP_ID_VARIABLE]: '1234' })).toThrow(
      /credentials/
    );
  });

  it('refuses an empty value the same way as an absent one', () => {
    expect(() =>
      readSyncAppCredentials('the mirror', {
        [APP_ID_VARIABLE]: '',
        [PRIVATE_KEY_VARIABLE]: privateKey,
      })
    ).toThrow(/credentials/);
  });
});

describe('syncBotToken', () => {
  it('mints an installation token for the repository it was asked about', async () => {
    const asked: string[] = [];
    const fetchImpl = ((url: string) => {
      asked.push(url);
      const body = url.endsWith('/installation') ? { id: 55 } : { token: 'minted' };
      return Promise.resolve(Response.json(body, { status: 200 }));
    }) as unknown as typeof fetch;

    expect(await syncBotToken('the mirror', REPOSITORY, present(), fetchImpl)).toBe('minted');
    expect(asked[0]).toContain(`/repos/${REPOSITORY}/installation`);
    expect(asked[1]).toContain('/app/installations/55/access_tokens');
  });

  it('refuses before asking anything when the credentials are absent', async () => {
    const fetchImpl = (() => {
      throw new Error('the mint must not be reached');
    }) as unknown as typeof fetch;

    await expect(syncBotToken('the mirror', REPOSITORY, {}, fetchImpl)).rejects.toThrow(
      /credentials/
    );
  });
});

/**
 * Nothing here is a copy of anything, and this is what keeps it that way. The
 * refusal and the two variable names were duplicated once per automation; a
 * fifth copy would read a name of its own, and a misspelled one fails as "no
 * installation" rather than as "nothing was provided". Read from the directory
 * rather than from a list of the automations known to exist, because a copy in
 * a file nobody listed is the copy this cannot afford to miss.
 */
describe('who may name the credential', () => {
  const SCRIPTS = path.resolve(import.meta.dirname, '..', '..');
  const OWNER = 'lib/publication/sync-bot-credential.ts';

  function typescriptUnder(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) return typescriptUnder(full);
      return entry.name.endsWith('.ts') ? [full] : [];
    });
  }

  it('is the credential module alone, in every script the tree carries', () => {
    const naming = typescriptUnder(SCRIPTS)
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return text.includes(APP_ID_VARIABLE) || text.includes(PRIVATE_KEY_VARIABLE);
      })
      .map((file) => path.relative(SCRIPTS, file).replaceAll(path.sep, '/'));

    expect(naming).toEqual([OWNER]);
  });
});
