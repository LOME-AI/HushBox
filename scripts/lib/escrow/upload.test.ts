import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { ESCROW_BUCKET_ENV_NAMES, putEscrowObject, readEscrowBucket } from './upload.js';
import type { EscrowBucket } from './upload.js';

const OBJECT_KEY = 'escrow/404-abcabcabcabcabcabcabcabcabcabcabcabcabca.json.age';
const BODY = '-----BEGIN AGE ENCRYPTED FILE-----\nYWJj\n-----END AGE ENCRYPTED FILE-----\n';

/** A bucket the local emulator answers for; the credentials are low-entropy stand-ins. */
function localBucket(overrides: Partial<EscrowBucket> = {}): EscrowBucket {
  return {
    keyId: 'key-id-under-test',
    applicationKey: 'application-key-under-test',
    bucket: 'escrow-bucket-under-test',
    endpoint: 'http://localhost:9000',
    ...overrides,
  };
}

/** Every variable the upload signs and addresses with, at stand-in values. */
function fullEnv(): Record<string, string> {
  return {
    [ESCROW_BUCKET_ENV_NAMES.keyId]: 'key-id-under-test',
    [ESCROW_BUCKET_ENV_NAMES.applicationKey]: 'application-key-under-test',
    [ESCROW_BUCKET_ENV_NAMES.bucket]: 'escrow-bucket-under-test',
    [ESCROW_BUCKET_ENV_NAMES.endpoint]: 'http://localhost:9000',
  };
}

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A transport that answers a fixed status and keeps what it was asked to send. */
function recordingFetch(status: number): {
  calls: RecordedRequest[];
  impl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string }
  ) => Promise<{ status: number }>;
} {
  const calls: RecordedRequest[] = [];
  return {
    calls,
    impl: (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return Promise.resolve({ status });
    },
  };
}

describe('readEscrowBucket', () => {
  it('reads the credential pair and the location the run was given', () => {
    expect(readEscrowBucket(fullEnv())).toEqual({ ok: true, bucket: localBucket() });
  });

  it('refuses when a variable is absent, naming every one of them', () => {
    const absent = new Set<string>([ESCROW_BUCKET_ENV_NAMES.keyId, ESCROW_BUCKET_ENV_NAMES.bucket]);
    const env = Object.fromEntries(Object.entries(fullEnv()).filter(([name]) => !absent.has(name)));

    expect(readEscrowBucket(env)).toEqual({
      ok: false,
      missing: [ESCROW_BUCKET_ENV_NAMES.keyId, ESCROW_BUCKET_ENV_NAMES.bucket],
    });
  });

  it('treats an empty value as absent', () => {
    expect(readEscrowBucket({ ...fullEnv(), [ESCROW_BUCKET_ENV_NAMES.endpoint]: '' })).toEqual({
      ok: false,
      missing: [ESCROW_BUCKET_ENV_NAMES.endpoint],
    });
  });
});

describe('putEscrowObject', () => {
  it('addresses the object under the bucket at the given endpoint', async () => {
    const transport = recordingFetch(200);

    await putEscrowObject(localBucket(), OBJECT_KEY, BODY, transport.impl);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.method).toBe('PUT');
    expect(transport.calls[0]?.url).toBe(
      `http://localhost:9000/escrow-bucket-under-test/${OBJECT_KEY}`
    );
  });

  it('addresses the object once when the endpoint carries a trailing slash', async () => {
    const transport = recordingFetch(200);

    await putEscrowObject(
      localBucket({ endpoint: 'http://localhost:9000/' }),
      OBJECT_KEY,
      BODY,
      transport.impl
    );

    expect(transport.calls[0]?.url).toBe(
      `http://localhost:9000/escrow-bucket-under-test/${OBJECT_KEY}`
    );
  });

  it('sends the armored document as the request body', async () => {
    const transport = recordingFetch(200);

    await putEscrowObject(localBucket(), OBJECT_KEY, BODY, transport.impl);

    expect(transport.calls[0]?.body).toBe(BODY);
  });

  it('signs the request for the key the run was given', async () => {
    const transport = recordingFetch(200);

    await putEscrowObject(localBucket(), OBJECT_KEY, BODY, transport.impl);

    expect(transport.calls[0]?.headers['authorization']).toContain('key-id-under-test');
  });

  it('commits to the payload it sends rather than signing it unread', async () => {
    const transport = recordingFetch(200);

    await putEscrowObject(localBucket(), OBJECT_KEY, BODY, transport.impl);

    expect(transport.calls[0]?.headers['x-amz-content-sha256']).toBe(
      createHash('sha256').update(BODY).digest('hex')
    );
  });

  it('scopes the signature to the region the endpoint names', async () => {
    const transport = recordingFetch(200);

    await putEscrowObject(
      localBucket({ endpoint: 'https://s3.us-west-004.backblazeb2.com' }),
      OBJECT_KEY,
      BODY,
      transport.impl
    );

    expect(transport.calls[0]?.headers['authorization']).toContain('/us-west-004/s3/aws4_request');
  });

  it('accepts any success the store answers with', async () => {
    const transport = recordingFetch(204);

    await expect(
      putEscrowObject(localBucket(), OBJECT_KEY, BODY, transport.impl)
    ).resolves.toBeUndefined();
  });

  it('fails the run on a refused upload, naming the status', async () => {
    const transport = recordingFetch(403);

    await expect(putEscrowObject(localBucket(), OBJECT_KEY, BODY, transport.impl)).rejects.toThrow(
      /403/
    );
  });

  it('fails the run on a store error', async () => {
    const transport = recordingFetch(500);

    await expect(putEscrowObject(localBucket(), OBJECT_KEY, BODY, transport.impl)).rejects.toThrow(
      /500/
    );
  });

  // 500 is the status a retrying S3 client repeats on, so it is the one that
  // measures whether the escrow upload retries. It must not: a second attempt
  // would write the same object key again and hide a transient failure from the
  // deploy that gates on this run.
  it('issues exactly one request when the store answers a retryable status', async () => {
    const transport = recordingFetch(500);

    await expect(
      putEscrowObject(localBucket(), OBJECT_KEY, BODY, transport.impl)
    ).rejects.toThrow();

    expect(transport.calls).toHaveLength(1);
  });
});
