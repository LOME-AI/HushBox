import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parentPort } from 'node:worker_threads';

import type { NamedRawCoverage } from './coverage-offset-detector.js';

// Resolved through coverage-v8's own module scope, exactly as the provider
// does, so both sides always run the same @bcoe/v8-coverage build.
const coverageV8Require = createRequire(
  createRequire(import.meta.url).resolve('@vitest/coverage-v8')
);
const { mergeProcessCovs } = coverageV8Require('@bcoe/v8-coverage') as {
  mergeProcessCovs: (covs: ProcessCov[]) => ProcessCov;
};

interface ScriptCov {
  readonly url: string;
  startOffset?: number;
}

interface ProcessCov {
  readonly result: ScriptCov[];
}

export interface MergeBatchRequest {
  readonly id: number;
  readonly filenames: readonly string[];
}

export interface MergeBatchResponse {
  readonly id: number;
  readonly merged?: ProcessCov;
  /**
   * Each dump reduced to the url/startOffset pairs the coverage-offset gate
   * inspects — extracted here because this worker is the raw dumps' only
   * reader and last holder before they are removed.
   */
  readonly rawLite?: readonly NamedRawCoverage[];
  readonly error?: string;
}

function findStartOffset(covs: ProcessCov[], url: string): number {
  for (const cov of covs) {
    const original = cov.result.find((r) => r.url === url && r.startOffset);
    if (original?.startOffset) {
      return original.startOffset;
    }
  }
  return 0;
}

/**
 * Parse one batch of per-test-file V8 dumps and merge them into a single
 * process cov, restoring any `startOffset` the merge dropped — the same
 * repair upstream applies after its per-file pairwise merge. Parsing and
 * merging here, off the main thread, is the point: the merged result the
 * main thread receives is deduplicated, a fraction of the input volume.
 */
interface MergedBatch {
  readonly merged: ProcessCov;
  readonly rawLite: readonly NamedRawCoverage[];
}

function mergeBatch(filenames: readonly string[]): MergedBatch {
  const covs = filenames.map((filename) => {
    const cov = JSON.parse(readFileSync(filename, 'utf8')) as ProcessCov;
    // Fork-written dumps live outside vitest's cleaned coverage directory, so
    // this read is their single consumer and removes them.
    rmSync(filename, { force: true });
    return cov;
  });
  const rawLite = covs.map((cov, index) => ({
    name: path.basename(filenames[index] ?? ''),
    file: {
      result: cov.result.map((entry) => ({ url: entry.url, startOffset: entry.startOffset ?? 0 })),
    },
  }));
  const merged = mergeProcessCovs(covs);
  for (const entry of merged.result) {
    entry.startOffset ||= findStartOffset(covs, entry.url);
  }
  return { merged, rawLite };
}

/**
 * A missing dump means the coverage data is incomplete and the run must fail;
 * whether the whole directory vanished (something swept it) or just the one
 * file (a write never happened) points at very different causes, so the error
 * says which.
 */
function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes('ENOENT')) {
    return message;
  }
  const missing = /open '([^']+)'/.exec(message)?.[1];
  if (!missing) {
    return message;
  }
  try {
    const entries = readdirSync(path.dirname(missing)).join(', ');
    return `${message} [dir entries: ${entries || '(empty)'}]`;
  } catch {
    return `${message} [dump dir itself is gone]`;
  }
}

parentPort?.on('message', (request: MergeBatchRequest) => {
  try {
    const { merged, rawLite } = mergeBatch(request.filenames);
    parentPort?.postMessage({ id: request.id, merged, rawLite });
  } catch (error) {
    parentPort?.postMessage({ id: request.id, error: describeError(error) });
  }
});
