import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import {
  artifactCachePath,
  artifactObjectPath,
  artifactSetFingerprint,
  artifactSourceUrl,
  artifactTotalBytes,
  modelWeightsArtifacts,
} from './manifest.js';
import type { Artifact } from './manifest.js';

/**
 * What an existence probe established. `unknown` is its own outcome rather than
 * a thrown error because the three cases lead somewhere different: an absent
 * object is uploaded, a present one is left alone, and an unreadable probe
 * refuses the whole run — a store whose contents cannot be read must never be
 * treated as permission to overwrite an `immutable` URL.
 */
export type ProbeResult =
  | { readonly kind: 'present' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown'; readonly detail: string };

// Wrangler writes SGR colour escapes whether or not anything is reading a
// terminal, so quoting its output verbatim carries them into a log line. The
// escape byte is composed rather than written into a regex literal, which no
// editor renders and no linter accepts.
const ESCAPE = String.fromCodePoint(0x1b);
const ANSI = new RegExp(String.raw`${ESCAPE}\[[0-9;]*m`, 'g');

/**
 * Flattens tool output into something quotable: a workflow annotation is one
 * line, and the blank lines wrangler writes would drop everything after the
 * first out of it.
 */
function oneLine(text: string): string {
  return text.replaceAll(ANSI, '').replaceAll(/\s+/g, ' ').trim();
}

/**
 * Reads one head answer. Only the two statuses that state a fact are read as
 * one: a 403, a 5xx and a redirect all leave the object's existence unknown,
 * and reading any of them as absent would overwrite an address served
 * `immutable` for a year.
 */
export function classifyHeadStatus(status: number): ProbeResult {
  if (status === 200) return { kind: 'present' };
  if (status === 404) return { kind: 'absent' };
  return { kind: 'unknown', detail: `HTTP ${String(status)}` };
}

/** What the probe signs with, and whose account's S3 endpoint it addresses. */
export interface RemoteProbeConfig {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/** The transport one signed head request is issued over. `globalThis.fetch` fits. */
export type SignedFetch = (
  url: string,
  init: { readonly method: string; readonly headers: Record<string, string> }
) => Promise<{ readonly status: number }>;

/** Where an account's buckets answer the S3 API. */
const R2_S3_HOST_SUFFIX = 'r2.cloudflarestorage.com';

/**
 * Stated rather than left to the library: aws4fetch signs an S3 request as
 * UNSIGNED-PAYLOAD when the header is absent.
 */
const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

/**
 * An existence probe over R2's S3 API, which answers from metadata — wrangler
 * offers no head request, so probing through it reads every object's whole body
 * to learn only whether it is there.
 *
 * Everything that is not a plain 200 or 404 — a refused or failed request, a
 * connection that never landed, a URL that could not be signed — comes back
 * unknown, which stops the run.
 */
export function createRemoteProbe(
  config: RemoteProbeConfig,
  fetchImpl: SignedFetch
): (objectPath: string) => Promise<ProbeResult> {
  // aws4fetch keeps the secret on this instance and keys its derived-signing-key
  // cache by it, so inspecting or serializing the client renders the plaintext secret.
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    // R2 is region-less; `auto` is what its S3 API expects in the credential scope.
    region: 'auto',
    // aws4fetch retries 5xx and 429 ten times by default. A retried failure is
    // still unreadable here, and ten of them per object is a slower way to say so.
    retries: 0,
  });

  return async (objectPath) => {
    try {
      const url = `https://${config.accountId}.${R2_S3_HOST_SUFFIX}/${objectPath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/')}`;
      const signed = await aws.sign(url, {
        method: 'HEAD',
        headers: { 'x-amz-content-sha256': EMPTY_PAYLOAD_SHA256 },
      });
      const { status } = await fetchImpl(signed.url, {
        method: 'HEAD',
        headers: Object.fromEntries(signed.headers),
      });
      return classifyHeadStatus(status);
    } catch (error: unknown) {
      return {
        kind: 'unknown',
        detail: oneLine(error instanceof Error ? error.message : String(error)),
      };
    }
  };
}

/** Which environment variable carries each field the probe signs with. */
const PROBE_ENV_NAMES = {
  accountId: 'CLOUDFLARE_ACCOUNT_ID',
  accessKeyId: 'R2_ACCESS_KEY_ID',
  secretAccessKey: 'R2_SECRET_ACCESS_KEY',
} as const;

/**
 * Resolves the probe's credentials once, before the first object, naming every
 * absent one together — fourteen identical signing failures diagnose worse than
 * one refusal. A workflow secret that is not set expands to the empty string
 * rather than to nothing, so an empty value is read as absent.
 */
export function readRemoteProbeConfig(
  env: Readonly<Record<string, string | undefined>>
): RemoteProbeConfig {
  const config: RemoteProbeConfig = {
    accountId: env[PROBE_ENV_NAMES.accountId] ?? '',
    accessKeyId: env[PROBE_ENV_NAMES.accessKeyId] ?? '',
    secretAccessKey: env[PROBE_ENV_NAMES.secretAccessKey] ?? '',
  };

  const missing = Object.entries(PROBE_ENV_NAMES)
    .filter(([field]) => config[field as keyof RemoteProbeConfig] === '')
    .map(([, name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `model weights: the remote publish signs its existence probes, and ` +
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`
    );
  }
  return config;
}

/** The capabilities both the production publish and the local seed need. */
interface ArtifactDeps {
  /** The byte length already cached at that path, or null when nothing is there. */
  cachedBytes: (filePath: string) => Promise<number | null>;
  download: (url: string, filePath: string) => Promise<void>;
  upload: (objectPath: string, filePath: string) => Promise<void>;
  report: (message: string) => void;
}

export interface PublishDeps extends ArtifactDeps {
  probe: (objectPath: string) => Promise<ProbeResult>;
}

export interface SeedDeps extends ArtifactDeps {
  readReceipt: () => Promise<string | null>;
  writeReceipt: (fingerprint: string) => Promise<void>;
}

/**
 * A size a reader can act on. The set spans four orders of magnitude — a
 * 136 MB weights file next to a 132-byte config — so a single unit renders
 * one end of it as zero.
 */
export function humanBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${String(Math.round(bytes / 1_000_000))} MB`;
  if (bytes >= 1000) return `${String(Math.round(bytes / 1000))} KB`;
  return `${String(bytes)} B`;
}

/**
 * Returns the path holding this artifact's bytes, downloading them first unless
 * the cache already holds exactly the declared length. The length is re-read
 * after the download so a truncated body is refused here rather than published
 * to a URL that can never be corrected.
 */
async function ensureCached(
  artifact: Artifact,
  cacheRoot: string,
  deps: ArtifactDeps
): Promise<string> {
  const filePath = artifactCachePath(cacheRoot, artifact);
  if ((await deps.cachedBytes(filePath)) === artifact.bytes) return filePath;

  deps.report(`  downloading ${artifact.file} (${humanBytes(artifact.bytes)})`);
  await deps.download(artifactSourceUrl(artifact), filePath);

  const written = await deps.cachedBytes(filePath);
  if (written !== artifact.bytes) {
    throw new Error(
      `model weights: ${artifact.file} arrived as ${String(written)} bytes where the manifest ` +
        `expected ${String(artifact.bytes)} — refusing to publish a truncated artifact`
    );
  }
  return filePath;
}

/**
 * Mirrors both models into the production bucket, skipping every object that is
 * already there.
 *
 * Every object is probed before anything is downloaded, so the steady state — a
 * store that already holds the whole set — reaches no source repository at all,
 * and one unreadable probe stops the run before a single upload. That keeps
 * "already published" a property of the store rather than of step ordering.
 */
export async function publishToR2(cacheRoot: string, deps: PublishDeps): Promise<void> {
  const artifacts = modelWeightsArtifacts();
  const missing: Artifact[] = [];

  for (const artifact of artifacts) {
    const objectPath = artifactObjectPath(artifact);
    const probe = await deps.probe(objectPath);
    if (probe.kind === 'unknown') {
      throw new Error(
        `model weights: the existence probe for ${objectPath} failed, so whether it is already ` +
          `published is unknown; refusing to upload. The store answered: ${probe.detail}`
      );
    }
    if (probe.kind === 'absent') missing.push(artifact);
  }

  if (missing.length === 0) {
    deps.report(`All ${String(artifacts.length)} model-weights objects are already published.`);
    return;
  }

  deps.report(
    `Publishing ${String(missing.length)} of ${String(artifacts.length)} model-weights objects ` +
      `(${humanBytes(artifactTotalBytes(missing))}).`
  );
  for (const artifact of missing) {
    const objectPath = artifactObjectPath(artifact);
    await deps.upload(objectPath, await ensureCached(artifact, cacheRoot, deps));
    deps.report(`Published ${objectPath}`);
  }
}

/**
 * Fills the local R2 simulator so `pnpm dev` serves the same objects production
 * does.
 *
 * Idempotence rests on a recorded fingerprint rather than on probing, because
 * probing would spawn wrangler once per object on every stack start; a matching
 * record costs one file read. The record is written only after every upload
 * succeeds, so an interrupted seed retries instead of being remembered as done.
 *
 * `artifacts` defaults to the full set (both models); a caller seeding a
 * narrower environment — one that will never exercise every model — passes
 * its own subset, which is what the fingerprint and receipt then key on.
 */
export async function seedLocalStore(
  cacheRoot: string,
  deps: SeedDeps,
  artifacts: readonly Artifact[] = modelWeightsArtifacts()
): Promise<void> {
  const fingerprint = artifactSetFingerprint(artifacts);

  if ((await deps.readReceipt()) === fingerprint) {
    deps.report('On-device model weights: local R2 store already seeded.');
    return;
  }

  deps.report(
    `Seeding ${String(artifacts.length)} on-device model-weights objects ` +
      `(${humanBytes(artifactTotalBytes(artifacts))}) into the local R2 store. ` +
      `One time — later stack starts reuse it.`
  );
  for (const artifact of artifacts) {
    await deps.upload(artifactObjectPath(artifact), await ensureCached(artifact, cacheRoot, deps));
  }
  await deps.writeReceipt(fingerprint);
  deps.report('On-device model weights: local R2 store seeded.');
}

/**
 * What a developer is told when the local store could not be filled. The
 * feature it feeds degrades with no error surface anywhere, by design, so this
 * is the only place its absence is ever explained — hence the cause, the
 * consequence and the repair, rather than a one-line warning.
 */
export function emptyStoreNotice(cause: string): string {
  return [
    'On-device model weights were NOT seeded into the local R2 store.',
    `  cause:  ${oneLine(cause)}`,
    '  effect: GET /models/:model/:version/:file answers 404 locally, so in-browser',
    '          autocomplete and read-aloud stay silent. Both degrade silently by',
    '          design — nothing in the UI or the console will report this.',
    '  fix:    clear the cause above, then re-run `pnpm weights:seed`.',
  ].join('\n');
}
