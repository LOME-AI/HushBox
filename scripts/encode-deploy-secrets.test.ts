import { describe, it, expect } from 'vitest';
import { encodeDeploySecrets, main } from './encode-deploy-secrets.js';
import { deploySecretKeys } from './generate-env.js';

/**
 * The values that break a shape which re-parses or re-quotes them: embedded
 * double quotes, single and doubled backslashes, the literal `\n` sequences
 * of a PEM body, real newlines, a leading dash, and the `$(…)`, backtick and
 * `$HOME` forms a shell would expand.
 */
const HOSTILE: Record<string, string> = {
  DATABASE_URL: 'say "hello" and "goodbye"',
  OPAQUE_KEK: String.raw`one\backslash and two\\backslashes`,
  FCM_SERVICE_ACCOUNT_JSON: String.raw`{"private_key":"-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n"}`,
  SENTRY_DSN: 'first line\nsecond line\n',
  IRON_SESSION_SECRET: '-starts-with-a-dash',
  NOTIFICATION_TAG_SECRET: 'not $(expanded) nor `expanded` nor $HOME',
};

/** An environment holding every deploy key, the hostile ones at their hostile values. */
function fullEnv(): Record<string, string> {
  return Object.fromEntries(
    deploySecretKeys().map((key) => [key, HOSTILE[key] ?? `value of ${key}`])
  );
}

/** The full environment less one key. */
function withoutKey(key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(fullEnv()).filter(([name]) => name !== key));
}

/** A writable that keeps what was written to it. */
function sink(): { write: (chunk: string) => boolean; text: () => string } {
  const chunks: string[] = [];
  return {
    write: (chunk: string): boolean => {
      chunks.push(chunk);
      return true;
    },
    text: (): string => chunks.join(''),
  };
}

describe('encodeDeploySecrets', () => {
  it('emits exactly the deploy key list, in its order', () => {
    const env = fullEnv();
    expect(Object.keys(env)).toEqual(expect.arrayContaining(Object.keys(HOSTILE)));

    const result = encodeDeploySecrets(env);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(JSON.parse(result.json) as object)).toEqual(deploySecretKeys());
  });

  it('round-trips hostile values byte for byte', () => {
    const env = fullEnv();

    const result = encodeDeploySecrets(env);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.json)).toEqual(env);
  });

  it('leaves environment entries outside the key list out of the object', () => {
    const env = { ...fullEnv(), CLOUDFLARE_API_TOKEN: 'the wrangler credential' };

    const result = encodeDeploySecrets(env);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.json).not.toContain('CLOUDFLARE_API_TOKEN');
  });

  it('refuses the whole batch when a key is missing, naming it', () => {
    expect(encodeDeploySecrets(withoutKey('OPAQUE_KEK'))).toEqual({
      ok: false,
      missing: ['OPAQUE_KEK'],
    });
  });

  // Actions renders an unset secret or step output as the empty string, so
  // empty is the only form "missing" takes on the runner.
  it('treats an empty value as missing', () => {
    const env = { ...fullEnv(), VAPID_PUBLIC_KEY: '', APP_BUNDLE_CHECKSUM_IOS: '' };

    expect(encodeDeploySecrets(env)).toEqual({
      ok: false,
      missing: ['APP_BUNDLE_CHECKSUM_IOS', 'VAPID_PUBLIC_KEY'],
    });
  });
});

describe('main', () => {
  it('writes the one object to stdout and exits 0', () => {
    const env = fullEnv();
    const stdout = sink();
    const stderr = sink();

    const status = main(env, stdout, stderr);

    expect(status).toBe(0);
    expect(JSON.parse(stdout.text())).toEqual(env);
    expect(stderr.text()).toBe('');
  });

  it('writes nothing to stdout and exits non-zero when a key is missing', () => {
    const stdout = sink();

    const status = main(withoutKey('OPAQUE_KEK'), stdout, sink());

    expect(status).not.toBe(0);
    expect(stdout.text()).toBe('');
  });

  it('names the missing keys on stderr and no value of any kind', () => {
    const env = { ...fullEnv(), OPAQUE_KEK: '', SENTRY_DSN: '' };
    const stderr = sink();

    main(env, sink(), stderr);

    expect(stderr.text()).toContain('OPAQUE_KEK');
    expect(stderr.text()).toContain('SENTRY_DSN');
    for (const value of Object.values(env).filter(Boolean)) {
      expect(stderr.text()).not.toContain(value);
    }
  });
});
