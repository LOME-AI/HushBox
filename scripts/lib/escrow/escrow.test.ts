import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { AwsClient } from 'aws4fetch';
import { armor, Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { CI_SECRETS } from '../../../packages/shared/src/env/ci-secrets.js';
import { envConfig } from '../../../packages/shared/src/env/env.config.js';
import { escrowedSecretKeys } from '../../generate-env.js';
import { escrowBucketFrom } from '../stack/compose-env.js';
import { escrowSecrets } from './escrow.js';
import { ESCROW_BUCKET_ENV_NAMES, signedFetch } from './upload.js';
import type { EscrowPayload } from './payload.js';
import type { SignedFetch } from './upload.js';

/** The armor header every age file the drill downloads begins with. */
const ARMOR_HEADER = '-----BEGIN AGE ENCRYPTED FILE-----';

interface LocalStore {
  readonly endpoint: string;
  readonly keyId: string;
  readonly applicationKey: string;
}

/** The bucket `minio-setup` creates, as the loaded environment names it. */
function localEscrowBucket(): string {
  return escrowBucketFrom(process.env);
}

/**
 * The local object store, addressed with the media credentials the dev stack
 * already carries — the emulator holds one account, so the escrow bucket answers
 * to the same pair.
 */
function localStore(): LocalStore {
  const endpoint = process.env['R2_S3_ENDPOINT'] ?? '';
  const keyId = process.env['R2_ACCESS_KEY_ID'] ?? '';
  const applicationKey = process.env['R2_SECRET_ACCESS_KEY'] ?? '';
  if (endpoint === '' || keyId === '' || applicationKey === '') {
    throw new Error(
      'the local object store is unconfigured; run this file through `pnpm test:pkg @hushbox/scripts`'
    );
  }
  return { endpoint, keyId, applicationKey };
}

function storeClient(): AwsClient {
  const store = localStore();
  return new AwsClient({
    accessKeyId: store.keyId,
    secretAccessKey: store.applicationKey,
    service: 's3',
    retries: 0,
  });
}

/** One object as the store serves it back. */
async function readStoredObject(objectKey: string): Promise<{ status: number; body: string }> {
  const response = await storeClient().fetch(
    `${localStore().endpoint}/${localEscrowBucket()}/${objectKey}`,
    { method: 'GET' }
  );
  return { status: response.status, body: await response.text() };
}

/** The environment whose set these cases escrow unless one says otherwise. */
const ESCROW_SET = 'production';

/** A throwaway identity and its recipient, minted per test and never stored. */
async function testKeyPair(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/** Every variable one run reads, each secret at a low-entropy stand-in value. */
function escrowEnv(
  overrides: Readonly<Record<string, string | undefined>> = {},
  set: string = ESCROW_SET
): Record<string, string | undefined> {
  const store = localStore();
  return {
    GITHUB_RUN_ID: '404',
    // Unique per run so an assertion never reads an object a previous run left.
    GITHUB_SHA: randomBytes(20).toString('hex'),
    ...Object.fromEntries(escrowedSecretKeys(set).map((key) => [key, `value of ${key}`])),
    [ESCROW_BUCKET_ENV_NAMES.keyId]: store.keyId,
    [ESCROW_BUCKET_ENV_NAMES.applicationKey]: store.applicationKey,
    [ESCROW_BUCKET_ENV_NAMES.bucket]: localEscrowBucket(),
    [ESCROW_BUCKET_ENV_NAMES.endpoint]: store.endpoint,
    ...overrides,
  };
}

/** A transport that counts what was sent and otherwise behaves as the real one. */
function countingFetch(): { sent: { count: number }; impl: SignedFetch } {
  const sent = { count: 0 };
  return {
    sent,
    impl: (url, init) => {
      sent.count += 1;
      return signedFetch(url, init);
    },
  };
}

/** Every credential the escrow deliberately never captures. */
function reissueAtVendorNames(): string[] {
  return [
    ...Object.entries(envConfig)
      .filter(
        ([, variable]) =>
          'credential' in variable && variable.credential.onLoss === 'reissueAtVendor'
      )
      .map(([name]) => name),
    ...Object.entries(CI_SECRETS)
      .filter(([, credential]) => credential.onLoss === 'reissueAtVendor')
      .map(([name]) => name),
  ];
}

describe('escrowSecrets', () => {
  it('writes one object the store then serves', async () => {
    const { recipient } = await testKeyPair();
    const transport = countingFetch();

    const objectKey = await escrowSecrets({
      environment: ESCROW_SET,
      env: escrowEnv(),
      recipients: [recipient],
      fetchImpl: transport.impl,
    });

    const stored = await readStoredObject(objectKey);
    expect(transport.sent.count).toBe(1);
    expect(stored.status).toBe(200);
  });

  it('stores the document armored, as a hand drill downloads it', async () => {
    const { recipient } = await testKeyPair();

    const objectKey = await escrowSecrets({
      environment: ESCROW_SET,
      env: escrowEnv(),
      recipients: [recipient],
      fetchImpl: countingFetch().impl,
    });

    const stored = await readStoredObject(objectKey);
    expect(stored.body.startsWith(ARMOR_HEADER)).toBe(true);
  });

  it('writes a document either recipient identity opens alone', async () => {
    const first = await testKeyPair();
    const second = await testKeyPair();

    const objectKey = await escrowSecrets({
      environment: ESCROW_SET,
      env: escrowEnv(),
      recipients: [first.recipient, second.recipient],
      fetchImpl: countingFetch().impl,
    });

    const stored = await readStoredObject(objectKey);
    for (const { identity } of [first, second]) {
      const document = await decryptStored(stored.body, identity);
      expect(document).toHaveProperty('secrets');
    }
  });

  it('writes another environment’s set under that environment’s prefix', async () => {
    const { recipient } = await testKeyPair();

    const objectKey = await escrowSecrets({
      environment: 'backup',
      env: escrowEnv({}, 'backup'),
      recipients: [recipient],
      fetchImpl: countingFetch().impl,
    });

    expect(objectKey.startsWith('escrow/backup/')).toBe(true);
  });

  it('yields exactly the escrowed key set', async () => {
    const { identity, recipient } = await testKeyPair();

    const objectKey = await escrowSecrets({
      environment: ESCROW_SET,
      env: escrowEnv(),
      recipients: [recipient],
      fetchImpl: countingFetch().impl,
    });

    const stored = await readStoredObject(objectKey);
    const payload = await decryptStored(stored.body, identity);
    expect(Object.keys(payload.secrets)).toEqual(escrowedSecretKeys(ESCROW_SET));
  });

  it('names no credential the escrow never captures', async () => {
    const { identity, recipient } = await testKeyPair();

    const objectKey = await escrowSecrets({
      environment: ESCROW_SET,
      env: escrowEnv(),
      recipients: [recipient],
      fetchImpl: countingFetch().impl,
    });

    const stored = await readStoredObject(objectKey);
    const document = JSON.stringify(await decryptStored(stored.body, identity));
    for (const name of reissueAtVendorNames()) {
      expect(document).not.toContain(name);
    }
  });

  it('refuses an absent secret value with nothing sent', async () => {
    const { recipient } = await testKeyPair();
    const transport = countingFetch();

    await expect(
      escrowSecrets({
        environment: ESCROW_SET,
        env: escrowEnv({ IRON_SESSION_SECRET: undefined }),
        recipients: [recipient],
        fetchImpl: transport.impl,
      })
    ).rejects.toThrow(/IRON_SESSION_SECRET/);
    expect(transport.sent.count).toBe(0);
  });

  it('refuses an absent bucket variable with nothing sent', async () => {
    const { recipient } = await testKeyPair();
    const transport = countingFetch();

    await expect(
      escrowSecrets({
        environment: ESCROW_SET,
        env: escrowEnv({ [ESCROW_BUCKET_ENV_NAMES.bucket]: undefined }),
        recipients: [recipient],
        fetchImpl: transport.impl,
      })
    ).rejects.toThrow(new RegExp(ESCROW_BUCKET_ENV_NAMES.bucket));
    expect(transport.sent.count).toBe(0);
  });

  it('refuses a malformed recipient with nothing sent', async () => {
    const transport = countingFetch();

    await expect(
      escrowSecrets({
        environment: ESCROW_SET,
        env: escrowEnv(),
        recipients: ['not-a-recipient'],
        fetchImpl: transport.impl,
      })
    ).rejects.toThrow(/recipient 1 of 1/);
    expect(transport.sent.count).toBe(0);
  });

  it('fails the run when the store refuses the upload', async () => {
    const { recipient } = await testKeyPair();

    await expect(
      escrowSecrets({
        environment: ESCROW_SET,
        env: escrowEnv({ [ESCROW_BUCKET_ENV_NAMES.bucket]: 'no-such-escrow-bucket' }),
        recipients: [recipient],
        fetchImpl: countingFetch().impl,
      })
    ).rejects.toThrow(/HTTP 404/);
  });
});

/** The document one identity reads back out of a stored object. */
async function decryptStored(stored: string, identity: string): Promise<EscrowPayload> {
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  // The stored bytes are opaque to the compiler; the shape is what the run wrote.
  return JSON.parse(await decrypter.decrypt(armor.decode(stored), 'text')) as EscrowPayload;
}
