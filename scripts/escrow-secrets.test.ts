import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { armor } from 'age-encryption';
import { escrowEnvironments, escrowedSecretKeys } from './generate-env.js';
import { runEscrowSecrets } from './escrow-secrets.js';
import { ESCROW_RECIPIENTS } from './lib/escrow/recipients.js';
import { ESCROW_BUCKET_ENV_NAMES } from './lib/escrow/upload.js';
import type { SignedFetch } from './lib/escrow/upload.js';

const ARMOR_HEADER = '-----BEGIN AGE ENCRYPTED FILE-----';

/** The environment these cases write the set of unless one says otherwise. */
const ESCROW_SET = 'production';

/** Every variable one run reads, each secret at a low-entropy stand-in value. */
function cliEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
  set: string = ESCROW_SET
): Record<string, string | undefined> {
  return {
    GITHUB_RUN_ID: '405',
    GITHUB_SHA: randomBytes(20).toString('hex'),
    ...Object.fromEntries(escrowedSecretKeys(set).map((key) => [key, `value of ${key}`])),
    [ESCROW_BUCKET_ENV_NAMES.keyId]: 'key-id-under-test',
    [ESCROW_BUCKET_ENV_NAMES.applicationKey]: 'application-key-under-test',
    [ESCROW_BUCKET_ENV_NAMES.bucket]: 'escrow-bucket-under-test',
    [ESCROW_BUCKET_ENV_NAMES.endpoint]: 'https://s3.us-west-004.backblazeb2.com',
    ...overrides,
  };
}

/** A transport that accepts the write and keeps what it was asked to send. */
function recordingFetch(): { calls: { url: string; body: string }[]; impl: SignedFetch } {
  const calls: { url: string; body: string }[] = [];
  return {
    calls,
    impl: (url, init) => {
      calls.push({ url, body: init.body });
      return Promise.resolve({ status: 200 });
    },
  };
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

describe('runEscrowSecrets', () => {
  it('writes the armored document to the object the run names', async () => {
    const env = cliEnv();
    const transport = recordingFetch();

    await runEscrowSecrets(env, [ESCROW_SET], transport.impl, sink());

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toContain(`escrow/405-${String(env['GITHUB_SHA'])}.json.age`);
    expect(transport.calls[0]?.body.startsWith(ARMOR_HEADER)).toBe(true);
  });

  // The identities are offline, so the stanza count is the only reachable proof
  // that the committed recipients — and not a shorter list — wrapped the file key.
  it('wraps the file key for every committed recipient', async () => {
    const transport = recordingFetch();

    await runEscrowSecrets(cliEnv(), [ESCROW_SET], transport.impl, sink());

    const header = new TextDecoder().decode(armor.decode(transport.calls[0]?.body ?? ''));
    expect(header.split('-> X25519').length - 1).toBe(ESCROW_RECIPIENTS.length);
  });

  it('names the object it wrote on stdout', async () => {
    const env = cliEnv();
    const stdout = sink();

    await runEscrowSecrets(env, [ESCROW_SET], recordingFetch().impl, stdout);

    expect(stdout.text()).toContain(`escrow/405-${String(env['GITHUB_SHA'])}.json.age`);
  });

  it('writes no secret value to stdout', async () => {
    const env = cliEnv();
    const stdout = sink();

    await runEscrowSecrets(env, [ESCROW_SET], recordingFetch().impl, stdout);

    for (const key of escrowedSecretKeys(ESCROW_SET)) {
      expect(stdout.text()).not.toContain(String(env[key]));
    }
  });

  it('writes the set of every environment the escrow runs under', async () => {
    for (const environment of escrowEnvironments()) {
      const transport = recordingFetch();

      await runEscrowSecrets(cliEnv({}, environment), [environment], transport.impl, sink());

      expect(transport.calls).toHaveLength(1);
    }
  });

  it('refuses a line naming no environment, writing nothing', async () => {
    const transport = recordingFetch();

    await expect(runEscrowSecrets(cliEnv(), [], transport.impl, sink())).rejects.toThrow(
      /exactly one environment/u
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('refuses a line naming more than one environment, writing nothing', async () => {
    const transport = recordingFetch();

    await expect(
      runEscrowSecrets(cliEnv(), ['production', 'backup'], transport.impl, sink())
    ).rejects.toThrow(/exactly one environment/u);
    expect(transport.calls).toHaveLength(0);
  });

  it('refuses an environment the escrow does not run under, writing nothing', async () => {
    const transport = recordingFetch();

    await expect(runEscrowSecrets(cliEnv(), ['staging'], transport.impl, sink())).rejects.toThrow(
      /staging/u
    );
    expect(transport.calls).toHaveLength(0);
  });

  it('prints usage and writes nothing when the line asks for it', async () => {
    const transport = recordingFetch();
    const stdout = sink();

    await runEscrowSecrets(cliEnv(), ['--help'], transport.impl, stdout);

    expect(stdout.text()).toContain('<environment>');
    expect(transport.calls).toHaveLength(0);
  });

  it('refuses the run and writes nothing when a value is absent', async () => {
    const stdout = sink();
    const transport = recordingFetch();

    await expect(
      runEscrowSecrets(cliEnv({ OPAQUE_KEK: undefined }), [ESCROW_SET], transport.impl, stdout)
    ).rejects.toThrow(/OPAQUE_KEK/);
    expect(stdout.text()).toBe('');
    expect(transport.calls).toHaveLength(0);
  });
});
