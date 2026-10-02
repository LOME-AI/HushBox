#!/usr/bin/env tsx
/**
 * Re-seal every user's OPAQUE server material, and every stored TOTP secret,
 * from the live key to the next one. The material itself never changes — only
 * the key it is sealed under — so every stored registration record stays valid
 * and no user does anything.
 *
 * The API is down for the duration: a row re-sealed under the next key cannot
 * be opened by a Worker still holding the live one. `docs/runbooks/secrets/opaque-kek.md`
 * sequences the whole replacement; this script is its one automated step.
 *
 * Idempotent and resumable by construction. A row already on the next
 * fingerprint is skipped, every write is a compare-and-swap on the bytes the
 * pass read, and the walk is a keyset page over `users.id` — so a killed run is
 * resumed by running it again, and the run exits non-zero while any row is
 * still on another key.
 *
 * Secrets arrive through the runner's env block, never through argv, which is
 * visible in a process listing. Triggered by the manual dispatch workflow, which
 * is how `docs/runbooks/secrets/opaque-kek.md` runs it; see `ops/README.md`.
 */
import {
  FINGERPRINT_BYTES,
  UnknownKeyVersionError,
  decryptTotpSecret,
  deriveOpaqueKek,
  deriveTotpEncryptionKey,
  encryptTotpSecret,
  opaqueKekFingerprint,
  openServerMaterial,
  sealServerMaterial,
  totpKeyFingerprint,
} from '@hushbox/crypto';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { createEnvUtilities, textEncoder } from '@hushbox/shared';
import { createIdentityStores } from '@hushbox/api/identity';
import { requireEnv } from '../lib/run-cli.js';
import type { IdentityUsersStore } from '@hushbox/api/identity';

/** Rows per keyset page. Bounded so one page's crypto work stays small. */
const DEFAULT_BATCH_SIZE = 200;

/** One user's sealed blobs, as the pass reads them. */
export interface ResealRow {
  readonly id: string;
  readonly opaqueServerMaterial: Uint8Array;
  readonly opaqueKekFingerprint: Uint8Array;
  readonly totpSecretEncrypted: Uint8Array | null;
  /**
   * Whether the second factor is live. False with a blob still present is the
   * cleared state the admin clear-stranded operation leaves behind, which the
   * TOTP half treats differently from an enabled row it cannot open.
   */
  readonly totpEnabled: boolean;
}

/** `already-done`: the stored blob was no longer the observed one. */
export type ResealWriteOutcome = 'resealed' | 'already-done';

/**
 * The database surface the pass needs, as plain promises. The identity slice
 * owns `users`, so the production implementation is its store
 * ({@link identityResealStore}); tests pass an in-memory one.
 */
export interface ResealStore {
  readBatch(afterId: string | null, limit: number): Promise<readonly ResealRow[]>;
  resealMaterial(
    userId: string,
    observed: Uint8Array,
    next: Uint8Array,
    fingerprint: Uint8Array
  ): Promise<ResealWriteOutcome>;
  resealTotp(userId: string, observed: Uint8Array, next: Uint8Array): Promise<ResealWriteOutcome>;
}

interface ResealSecrets {
  readonly opaqueKek: string;
  readonly opaqueKekNext: string;
  readonly totpEncryptionSecret: string;
  readonly totpEncryptionSecretNext: string;
}

interface ResealCounts {
  readonly scanned: number;
  readonly materialResealed: number;
  readonly materialSkipped: number;
  readonly totpResealed: number;
  readonly totpSkipped: number;
  /** Cleared second factors sealed under a key nothing here holds; left as they are. */
  readonly totpClearedUnreadable: number;
  /** Rows still on some other key once the pass has run; non-zero fails the run. */
  readonly remaining: number;
}

const REQUIRED_SECRETS = [
  'OPAQUE_KEK',
  'OPAQUE_KEK_NEXT',
  'TOTP_ENCRYPTION_SECRET',
  'TOTP_ENCRYPTION_SECRET_NEXT',
] as const;

/**
 * Why this run refuses, or null to proceed — decided before any connection is
 * opened. Which half then moves is not returned, because nothing decides it:
 * the pass derives its keys from the secrets themselves, and a `_NEXT` holding
 * the value already live derives the same key, so every row of that half is
 * already on its fingerprint. A `_NEXT` carries the live value rather than
 * nothing because the runner refuses an empty secret; both halves standing
 * still is the refusal, because it is the shape a mistyped rotation takes.
 */
export function rotationRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  for (const name of REQUIRED_SECRETS) {
    const value = env[name];
    if (value === undefined || value === '') {
      return `${name} is required to re-seal; refusing before touching the database.`;
    }
  }
  if (
    env['OPAQUE_KEK_NEXT'] === env['OPAQUE_KEK'] &&
    env['TOTP_ENCRYPTION_SECRET_NEXT'] === env['TOTP_ENCRYPTION_SECRET']
  ) {
    return (
      'Neither OPAQUE_KEK_NEXT nor TOTP_ENCRYPTION_SECRET_NEXT names a new value; ' +
      'nothing to rotate, refusing before touching the database.'
    );
  }
  return null;
}

export function secretsFromEnv(env: Readonly<Record<string, string | undefined>>): ResealSecrets {
  return {
    opaqueKek: requireEnv('OPAQUE_KEK', env),
    opaqueKekNext: requireEnv('OPAQUE_KEK_NEXT', env),
    totpEncryptionSecret: requireEnv('TOTP_ENCRYPTION_SECRET', env),
    totpEncryptionSecretNext: requireEnv('TOTP_ENCRYPTION_SECRET_NEXT', env),
  };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** The key id a stored TOTP blob carries in the clear, at its head. */
function totpBlobKeyId(blob: Uint8Array): Uint8Array {
  return blob.subarray(0, FINGERPRINT_BYTES);
}

/**
 * The keys both halves of a pass work with. Derived once: each derivation is an
 * HKDF over a secret, and repeating it per row would dominate the run.
 */
function keysFor(secrets: ResealSecrets): {
  readonly kek: ReturnType<typeof deriveOpaqueKek>;
  readonly nextKek: ReturnType<typeof deriveOpaqueKek>;
  readonly nextKekFingerprint: Uint8Array;
  readonly totpKey: ReturnType<typeof deriveTotpEncryptionKey>;
  readonly totpFingerprint: Uint8Array;
  readonly nextTotpKey: ReturnType<typeof deriveTotpEncryptionKey>;
  readonly nextTotpFingerprint: Uint8Array;
} {
  const nextKek = deriveOpaqueKek(textEncoder.encode(secrets.opaqueKekNext));
  const nextTotpKey = deriveTotpEncryptionKey(textEncoder.encode(secrets.totpEncryptionSecretNext));
  const totpKey = deriveTotpEncryptionKey(textEncoder.encode(secrets.totpEncryptionSecret));
  return {
    kek: deriveOpaqueKek(textEncoder.encode(secrets.opaqueKek)),
    nextKek,
    nextKekFingerprint: opaqueKekFingerprint(nextKek),
    totpKey,
    totpFingerprint: totpKeyFingerprint(totpKey),
    nextTotpKey,
    nextTotpFingerprint: totpKeyFingerprint(nextTotpKey),
  };
}

/**
 * A blob that will not open under the live key means the key and the rows
 * disagree — an operator condition, and continuing would re-seal only the rows
 * that happen to match. The message carries counts and the name of the secret
 * to check, never a user id.
 */
function abortUnreadable(secretName: string, scanned: number, resealed: number): never {
  throw new Error(
    `Re-seal aborted: 1 row could not be opened under the live ${secretName} ` +
      `(${String(scanned)} rows scanned, ${String(resealed)} re-sealed). ` +
      `Check that ${secretName} is the value those rows were sealed under.`
  );
}

interface PassCounts {
  scanned: number;
  materialResealed: number;
  materialSkipped: number;
  totpResealed: number;
  totpSkipped: number;
  totpClearedUnreadable: number;
}

async function resealMaterialOf(
  row: ResealRow,
  store: ResealStore,
  keys: ReturnType<typeof keysFor>,
  counts: PassCounts
): Promise<void> {
  if (sameBytes(row.opaqueKekFingerprint, keys.nextKekFingerprint)) {
    counts.materialSkipped += 1;
    return;
  }
  let material;
  try {
    material = openServerMaterial(keys.kek, row.id, row.opaqueServerMaterial);
  } catch (error) {
    if (error instanceof UnknownKeyVersionError) {
      abortUnreadable('OPAQUE_KEK', counts.scanned, counts.materialResealed);
    }
    throw error;
  }
  const outcome = await store.resealMaterial(
    row.id,
    row.opaqueServerMaterial,
    sealServerMaterial(keys.nextKek, row.id, material),
    keys.nextKekFingerprint
  );
  if (outcome === 'resealed') counts.materialResealed += 1;
  else counts.materialSkipped += 1;
}

/**
 * Where a stored TOTP blob stands against this run's two keys, read off the key
 * id it carries in the clear — the same comparison `decryptTotpSecret` makes
 * before it opens anything, so `unreadable` means no key this run holds opens
 * the blob (a truncated one included).
 */
type TotpBlobState = 'on-next' | 'on-live' | 'unreadable';

function totpBlobState(blob: Uint8Array, keys: ReturnType<typeof keysFor>): TotpBlobState {
  const keyId = totpBlobKeyId(blob);
  if (sameBytes(keyId, keys.nextTotpFingerprint)) return 'on-next';
  if (sameBytes(keyId, keys.totpFingerprint)) return 'on-live';
  return 'unreadable';
}

/**
 * Whether an unreadable blob is the operator condition that stops the run. A
 * cleared second factor keeps its ciphertext only so the admin clear
 * operation's inverse has something to restore, and that ciphertext is
 * unreadable by construction — aborting on it would let one use of that
 * fallback block every later rotation with no in-code way out. An enabled
 * factor nobody can open is the genuine key-and-rows disagreement.
 */
function unreadableBlobAborts(row: ResealRow): boolean {
  return row.totpEnabled;
}

async function resealTotpOf(
  row: ResealRow,
  store: ResealStore,
  keys: ReturnType<typeof keysFor>,
  counts: PassCounts
): Promise<void> {
  const blob = row.totpSecretEncrypted;
  if (blob === null) return;
  const state = totpBlobState(blob, keys);
  if (state === 'on-next') {
    counts.totpSkipped += 1;
    return;
  }
  if (state === 'unreadable') {
    if (unreadableBlobAborts(row)) {
      abortUnreadable('TOTP_ENCRYPTION_SECRET', counts.scanned, counts.totpResealed);
    }
    counts.totpClearedUnreadable += 1;
    return;
  }
  // A cleared factor whose blob does open is re-sealed like any other: the
  // per-user clear also clears rows under the live key, and restoring one must
  // yield a working second factor rather than a stranded one.
  const secret = decryptTotpSecret(keys.totpKey, row.id, blob);
  const outcome = await store.resealTotp(
    row.id,
    blob,
    encryptTotpSecret(keys.nextTotpKey, row.id, secret)
  );
  if (outcome === 'resealed') counts.totpResealed += 1;
  else counts.totpSkipped += 1;
}

/**
 * Whether a row's TOTP blob is one the run still owes work on: it is not yet on
 * the next key and it is not the cleared-and-unreadable state the pass skips.
 * The same split the pass applies, so a skipped row cannot hold the exit code
 * non-zero forever.
 */
function totpRemains(row: ResealRow, keys: ReturnType<typeof keysFor>): boolean {
  const blob = row.totpSecretEncrypted;
  if (blob === null) return false;
  const state = totpBlobState(blob, keys);
  if (state === 'on-next') return false;
  return state === 'on-live' || unreadableBlobAborts(row);
}

/**
 * Rows still sealed under some other key. Read back rather than inferred from
 * the pass's own outcomes: a row another writer moved between the read and the
 * compare-and-swap is `already-done` to the pass and still needs a re-seal, and
 * this is what makes the run's exit code answer the question the operator asks.
 */
async function countRemaining(
  store: ResealStore,
  keys: ReturnType<typeof keysFor>,
  limit: number
): Promise<number> {
  let cursor: string | null = null;
  let remaining = 0;
  for (;;) {
    const rows = await store.readBatch(cursor, limit);
    const last = rows.at(-1);
    if (last === undefined) return remaining;
    for (const row of rows) {
      const materialStale = !sameBytes(row.opaqueKekFingerprint, keys.nextKekFingerprint);
      if (materialStale || totpRemains(row, keys)) remaining += 1;
    }
    cursor = last.id;
  }
}

/**
 * One pass over every user row. Which halves move is decided by the secrets
 * themselves: a `_NEXT` equal to the live value derives the same key, so every
 * row is already on its fingerprint and skips.
 */
export async function resealServerKeys(input: {
  readonly store: ResealStore;
  readonly secrets: ResealSecrets;
  readonly batchSize?: number;
}): Promise<ResealCounts> {
  const keys = keysFor(input.secrets);
  const limit = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const counts: PassCounts = {
    scanned: 0,
    materialResealed: 0,
    materialSkipped: 0,
    totpResealed: 0,
    totpSkipped: 0,
    totpClearedUnreadable: 0,
  };

  let cursor: string | null = null;
  for (;;) {
    const rows = await input.store.readBatch(cursor, limit);
    const last = rows.at(-1);
    if (last === undefined) break;
    for (const row of rows) {
      counts.scanned += 1;
      await resealMaterialOf(row, input.store, keys, counts);
      await resealTotpOf(row, input.store, keys, counts);
    }
    cursor = last.id;
  }

  return { ...counts, remaining: await countRemaining(input.store, keys, limit) };
}

/**
 * The store's typed Result channel, named structurally: `neverthrow` is the
 * identity slice's dependency, not this tree's, and `match` is the member both
 * variants carry.
 */
interface StoreResult<T> {
  match<A>(onValue: (value: T) => A, onError: (error: unknown) => A): Promise<A>;
}

/**
 * What the identity slice's `DomainError` publishes: a taxonomy code and a
 * message that is operator-safe by that slice's doctrine. Named structurally
 * for the same reason {@link StoreResult} is.
 */
interface StoreError {
  readonly code: string;
  readonly message: string;
}

function asStoreError(error: unknown): StoreError | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : null;
}

/**
 * Unwraps that channel: an infra failure aborts the run rather than skipping a
 * row, naming the store's own code and message so the abort says what went
 * wrong. The `DomainError`'s `cause` is deliberately not chained: it is the raw
 * driver error, which can quote the row bytes a failing statement carried, and
 * an unhandled rejection would print it. Async so the refusal is a rejection
 * whether the store's `match` calls back synchronously or not.
 */
async function must<T>(pending: StoreResult<T>): Promise<T> {
  return pending.match(
    (value) => value,
    (error: unknown): never => {
      const detail = asStoreError(error);
      const named = detail === null ? 'unknown error' : `${detail.code}: ${detail.message}`;
      throw new Error(
        `Re-seal aborted: the identity store failed to read or write a row (${named}).`
      );
    }
  );
}

/** The identity slice's store, narrowed to what the pass uses. */
export function identityResealStore(users: IdentityUsersStore): ResealStore {
  return {
    readBatch: (afterId, limit) => must(users.readServerMaterialBatch(afterId, limit)),
    resealMaterial: (userId, observed, next, fingerprint) =>
      must(users.resealServerMaterial(userId, observed, next, fingerprint)),
    resealTotp: (userId, observed, next) => must(users.resealTotpSecret(userId, observed, next)),
  };
}

/* v8 ignore start -- CLI entry point: real env reads, a real database, process.exit */
async function main(): Promise<void> {
  const refusal = rotationRefusal(process.env);
  if (refusal !== null) {
    console.error(refusal);
    process.exit(1);
  }
  const databaseUrl = requireEnv('DATABASE_URL');
  // Local runs reach Postgres through the neon-proxy container; production
  // dials Neon directly.
  const isProduction = createEnvUtilities(process.env).isProduction;
  const db = isProduction
    ? createDb(databaseUrl)
    : createDb(databaseUrl, { neonDev: LOCAL_NEON_DEV_CONFIG });

  try {
    const counts = await resealServerKeys({
      store: identityResealStore(createIdentityStores(db).users),
      secrets: secretsFromEnv(process.env),
    });
    console.log(
      `Server material: ${String(counts.materialResealed)} re-sealed, ` +
        `${String(counts.materialSkipped)} already on the next key.`
    );
    console.log(
      `TOTP secrets: ${String(counts.totpResealed)} re-sealed, ` +
        `${String(counts.totpSkipped)} already on the next key, ` +
        `${String(counts.totpClearedUnreadable)} cleared and unreadable.`
    );
    console.log(`Rows scanned: ${String(counts.scanned)}. Remaining: ${String(counts.remaining)}.`);
    if (counts.remaining > 0) {
      console.error('Rows remain on another key; run this script again.');
      process.exit(1);
    }
  } finally {
    await db.$client.end();
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  void main();
}
/* v8 ignore stop */
