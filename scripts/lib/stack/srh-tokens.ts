import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Mode, envConfig, resolveRaw } from '@hushbox/shared/env.config';
import type { EnvMode } from '@hushbox/shared/env.config';

/**
 * The Serverless-Redis-HTTP pool file, written from the env registry.
 *
 * The bearer token is what selects a pool, and every client takes its token
 * from `UPSTASH_REDIS_REST_TOKEN` in the registry — so spelling the tokens again
 * in this file would be a second copy kept in agreement by nothing. A wrong one
 * fails as `401 Invalid token` in whichever mode owns it, which is a symptom
 * that reads like an unrelated suite failing. The file is generated and
 * committed, the way this repo generates and commits its other derived files,
 * because the container reads it at boot, before any TypeScript in this repo
 * runs.
 *
 * Everything else about a pool is this file's own: which logical Redis database
 * a mode gets, and how wide its connection pool is.
 */

/** Where the compose mount expects the file, relative to the repo root. */
export const SRH_TOKENS_FILE = path.join('docker', 'srh-tokens.json');

/** The compose service that mounts the file and reads it at boot. */
export const SRH_SERVICE = 'serverless-redis-http';

/**
 * Sized for the widest run that can drive one pool alone — a full vitest run or
 * a Playwright run — at the per-worker connection count the single shared pool
 * used to imply. The pools no longer compete, so their sum sits far under
 * Redis's own `maxclients`.
 */
const MAX_CONNECTIONS = 200;

interface Pool {
  /** The mode whose registry token names this pool. */
  readonly mode: EnvMode;
  /** How the pool identifies itself in the proxy's own logs. */
  readonly srhId: string;
  /** The logical Redis database this mode's keys live in. */
  readonly database: number;
}

const POOLS: readonly Pool[] = [
  { mode: Mode.Development, srhId: 'hushbox-development', database: 0 },
  { mode: Mode.CiVitest, srhId: 'hushbox-test', database: 1 },
  { mode: Mode.E2E, srhId: 'hushbox-e2e', database: 2 },
];

/**
 * The registry's token for a mode, refused when it is not a literal one: a
 * local pool fronted by a production secret would put that secret in a
 * world-readable generated file.
 */
export function tokenFor(mode: EnvMode): string {
  const token = resolveRaw(envConfig.UPSTASH_REDIS_REST_TOKEN, mode);
  if (typeof token !== 'string') {
    throw new TypeError(
      `srh-tokens: UPSTASH_REDIS_REST_TOKEN resolves to no literal token in ${mode} — ` +
        'a local pool cannot be fronted by a production secret.'
    );
  }
  return token;
}

export function renderSrhTokens(): string {
  const pools = Object.fromEntries(
    POOLS.map((pool) => [
      tokenFor(pool.mode),
      {
        srh_id: pool.srhId,
        connection_string: `redis://redis:6379/${String(pool.database)}`,
        max_connections: MAX_CONNECTIONS,
      },
    ])
  );
  return `${JSON.stringify(pools, null, 2)}\n`;
}

/**
 * Writes the file only when its bytes change, and answers which compose
 * services have to be recreated because it did.
 *
 * The file reaches the container as a path mount, so it is outside the
 * configuration hash compose decides recreation on, and the proxy reads it once
 * at boot. A token changed in the env registry therefore reaches a running
 * container by nothing except an explicit recreate — which is why the write is
 * reported rather than performed silently, and why an unchanged file must
 * report nothing rather than recreate a container for no reason.
 */
export function writeSrhTokens(repoRoot: string): readonly string[] {
  const target = path.join(repoRoot, SRH_TOKENS_FILE);
  const rendered = renderSrhTokens();
  try {
    if (readFileSync(target, 'utf8') === rendered) return [];
  } catch {
    // Absent or unreadable is what writing is for.
  }
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, rendered);
  return [SRH_SERVICE];
}
