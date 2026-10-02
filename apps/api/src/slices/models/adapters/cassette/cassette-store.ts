/**
 * File-backed cassette store for the HTTP cassette harness.
 *
 * The on-disk layout and JSON shape
 * (`{CASSETTE_DIRECTORY}/{AI_RECORDING_VERSION}/{hash}.json`) predate this
 * module; recordings are shared with the prior implementation in both
 * directions until it is deleted at cutover. The optional `request` field
 * below is the one addition — the prior reader strips it (zod default), and
 * this reader tolerates its absence. Duplicated rather than imported because
 * new code never imports `legacy_` paths (lint-enforced).
 *
 * The generation this reads, and when to bump it, are stated once at
 * `@hushbox/shared/cassettes` — the CI sync script addresses the same
 * generation and neither side may drift from the other.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AI_RECORDING_VERSION, CASSETTE_FILE_SUFFIX } from '@hushbox/shared/cassettes';
import { writeAtomically } from './atomic-write.js';

const cassetteExchangeSchema = z.object({
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string(), z.string()),
  /** Base64-encoded chunks in order. Multi-chunk for SSE; single for non-stream. */
  chunks: z.array(z.string()),
});

/**
 * The canonical request that produced the recording. Captured so tests can
 * assert over what was actually sent (e.g. the ZDR flag on every gateway
 * call) without re-issuing the request. Optional: legacy recordings predate
 * request capture.
 */
const cassetteRequestSchema = z.object({
  method: z.string(),
  pathAndQuery: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
});

const cassetteSchema = z.object({
  version: z.number().int().min(1),
  exchanges: z.array(cassetteExchangeSchema),
  recordedAt: z.string(),
  recordedFromSha: z.string().optional(),
  request: cassetteRequestSchema.optional(),
});

export type Cassette = z.infer<typeof cassetteSchema>;

export interface CassetteStore {
  read(hash: string): Cassette | undefined;
  write(hash: string, cassette: Cassette): void;
  /** Hashes of every readable cassette in the store (for store-wide assertions). */
  list(): string[];
}

interface CreateCassetteStoreOptions {
  /** Filesystem root that contains the `{AI_RECORDING_VERSION}/` directory. */
  rootDir: string;
}

export function createCassetteStore(options: CreateCassetteStoreOptions): CassetteStore {
  const { rootDir } = options;
  const versionDir = path.join(rootDir, AI_RECORDING_VERSION);

  function pathFor(hash: string): string {
    return path.join(versionDir, `${hash}${CASSETTE_FILE_SUFFIX}`);
  }

  return {
    read(hash: string): Cassette | undefined {
      const file = pathFor(hash);
      if (!existsSync(file)) return undefined;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
        // eslint-disable-next-line catch-swallow/no-silent-catch -- cassette read failure becomes a cache miss (undefined).
      } catch {
        return undefined;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
        // eslint-disable-next-line catch-swallow/no-silent-catch -- corrupt cassette JSON becomes a cache miss (undefined).
      } catch {
        return undefined;
      }
      const parsed = cassetteSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      return parsed.data;
    },

    write(hash: string, cassette: Cassette): void {
      writeAtomically(pathFor(hash), JSON.stringify(cassette));
    },

    list(): string[] {
      if (!existsSync(versionDir)) return [];
      return readdirSync(versionDir)
        .filter((name) => name.endsWith(CASSETTE_FILE_SUFFIX))
        .map((name) => name.slice(0, -CASSETTE_FILE_SUFFIX.length));
    },
  };
}
