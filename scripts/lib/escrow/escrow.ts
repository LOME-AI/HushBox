/**
 * One escrow run: read the escrow set out of the environment, encrypt it to the
 * offline recipients, and write it once.
 *
 * The order is the guarantee. Recipients are validated before a secret is read,
 * and every missing variable is named in one refusal before anything is
 * encrypted, so a shortfall of any kind leaves the store untouched.
 */
import { armor } from 'age-encryption';
import { buildEscrowPayload, escrowObjectKey } from './payload.js';
import { createEscrowEncrypter } from './recipients.js';
import { putEscrowObject, readEscrowBucket } from './upload.js';
import type { EnvironmentValues } from './payload.js';
import type { SignedFetch } from './upload.js';

interface EscrowRun {
  readonly env: EnvironmentValues;
  /**
   * The GitHub environment this run escrows the set of. A job's bindings mix the
   * repository's secrets with those of the one environment it declares, so which
   * set they belong to is not derivable from them: it is what the run was
   * invoked for.
   */
  readonly environment: string;
  readonly recipients: readonly string[];
  readonly fetchImpl: SignedFetch;
}

/**
 * Encrypts the escrow set and writes it; answers with the object key it wrote,
 * which is the whole provenance a drill needs.
 *
 * The document is indented because the drill is a human reading the plaintext
 * `age -d` prints.
 */
export async function escrowSecrets(run: EscrowRun): Promise<string> {
  const encrypter = createEscrowEncrypter(run.recipients);

  const payload = buildEscrowPayload(run.env, run.environment);
  const bucket = readEscrowBucket(run.env);
  if (!payload.ok || !bucket.ok) {
    const missing = [...(payload.ok ? [] : payload.missing), ...(bucket.ok ? [] : bucket.missing)];
    throw new Error(`escrow: missing or empty in the environment: ${missing.join(', ')}`);
  }

  const armored = armor.encode(await encrypter.encrypt(JSON.stringify(payload.payload, null, 2)));
  const objectKey = escrowObjectKey(payload.payload);
  await putEscrowObject(bucket.bucket, objectKey, armored, run.fetchImpl);
  return objectKey;
}
