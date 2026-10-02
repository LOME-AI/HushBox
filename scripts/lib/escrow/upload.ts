/**
 * The one write an escrow run performs: a signed S3 `PUT` of the armored
 * document into the escrow bucket.
 *
 * The credential this signs with can write and list and read nothing, and the
 * bytes it writes are already encrypted to offline recipients, so the pair is
 * worth no more to a thief than the bucket's name.
 */
import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import type { EnvironmentValues } from './payload.js';

/**
 * Which environment variable carries each field into the run. All four arrive
 * from repository-level GitHub secrets: the two addresses grant nothing and are
 * held as secrets anyway, because keeping them out of the repository is what
 * keeps any file here from naming where the copies are kept. Their declarations
 * are the statement of record (`packages/shared/src/env/ci-secrets.ts`).
 */
export const ESCROW_BUCKET_ENV_NAMES = {
  keyId: 'ESCROW_B2_KEY_ID',
  applicationKey: 'ESCROW_B2_APPLICATION_KEY', // gitleaks:allow -- the variable's name, never a value read from it
  bucket: 'ESCROW_B2_BUCKET',
  endpoint: 'ESCROW_B2_S3_ENDPOINT',
} as const;

/** What the upload signs with, and where it addresses. */
export interface EscrowBucket {
  readonly keyId: string;
  readonly applicationKey: string;
  readonly bucket: string;
  readonly endpoint: string;
}

type EscrowBucketResult =
  | { readonly ok: true; readonly bucket: EscrowBucket }
  | { readonly ok: false; readonly missing: readonly string[] };

/**
 * The transport one signed request is issued over. `globalThis.fetch` fits, and
 * the status is all of the answer this reads: an error body from a store is
 * attacker-influenced text bound for a workflow log.
 */
export type SignedFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
  }
) => Promise<{ readonly status: number }>;

/**
 * The real transport, shared by the CLI and by every test that wants a genuine
 * round trip: one request, with only its status read back.
 */
export const signedFetch: SignedFetch = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status };
};

/** The four fields, or the names whose value is absent. Names, never values. */
export function readEscrowBucket(env: EnvironmentValues): EscrowBucketResult {
  const read = (name: string): string => env[name] ?? '';
  const missing = Object.values(ESCROW_BUCKET_ENV_NAMES).filter((name) => read(name) === '');
  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    bucket: {
      keyId: read(ESCROW_BUCKET_ENV_NAMES.keyId),
      applicationKey: read(ESCROW_BUCKET_ENV_NAMES.applicationKey),
      bucket: read(ESCROW_BUCKET_ENV_NAMES.bucket),
      endpoint: read(ESCROW_BUCKET_ENV_NAMES.endpoint),
    },
  };
}

/** `<endpoint>/<bucket>/<object key>`, path style, which both vendors serve. */
function objectUrl(bucket: EscrowBucket, objectKey: string): string {
  const segments = [bucket.bucket, ...objectKey.split('/')].map((segment) =>
    encodeURIComponent(segment)
  );
  return `${bucket.endpoint.replace(/\/+$/, '')}/${segments.join('/')}`;
}

/**
 * Writes the document, and fails the run on anything but a success.
 *
 * The region is left to the signer, which reads it off the endpoint host.
 */
export async function putEscrowObject(
  bucket: EscrowBucket,
  objectKey: string,
  body: string,
  fetchImpl: SignedFetch
): Promise<void> {
  // aws4fetch keeps the secret on this instance and keys its derived-signing-key
  // cache by it, so inspecting or serializing the client renders the plaintext key.
  const aws = new AwsClient({
    accessKeyId: bucket.keyId,
    secretAccessKey: bucket.applicationKey,
    service: 's3',
  });

  const url = objectUrl(bucket, objectKey);
  const signed = await aws.sign(url, {
    method: 'PUT',
    headers: {
      // Stated rather than left to the library, which signs an S3 request as
      // UNSIGNED-PAYLOAD when the header is absent.
      'x-amz-content-sha256': createHash('sha256').update(body).digest('hex'),
    },
    body,
  });

  // The one attempt the escrow run makes: a transient failure fails the run, and
  // with it the deploy, rather than being retried into a second write of the same
  // object key.
  const { status } = await fetchImpl(signed.url, {
    method: 'PUT',
    headers: Object.fromEntries(signed.headers),
    body,
  });
  if (status < 200 || status >= 300) {
    throw new Error(`escrow: the store refused the upload with HTTP ${String(status)}`);
  }
}
