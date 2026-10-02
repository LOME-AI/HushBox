import { testClient } from 'hono/testing';
import { CLASSIFICATION_VARIABLES } from '@hushbox/shared';
import { createApp } from '../app.js';
import type { EnvContext } from '@hushbox/shared';
import type { AppType } from '../app.js';
import type { Bindings } from '../lib/context/index.js';
import type { TelemetryEnv } from '../lib/telemetry/index.js';

/**
 * Per-slice API smoke convention: when a slice manifest is mounted in
 * `createApp()`, that change ships with one `<slice>.smoke.test.ts` in this
 * directory. Each spec calls `createSmokeHarness()` and exercises the slice's
 * live routes through `client` — the typed `hc`-style client inferred from
 * `AppType` — so every request traverses the complete default-deny pipeline
 * (env → bindings → session → authorize → idempotency) against the real local
 * dev stack (`pnpm db:up`). Use `app.request(path, init, env)` only for probes
 * the typed client cannot express by design (unknown paths, malformed input).
 *
 * This directory is test tooling: it is deliberately absent from the coverage
 * include globs and must never export production code.
 */
export interface SmokeHarness {
  readonly app: AppType;
  readonly client: ReturnType<typeof testClient<AppType>>;
  readonly env: Bindings & TelemetryEnv;
}

type RequiredHarnessBinding =
  | 'NODE_ENV'
  | 'DATABASE_URL'
  | 'UPSTASH_REDIS_REST_URL'
  | 'UPSTASH_REDIS_REST_TOKEN'
  | 'IRON_SESSION_SECRET'
  | 'TELEMETRY_SINKS'
  // The composed pipeline runs CORS first; it fail-fasts on absent web origins.
  | 'FRONTEND_URL'
  | 'MARKETING_URL'
  | 'FRONTEND_PREVIEW_URL';

function readRequiredEnv(name: RequiredHarnessBinding): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `smoke harness: missing ${name}. Run via the package test script ` +
        '(with-env loads apps/api/.dev.vars) with the local dev stack up (pnpm db:up).'
    );
  }
  return value;
}

/** Builds the fully-assembled app with real local bindings + its typed client. */
export function createSmokeHarness(): SmokeHarness {
  // Optional EnvContext signals pass through so envUtils classification in the
  // pipeline matches the invoking process (CI vs local vitest); membership comes
  // from {@link CLASSIFICATION_VARIABLES}, so a name added there reaches the app
  // under smoke test with no edit here.
  const signals: Omit<EnvContext, 'NODE_ENV'> = {};
  for (const name of CLASSIFICATION_VARIABLES) {
    // NODE_ENV is the member that cannot pass conditionally: `createEnvUtilities`
    // throws on an absent one, so the harness claims that failure through
    // {@link readRequiredEnv} and answers it with a message naming what to start.
    if (name === 'NODE_ENV') continue;
    const value = process.env[name];
    if (value !== undefined) {
      signals[name] = value;
    }
  }
  // VITEST sits outside CLASSIFICATION_VARIABLES for the reason
  // `apps/api/src/slices/models/adapters/integration.setup.ts` records: the
  // vitest runner sets it and no registry mode declares it, so it is not
  // something a mode's silence can speak for.
  const vitest = process.env['VITEST'];
  if (vitest !== undefined) {
    signals.VITEST = vitest;
  }

  const env: Bindings &
    TelemetryEnv & {
      FRONTEND_URL: string;
      MARKETING_URL: string;
      FRONTEND_PREVIEW_URL: string;
    } = {
    NODE_ENV: readRequiredEnv('NODE_ENV'),
    DATABASE_URL: readRequiredEnv('DATABASE_URL'),
    UPSTASH_REDIS_REST_URL: readRequiredEnv('UPSTASH_REDIS_REST_URL'),
    UPSTASH_REDIS_REST_TOKEN: readRequiredEnv('UPSTASH_REDIS_REST_TOKEN'),
    IRON_SESSION_SECRET: readRequiredEnv('IRON_SESSION_SECRET'),
    TELEMETRY_SINKS: readRequiredEnv('TELEMETRY_SINKS'),
    FRONTEND_URL: readRequiredEnv('FRONTEND_URL'),
    MARKETING_URL: readRequiredEnv('MARKETING_URL'),
    FRONTEND_PREVIEW_URL: readRequiredEnv('FRONTEND_PREVIEW_URL'),
    ...signals,
  };
  const app = createApp();
  const client = testClient(app, env);
  return { app, client, env };
}
