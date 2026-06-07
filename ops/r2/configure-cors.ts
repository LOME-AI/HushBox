#!/usr/bin/env tsx
/**
 * Configure CORS on the production R2 media bucket.
 *
 * Browsers fetching presigned download URLs from `*.r2.cloudflarestorage.com`
 * are subject to CORS preflight against the bucket's CORS rule set. This
 * script sets a single read-only rule allowing the production frontends to
 * GET from the bucket. PutBucketCors replaces the rule set wholesale, so
 * re-runs are idempotent.
 *
 * Triggered in CI by the `run-script:configure-r2-cors` PR label; see
 * `ops/README.md` for the full label-driven flow. May also be invoked
 * locally with the relevant R2 env vars set.
 *
 * The script is dependency-injected at the AwsClient boundary so tests can
 * mock the signing/fetch surface without real credentials.
 */
import { parseOrExit } from '../lib/run-cli.js';

/**
 * Production allowed origins. Aligns with the marketing site (`hushbox.ai`)
 * and Cloudflare Pages preview deployments. Add new origins here when new
 * frontends ship.
 *
 * The `localhost` entries are the Capacitor WebView origins (Android serves
 * from `http://localhost` per `androidScheme`, iOS from `capacitor://localhost`).
 * The native app fetches presigned R2 download URLs from these origins and is
 * CORS-checked like a browser (CapacitorHttp is disabled, so `fetch` is not
 * proxied natively). Keep in sync with `CAPACITOR_ORIGINS` in the API CORS
 * middleware (`apps/api/src/middleware/cors.ts`).
 */
export const PRODUCTION_ALLOWED_ORIGINS: readonly string[] = [
  'https://hushbox.ai',
  'https://*.hushbox.pages.dev',
  'capacitor://localhost',
  'http://localhost',
];

const DEFAULT_METHODS: readonly string[] = ['GET'];
const DEFAULT_ALLOWED_HEADERS: readonly string[] = ['*'];
const DEFAULT_MAX_AGE_SECONDS = 3600;

/**
 * Subset of env vars required to authenticate against R2 via the S3 API.
 *
 * Bucket-config operations like PutBucketCors require a bucket-admin token, so
 * this script reads the dedicated `R2_ADMIN_*` credentials (Destination.Ops in
 * env.config) rather than the object-scoped `R2_ACCESS_KEY_ID` the runtime
 * Worker uses.
 */
export interface R2Env {
  R2_S3_ENDPOINT: string;
  R2_ADMIN_ACCESS_KEY_ID: string;
  R2_ADMIN_SECRET_ACCESS_KEY: string;
  R2_BUCKET_MEDIA: string;
}

/**
 * Pre-validated env input. Values may be undefined or empty; `requireEnv`
 * normalizes both to a thrown error. Modeled explicitly rather than as
 * `Partial<R2Env>` because `exactOptionalPropertyTypes: true` rejects the
 * implicit `string | undefined` property shape.
 */
export interface R2EnvInput {
  R2_S3_ENDPOINT: string | undefined;
  R2_ADMIN_ACCESS_KEY_ID: string | undefined;
  R2_ADMIN_SECRET_ACCESS_KEY: string | undefined;
  R2_BUCKET_MEDIA: string | undefined;
}

export interface BuildCorsXmlInput {
  origins: readonly string[];
  methods: readonly string[];
  allowedHeaders: readonly string[];
  maxAgeSeconds: number;
}

const XML_ENTITY_RE = /[&<>"']/g;
const XML_ENTITY_MAP: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(value: string): string {
  return value.replaceAll(XML_ENTITY_RE, (c) => XML_ENTITY_MAP[c] ?? c);
}

/**
 * Build the S3-format `<CORSConfiguration>` XML body. R2 accepts the same
 * dialect as AWS S3.
 */
export function buildCorsXml(input: BuildCorsXmlInput): string {
  const originTags = input.origins
    .map((o) => `<AllowedOrigin>${escapeXml(o)}</AllowedOrigin>`)
    .join('');
  const methodTags = input.methods
    .map((m) => `<AllowedMethod>${escapeXml(m)}</AllowedMethod>`)
    .join('');
  const headerTags = input.allowedHeaders
    .map((h) => `<AllowedHeader>${escapeXml(h)}</AllowedHeader>`)
    .join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<CORSConfiguration>',
    '<CORSRule>',
    originTags,
    methodTags,
    headerTags,
    `<MaxAgeSeconds>${String(input.maxAgeSeconds)}</MaxAgeSeconds>`,
    '</CORSRule>',
    '</CORSConfiguration>',
  ].join('');
}

/**
 * Boundary that the test mocks. Production passes a real `AwsClient` from
 * `aws4fetch`; tests pass a stub that records the URL and body.
 */
export interface AwsClientLike {
  fetch(url: string, init?: { method?: string; body?: string }): Promise<Response>;
}

export type AwsClientFactory = (options: {
  accessKeyId: string;
  secretAccessKey: string;
  service: string;
  region: string;
}) => AwsClientLike;

export interface ConfigureR2CorsDeps {
  env: R2EnvInput;
  createClient: AwsClientFactory;
  origins?: readonly string[];
}

function requireEnv(env: R2EnvInput): R2Env {
  if (env.R2_S3_ENDPOINT === undefined || env.R2_S3_ENDPOINT.length === 0) {
    throw new Error('R2_S3_ENDPOINT is required to configure R2 CORS');
  }
  if (env.R2_ADMIN_ACCESS_KEY_ID === undefined || env.R2_ADMIN_ACCESS_KEY_ID.length === 0) {
    throw new Error('R2_ADMIN_ACCESS_KEY_ID is required to configure R2 CORS');
  }
  if (env.R2_ADMIN_SECRET_ACCESS_KEY === undefined || env.R2_ADMIN_SECRET_ACCESS_KEY.length === 0) {
    throw new Error('R2_ADMIN_SECRET_ACCESS_KEY is required to configure R2 CORS');
  }
  if (env.R2_BUCKET_MEDIA === undefined || env.R2_BUCKET_MEDIA.length === 0) {
    throw new Error('R2_BUCKET_MEDIA is required to configure R2 CORS');
  }
  return {
    R2_S3_ENDPOINT: env.R2_S3_ENDPOINT,
    R2_ADMIN_ACCESS_KEY_ID: env.R2_ADMIN_ACCESS_KEY_ID,
    R2_ADMIN_SECRET_ACCESS_KEY: env.R2_ADMIN_SECRET_ACCESS_KEY,
    R2_BUCKET_MEDIA: env.R2_BUCKET_MEDIA,
  };
}

/**
 * Apply the configured CORS rule to the R2 bucket. Throws on any failure so
 * the deploy script halts rather than silently leaving the bucket misconfigured.
 */
export async function configureR2Cors(deps: ConfigureR2CorsDeps): Promise<void> {
  const env = requireEnv(deps.env);
  const origins = deps.origins ?? PRODUCTION_ALLOWED_ORIGINS;

  const client = deps.createClient({
    accessKeyId: env.R2_ADMIN_ACCESS_KEY_ID,
    secretAccessKey: env.R2_ADMIN_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto',
  });

  const body = buildCorsXml({
    origins,
    methods: DEFAULT_METHODS,
    allowedHeaders: DEFAULT_ALLOWED_HEADERS,
    maxAgeSeconds: DEFAULT_MAX_AGE_SECONDS,
  });

  const base = env.R2_S3_ENDPOINT.replace(/\/+$/, '');
  const url = `${base}/${env.R2_BUCKET_MEDIA}?cors`;

  const response = await client.fetch(url, { method: 'PUT', body });
  if (!response.ok) {
    const text = await response.text().catch(() => '<unreadable body>');
    throw new Error(`PutBucketCors returned ${String(response.status)}: ${text}`);
  }
}

export interface ParsedCliArgs {
  origins: readonly string[];
}

export function parseCliArgs(args: string[]): ParsedCliArgs | { error: string } {
  const originsArgument = args.find((a) => a.startsWith('--origins='));
  if (originsArgument === undefined) {
    return { origins: PRODUCTION_ALLOWED_ORIGINS };
  }
  const raw = originsArgument.slice('--origins='.length);
  if (raw.length === 0) {
    return { error: 'Usage: --origins=https://a.example,https://b.example' };
  }
  const parsed = raw.split(',').map((s) => s.trim());
  if (parsed.some((p) => p.length === 0)) {
    return { error: 'Usage: --origins=https://a.example,https://b.example' };
  }
  return { origins: parsed };
}

/* v8 ignore start -- CLI entry point uses process.exit and pulls real creds from env */
async function main(): Promise<void> {
  const parsed = parseOrExit(parseCliArgs);

  const env: R2EnvInput = {
    R2_S3_ENDPOINT: process.env['R2_S3_ENDPOINT'],
    R2_ADMIN_ACCESS_KEY_ID: process.env['R2_ADMIN_ACCESS_KEY_ID'],
    R2_ADMIN_SECRET_ACCESS_KEY: process.env['R2_ADMIN_SECRET_ACCESS_KEY'],
    R2_BUCKET_MEDIA: process.env['R2_BUCKET_MEDIA'],
  };

  // Load aws4fetch lazily so the test never instantiates the real client.
  const { AwsClient } = await import('aws4fetch');

  await configureR2Cors({
    env,
    createClient: (options) => new AwsClient(options),
    origins: parsed.origins,
  });

  console.log(`Applied CORS rule to bucket "${env.R2_BUCKET_MEDIA ?? '<unset>'}"`);
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  void main();
}
/* v8 ignore stop */
