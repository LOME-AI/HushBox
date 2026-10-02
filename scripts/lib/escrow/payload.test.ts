import { describe, it, expect } from 'vitest';
import {
  deriveOpaqueKek,
  deriveTotpEncryptionKey,
  opaqueKekFingerprint,
  totpKeyFingerprint,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { escrowEnvironments, escrowedSecretKeys } from '../../generate-env.js';
import { buildEscrowPayload, escrowObjectKey } from './payload.js';

/** A run identity in the shape Actions publishes, with no instant in either field. */
const RUN_ID = '404';
const COMMIT_SHA = 'abcabcabcabcabcabcabcabcabcabcabcabcabca';

/** The environment whose set the cases below build unless they say otherwise. */
const SET = 'production';

/** Every variable the payload requires, each at a low-entropy stand-in value. */
function fullEnv(set: string = SET): Record<string, string> {
  return {
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_SHA: COMMIT_SHA,
    ...Object.fromEntries(escrowedSecretKeys(set).map((key) => [key, `value of ${key}`])),
  };
}

/** The full environment less one variable. */
function withoutVariable(name: string): Record<string, string> {
  return Object.fromEntries(Object.entries(fullEnv()).filter(([key]) => key !== name));
}

/** The payload of a well-formed environment, or a failure the assertion reports. */
function payloadOf(
  env: Record<string, string>,
  set: string = SET
): ReturnType<typeof buildEscrowPayload> {
  const result = buildEscrowPayload(env, set);
  expect(result.ok).toBe(true);
  return result;
}

describe('buildEscrowPayload', () => {
  it('names the run and the commit the workflow published', () => {
    const result = payloadOf(fullEnv());

    if (!result.ok) return;
    expect(result.payload.runId).toBe(RUN_ID);
    expect(result.payload.commitSha).toBe(COMMIT_SHA);
  });

  it('carries every escrowed secret under its own name', () => {
    const result = payloadOf(fullEnv());

    if (!result.ok) return;
    expect(Object.keys(result.payload.secrets)).toEqual(escrowedSecretKeys(SET));
  });

  it('leaves an environment entry outside the escrow set out of the payload', () => {
    const env = { ...fullEnv(), GITLEAKS_LICENSE: 'value of GITLEAKS_LICENSE' };

    const result = payloadOf(env);

    if (!result.ok) return;
    expect(JSON.stringify(result.payload)).not.toContain('GITLEAKS_LICENSE');
  });

  it('stamps the opaque key-encryption key with the fingerprint a users row carries', () => {
    const env = fullEnv();

    const result = payloadOf(env);

    if (!result.ok) return;
    const kek = deriveOpaqueKek(textEncoder.encode(env['OPAQUE_KEK'] ?? ''));
    expect(result.payload.fingerprints['OPAQUE_KEK']).toBe(
      Buffer.from(opaqueKekFingerprint(kek)).toString('hex')
    );
  });

  it('stamps the totp encryption secret with the fingerprint a stored blob carries', () => {
    const env = fullEnv();

    const result = payloadOf(env);

    if (!result.ok) return;
    const key = deriveTotpEncryptionKey(textEncoder.encode(env['TOTP_ENCRYPTION_SECRET'] ?? ''));
    expect(result.payload.fingerprints['TOTP_ENCRYPTION_SECRET']).toBe(
      Buffer.from(totpKeyFingerprint(key)).toString('hex')
    );
  });

  it('fingerprints the two keys the database stamps and no other', () => {
    const result = payloadOf(fullEnv());

    if (!result.ok) return;
    expect(Object.keys(result.payload.fingerprints)).toEqual([
      'OPAQUE_KEK',
      'TOTP_ENCRYPTION_SECRET',
    ]);
  });

  it('refuses the whole payload when an escrowed value is absent, naming it', () => {
    expect(buildEscrowPayload(withoutVariable('IRON_SESSION_SECRET'), SET)).toEqual({
      ok: false,
      missing: ['IRON_SESSION_SECRET'],
    });
  });

  // Actions renders an unset secret as the empty string, so empty is the only
  // form "missing" takes on the runner.
  it('treats an empty value as absent', () => {
    expect(buildEscrowPayload({ ...fullEnv(), VAPID_PRIVATE_KEY: '' }, SET)).toEqual({
      ok: false,
      missing: ['VAPID_PRIVATE_KEY'],
    });
  });

  it('refuses when the run id is absent, naming it', () => {
    expect(buildEscrowPayload(withoutVariable('GITHUB_RUN_ID'), SET)).toEqual({
      ok: false,
      missing: ['GITHUB_RUN_ID'],
    });
  });

  it('refuses when the commit sha is absent, naming it', () => {
    expect(buildEscrowPayload(withoutVariable('GITHUB_SHA'), SET)).toEqual({
      ok: false,
      missing: ['GITHUB_SHA'],
    });
  });

  it('names no value of any kind when it refuses', () => {
    const env = { ...fullEnv(), OPAQUE_KEK: '' };

    const result = buildEscrowPayload(env, SET);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const value of Object.values(env).filter(Boolean)) {
      expect(result.missing.join(' ')).not.toContain(value);
    }
  });
});

describe('the set a payload names', () => {
  it('is the environment the run was asked for', () => {
    const result = payloadOf(fullEnv('backup'), 'backup');

    if (!result.ok) return;
    expect(result.payload.set).toBe('backup');
  });

  it('carries only that environment’s secrets', () => {
    const result = payloadOf(fullEnv('backup'), 'backup');

    if (!result.ok) return;
    expect(Object.keys(result.payload.secrets)).toEqual(escrowedSecretKeys('backup'));
  });

  // A set is escrowed by the job that runs under its environment, so a value
  // another environment holds is unreadable there and would refuse the run.
  it('leaves another environment’s secrets out', () => {
    const other = new Set(escrowedSecretKeys('production'));

    expect(escrowedSecretKeys('backup').filter((key) => other.has(key))).toEqual([]);
  });

  it('refuses a set no environment escrows', () => {
    expect(() => buildEscrowPayload(fullEnv(), 'staging')).toThrow(/staging/u);
  });

  it('covers every environment the escrow runs under', () => {
    for (const environment of escrowEnvironments()) {
      const result = buildEscrowPayload(fullEnv(environment), environment);
      expect(result.ok).toBe(true);
    }
  });
});

describe('escrowObjectKey', () => {
  it('names the object after the run and the commit it captured', () => {
    const result = payloadOf(fullEnv());

    if (!result.ok) return;
    expect(escrowObjectKey(result.payload)).toBe(`escrow/${RUN_ID}-${COMMIT_SHA}.json.age`);
  });

  // The production copies were written under this prefix before any other set
  // existed, so every later set takes a prefix of its own and that one is left
  // where a drill already looks for it.
  it('gives every other set a prefix of its own', () => {
    const result = payloadOf(fullEnv('backup'), 'backup');

    if (!result.ok) return;
    expect(escrowObjectKey(result.payload)).toBe(`escrow/backup/${RUN_ID}-${COMMIT_SHA}.json.age`);
  });
});
