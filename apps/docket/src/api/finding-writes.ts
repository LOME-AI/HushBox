import { FINDING_ACTIONS } from '../finding-actions';
import { findingWriteUrl } from './audit-routes';
import type { FindingAction, ReplacePolicy } from '../finding-actions';
import type { FindingJson } from '@hushbox/docket';

export type { FindingAction } from '../finding-actions';

/** What every mutating route returns: the finding as it now is, plus the way back. */
interface WriteEffect {
  readonly finding: FindingJson;
  readonly undoToken: string;
}

type WriteOutcome =
  | { readonly ok: true; readonly value: WriteEffect }
  | { readonly ok: false; readonly message: string };

/**
 * The fence policy the console applies, read off the action declarations rather
 * than restated: an action declared without a replace-or-append decision does
 * not compile, so no write reaches the wire unfenced by default.
 */
export const REPLACES_BY_ACTION: Record<FindingAction, ReplacePolicy> = Object.fromEntries(
  Object.entries(FINDING_ACTIONS).map(([action, spec]) => [action, spec.replaces])
) as Record<FindingAction, ReplacePolicy>;

function replaces(action: FindingAction, body: object): boolean {
  const policy = REPLACES_BY_ACTION[action];
  return typeof policy === 'function' ? policy(body) : policy;
}

export interface ApiDeps {
  readonly fetch?: typeof globalThis.fetch;
  readonly wait?: (ms: number) => Promise<void>;
  /** Total tries, not retries: 1 means never retry. */
  readonly attempts?: number;
  /**
   * Called once the write is known to be waiting on another writer rather than
   * simply in flight. The server spends its own lock timeout before refusing, so
   * a caller with no way to hear this can only leave the reader watching a
   * screen that says nothing for as long as the other writer keeps the file.
   */
  readonly onWaiting?: () => void;
}

const DEFAULT_ATTEMPTS = 4;
const RETRY_DELAY_MS = 250;

interface Refusal {
  readonly message: string;
  readonly retryable: boolean;
}

async function refusalOf(response: Response): Promise<Refusal> {
  const fallback = `the write was refused (${String(response.status)})`;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { message: fallback, retryable: false };
  }
  const error = (body as { error?: { message?: unknown; retryable?: unknown } } | null)?.error;
  return {
    message: typeof error?.message === 'string' ? error.message : fallback,
    retryable: error?.retryable === true,
  };
}

/**
 * A `locked` refusal means another writer holds the file for the moment, so the
 * console waits and asks again rather than telling the reader their click
 * failed. Every retryable refusal is treated the same way; the flag is the
 * contract, not the code. Every pane writes through here, so no surface can be
 * left behind reporting a transient refusal as a failure.
 */
type Attempt = { readonly done: WriteOutcome } | { readonly refusal: Refusal };

async function attempt(
  call: typeof globalThis.fetch,
  path: string,
  body: unknown
): Promise<Attempt> {
  try {
    const response = await call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      return { done: { ok: true, value: (await response.json()) as WriteEffect } };
    }
    return { refusal: await refusalOf(response) };
  } catch (error) {
    return {
      done: {
        ok: false,
        message: error instanceof Error ? error.message : 'the write could not be sent',
      },
    };
  }
}

async function send(path: string, body: unknown, deps: ApiDeps): Promise<WriteOutcome> {
  const call = deps.fetch ?? globalThis.fetch.bind(globalThis);
  const wait =
    deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS;

  let refusal: Refusal = { message: 'the write was never attempted', retryable: false };
  for (let index = 0; index < attempts; index += 1) {
    if (index > 0) await wait(RETRY_DELAY_MS);
    const outcome = await attempt(call, path, body);
    if ('done' in outcome) return outcome.done;
    refusal = outcome.refusal;
    if (!refusal.retryable) break;
    // Only when there is another attempt to wait for: a refusal that ends the
    // write is reported as the refusal it is, not as a wait.
    if (index + 1 < attempts) deps.onWaiting?.();
  }
  return { ok: false, message: refusal.message };
}

/**
 * What one write names. The body is any JSON object the route takes; it is
 * `object` rather than `Record<string, unknown>` because a body declared as an
 * interface — which is how a pane types its own patch — has no implicit index
 * signature.
 *
 * The finding is carried whole rather than by id so that `base` is merged in
 * one place, and the audit is carried at all because this module is the
 * transport: reading the console's address here would put React inside it.
 */
interface FindingWrite {
  readonly audit: string;
  readonly finding: Pick<FindingJson, 'id' | 'hash'>;
  readonly action: FindingAction;
  readonly body: object;
}

/**
 * The one way a pane writes, so no pane has to know that the version it read is
 * part of what it sends, nor which audit its route is under.
 */
export async function writeFinding(
  { audit, finding, action, body }: FindingWrite,
  deps: ApiDeps = {}
): Promise<WriteOutcome> {
  return send(
    findingWriteUrl(audit, finding.id, action),
    replaces(action, body) ? { ...body, base: finding.hash } : body,
    deps
  );
}

export async function undoLastWrite(token: string, deps: ApiDeps = {}): Promise<WriteOutcome> {
  return send('/api/undo', { token }, deps);
}
