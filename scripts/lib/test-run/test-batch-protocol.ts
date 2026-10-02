/**
 * The wire contract between the batch coordinator (`scripts/test-batch.ts`)
 * and the per-package test client (`scripts/run-package-tests.ts`): one JSON
 * line each way over a loopback TCP socket. The port travels in
 * `HB_TEST_BATCH_PORT`; a client that sees no port is a standalone scoped run.
 */

export const BATCH_PORT_ENV = 'HB_TEST_BATCH_PORT';

export interface BatchRegistration {
  /** Full package name, e.g. `@hushbox/api`. */
  readonly package: string;
  /** Absolute package directory. */
  readonly dir: string;
}

type BatchVerdict =
  | { readonly verdict: 'ok' }
  | { readonly verdict: 'fail'; readonly reasons: readonly string[] }
  /** Registrant the coordinator will not batch; it must run itself, scoped. */
  | { readonly verdict: 'solo' };

function parseJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse one newline-terminated registration; `undefined` for a torn line. */
export function parseRegistration(line: string): BatchRegistration | undefined {
  const parsed = parseJson(line) as BatchRegistration | undefined;
  return parsed && typeof parsed.package === 'string' ? parsed : undefined;
}

/** Parse one newline-terminated verdict; `undefined` for a torn line. */
export function parseVerdict(line: string): BatchVerdict | undefined {
  const parsed = parseJson(line) as BatchVerdict | undefined;
  return parsed && typeof parsed.verdict === 'string' ? parsed : undefined;
}

export function serializeLine(message: BatchRegistration | BatchVerdict): string {
  return `${JSON.stringify(message)}\n`;
}
