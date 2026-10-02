import * as crypto from 'node:crypto';
import * as os from 'node:os';
import {
  createAccount,
  createOpaqueClient,
  createOpaqueServer,
  deriveServerMaterial,
  finishRegistration,
  OpaqueClientConfig,
  OpaqueRegistrationRequest,
  OPAQUE_SERVER_IDENTIFIER,
  startRegistration,
} from '@hushbox/crypto';
import {
  cacheKey,
  decodePersonaCrypto,
  encodePersonaCrypto,
  readCache,
  writeCache,
  type CacheContents,
  type CachedPersonaCrypto,
  type CryptoBytes,
} from './crypto-cache.js';
import type { ServerMaterial } from '@hushbox/crypto';

export interface PersonaCryptoRequest {
  credentialIdentifier: string;
  password: string;
}

export interface PersonaCryptoResult {
  credentialIdentifier: string;
  opaqueRegistration: Uint8Array;
  publicKey: Uint8Array;
  passwordWrappedPrivateKey: Uint8Array;
  recoveryWrappedPrivateKey: Uint8Array;
  recoveryPublicKey: Uint8Array;
}

/** A persona's cached bytes plus the server material its registration record is bound to. */
interface PersonaCrypto extends CryptoBytes {
  serverMaterial: ServerMaterial;
}

export type ChunkRunner = (
  chunk: PersonaCryptoRequest[],
  opaqueKekSecret: string
) => Promise<PersonaCryptoResult[]>;

interface PoolOptions {
  cacheFile: string;
  cacheVersion: string;
  cryptoFingerprint: string;
  /** The development `OPAQUE_KEK` value; every persona's server material derives from it. */
  opaqueKekSecret: string;
  workerCount?: number;
  runChunk?: ChunkRunner;
}

/**
 * HKDF info label for the per-persona secret a seeded persona's server
 * material derives from. Seed-only: a real account's material is minted at
 * registration, never derived, so the label has no caller outside this pool.
 */
const PERSONA_MATERIAL_INFO = 'hushbox/seed-persona-server-material';

/**
 * Derived rather than minted so the cached registration record stays valid
 * across seed runs: random material would bind each record to bytes no later
 * run could reproduce, and a seeded persona could never log in again. The
 * persona's credential identifier is the salt, so no two personas share
 * material under one KEK.
 */
export async function derivePersonaServerMaterial(
  opaqueKekSecret: string,
  credentialIdentifier: string
): Promise<ServerMaterial> {
  const secret = new Uint8Array(
    crypto.hkdfSync('sha256', opaqueKekSecret, credentialIdentifier, PERSONA_MATERIAL_INFO, 32)
  );
  return deriveServerMaterial(secret);
}

export function chunkRequests<T>(items: T[], chunkCount: number): T[][] {
  if (items.length === 0) return [];
  const actualChunks = Math.min(chunkCount, items.length);
  const chunks: T[][] = Array.from({ length: actualChunks }, () => []);
  for (const [index, item] of items.entries()) {
    const bucket = chunks[index % actualChunks];
    /* v8 ignore next -- index % actualChunks is always a valid chunk index */
    if (bucket) bucket.push(item);
  }
  return chunks;
}

interface CacheSplit {
  hits: Map<string, CryptoBytes>;
  misses: PersonaCryptoRequest[];
  keyByCredId: Map<string, string>;
}

/**
 * Wholesale invalidation: reuse the loaded entries only when the file's stored
 * `(cacheVersion, cryptoFingerprint)` exactly matches this run's, otherwise
 * start empty so every stale entry is dropped. On a match the loaded map is
 * carried forward, so two runs against the same file accumulate.
 */
function selectEffectiveEntries(
  loaded: CacheContents,
  options: PoolOptions
): Map<string, CachedPersonaCrypto> {
  if (loaded.cacheVersion !== options.cacheVersion) return new Map();
  if (loaded.cryptoFingerprint !== options.cryptoFingerprint) return new Map();
  return loaded.entries;
}

function splitByCache(
  requests: PersonaCryptoRequest[],
  options: PoolOptions,
  effectiveEntries: Map<string, CachedPersonaCrypto>
): CacheSplit {
  const hits = new Map<string, CryptoBytes>();
  const misses: PersonaCryptoRequest[] = [];
  const keyByCredId = new Map<string, string>();

  for (const req of requests) {
    const key = cacheKey({
      cacheVersion: options.cacheVersion,
      cryptoFingerprint: options.cryptoFingerprint,
      opaqueKekSecret: options.opaqueKekSecret,
      password: req.password,
      credentialIdentifier: req.credentialIdentifier,
    });
    keyByCredId.set(req.credentialIdentifier, key);

    const cached = effectiveEntries.get(key);
    if (cached) {
      hits.set(req.credentialIdentifier, decodePersonaCrypto(cached));
    } else {
      misses.push(req);
    }
  }
  return { hits, misses, keyByCredId };
}

/**
 * Fold one computed result into the run's in-memory map. Adds to
 * `effectiveEntries` (the post-invalidation map, which may already hold other
 * calls' still-valid entries) rather than replacing it, so the eventual write
 * merges instead of clobbering.
 */
function addResult(
  result: PersonaCryptoResult,
  keyByCredId: Map<string, string>,
  effectiveEntries: Map<string, CachedPersonaCrypto>,
  hits: Map<string, CryptoBytes>
): void {
  const key = keyByCredId.get(result.credentialIdentifier);
  /* v8 ignore next 4 -- defensive: every result's credentialIdentifier originates from a keyed request */
  if (!key) {
    throw new Error(
      `seed-crypto-pool: unexpected credentialIdentifier "${result.credentialIdentifier}"`
    );
  }
  const entry = encodePersonaCrypto(
    {
      opaqueRegistration: result.opaqueRegistration,
      publicKey: result.publicKey,
      passwordWrappedPrivateKey: result.passwordWrappedPrivateKey,
      recoveryWrappedPrivateKey: result.recoveryWrappedPrivateKey,
      recoveryPublicKey: result.recoveryPublicKey,
    },
    key,
    result.credentialIdentifier
  );
  effectiveEntries.set(key, entry);
  hits.set(result.credentialIdentifier, decodePersonaCrypto(entry));
}

async function attachServerMaterial(
  hits: Map<string, CryptoBytes>,
  opaqueKekSecret: string
): Promise<Map<string, PersonaCrypto>> {
  const out = new Map<string, PersonaCrypto>();
  for (const [credentialIdentifier, bytes] of hits) {
    out.set(credentialIdentifier, {
      ...bytes,
      serverMaterial: await derivePersonaServerMaterial(opaqueKekSecret, credentialIdentifier),
    });
  }
  return out;
}

export async function ensurePersonaCrypto(
  requests: PersonaCryptoRequest[],
  options: PoolOptions
): Promise<Map<string, PersonaCrypto>> {
  if (requests.length === 0) return new Map();

  const loaded = await readCache(options.cacheFile);
  const effectiveEntries = selectEffectiveEntries(loaded, options);
  const { hits, misses, keyByCredId } = splitByCache(requests, options, effectiveEntries);
  if (misses.length === 0) return attachServerMaterial(hits, options.opaqueKekSecret);

  const chunkCount = options.workerCount ?? Math.max(1, os.cpus().length - 1);
  const chunks = chunkRequests(misses, chunkCount);
  /* v8 ignore next -- the default runner (real OPAQUE worker crypto) is exercised by the seed run, not unit tests */
  const runChunk = options.runChunk ?? defaultRunChunk;

  const chunkResults = await Promise.all(
    chunks.map((chunk) => runChunk(chunk, options.opaqueKekSecret))
  );

  // The written map is the post-invalidation effective map plus this run's new
  // entries — never only this run's keys — so still-valid siblings from other
  // calls survive the rewrite.
  for (const result of chunkResults.flat()) {
    addResult(result, keyByCredId, effectiveEntries, hits);
  }

  writeCache(options.cacheFile, {
    cacheVersion: options.cacheVersion,
    cryptoFingerprint: options.cryptoFingerprint,
    entries: effectiveEntries,
  });

  return attachServerMaterial(hits, options.opaqueKekSecret);
}

/* v8 ignore start -- exercised via integration runs of seed:cache, not unit tests */
async function generateOne(
  req: PersonaCryptoRequest,
  opaqueKekSecret: string
): Promise<PersonaCryptoResult> {
  const opaqueServer = createOpaqueServer(
    await derivePersonaServerMaterial(opaqueKekSecret, req.credentialIdentifier),
    OPAQUE_SERVER_IDENTIFIER
  );
  const client = createOpaqueClient();
  const { serialized } = await startRegistration(client, req.password);

  const request = OpaqueRegistrationRequest.deserialize(OpaqueClientConfig, serialized);
  const serverResult = await opaqueServer.registerInit(request, req.credentialIdentifier);
  if (serverResult instanceof Error) throw serverResult;

  const { record, exportKey } = await finishRegistration(
    client,
    serverResult.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );

  const account = await createAccount(new Uint8Array(exportKey));

  return {
    credentialIdentifier: req.credentialIdentifier,
    opaqueRegistration: new Uint8Array(record),
    publicKey: account.publicKey,
    passwordWrappedPrivateKey: account.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: account.recoveryWrappedPrivateKey,
    recoveryPublicKey: account.recoveryPublicKey,
  };
}

// Sequential within a chunk: the caller already runs every chunk concurrently,
// so in-flight work is bounded by chunk count. Mapping this with Promise.all
// silently defeated that — every persona in the chunk started at once, making
// total concurrency the persona count rather than the worker count. Each
// persona holds Argon2id (64 MiB) plus OPAQUE's scrypt (~32 MiB) live at the
// same time, so a cold cache demanded tens of GB and drove the box into swap.
// Nothing is gained by the wider fan-out: this work is CPU-bound.
const defaultRunChunk: ChunkRunner = async (chunk, opaqueKekSecret) => {
  const results: PersonaCryptoResult[] = [];
  for (const req of chunk) {
    results.push(await generateOne(req, opaqueKekSecret));
  }
  return results;
};
/* v8 ignore stop */
