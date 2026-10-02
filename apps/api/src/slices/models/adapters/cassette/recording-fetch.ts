/**
 * HTTP cassette interceptor — wraps a fetch-shaped function so calls are
 * replayed from the store when a recording exists.
 *
 * Two modes. Runtime always composes `record` (via `cassetteModeFor()`, which
 * is env-independent and record-on-miss); `replay-only` is exercised only by
 * the cassette unit tests:
 *   - `record`: miss + success (<400) passes through AND records (request +
 *     response); miss + error (>=400) passes through unrecorded — a failed
 *     gateway request bills nothing, and caching it would replay a stale,
 *     transient failure forever (deterministic error paths come from the
 *     hand-curated failure fixtures instead).
 *   - `replay-only`: a miss throws `CassetteMissError`. Used only by the
 *     cassette unit tests — CI runs in `record` mode (record-on-miss), so a
 *     cold-cache CI request makes a real charged call and records it.
 *
 * The replay semantics and store format predate this module; recordings are
 * shared with the prior implementation. Duplicated rather than imported
 * because new code never imports `legacy_` paths (lint-enforced). Replay-only
 * mode and canonical-request capture (the ZDR-flag store assertion reads it)
 * exist only here — prior recordings carry no `request` field.
 */

import {
  requestToDescriptor,
  descriptorHash,
  type RequestDescriptor,
} from './canonical-request.js';
import type { Cassette, CassetteStore } from './cassette-store.js';

/**
 * A replay-only miss. The message carries the request shape (method, path,
 * store key) and never the body — request bodies hold prompt content.
 */
export class CassetteMissError extends Error {
  constructor(descriptor: RequestDescriptor, key: string) {
    super(
      `Cassette miss in replay-only mode: ${descriptor.method} ${descriptor.pathAndQuery} (key ${key}). ` +
        'Replay-only mode is used only by the cassette unit tests; CI runs in record mode and records on miss.'
    );
    this.name = 'CassetteMissError';
  }
}

interface CreateCassetteFetchOptions {
  store: CassetteStore;
  mode: 'record' | 'replay-only';
  /** Underlying fetch used on record-mode misses. Usually `globalThis.fetch`. */
  realFetch?: typeof globalThis.fetch;
}

/**
 * The store key for the `occurrence`-th call of one request hash inside a
 * closure. Occurrence zero is the bare hash, so a recording made before this
 * scheme still answers a first call; a suffixed key cannot collide with a bare
 * one, which is always 16 hex characters.
 */
function cassetteKey(hash: string, occurrence: number): string {
  return occurrence === 0 ? hash : `${hash}-${occurrence.toString()}`;
}

/**
 * The open occurrence scope: the stretch of work whose repeated requests count
 * as one sequence. A closure compares it lazily on each call and clears its
 * counts when it has moved, so one call here covers every closure in the
 * process — including ones built before it, which is what lets a test harness
 * bound a closure it cannot reach.
 */
let currentScope = 0;

/**
 * Whether a scope is currently open. Separate from {@link currentScope}, which
 * only moves forward and so can never say that a scope has ended: a caller
 * outside this module needs to know whether its traffic sits inside a counted
 * sequence at all, and that question has to be answerable with "no" again.
 */
let scopeOpen = false;

/**
 * Open the next occurrence scope. Whoever owns the boundary of a logical run
 * calls this at its start; two runs that happen to send identical bytes then
 * each replay their own recorded sequence from its beginning, instead of the
 * second keying past the end of the first and reaching the live gateway.
 */
export function beginCassetteScope(): void {
  currentScope += 1;
  scopeOpen = true;
}

/**
 * Close the open scope at the end of the run it bounded. Counting is untouched
 * — a closure carries on from where it was, and the next
 * {@link beginCassetteScope} is what restarts it.
 */
export function endCassetteScope(): void {
  scopeOpen = false;
}

/** Whether traffic issued right now falls inside an occurrence scope. */
export function cassetteScopeIsOpen(): boolean {
  return scopeOpen;
}

export function createCassetteFetch(options: CreateCassetteFetchOptions): typeof globalThis.fetch {
  const { store, mode, realFetch } = options;
  if (mode === 'record' && realFetch === undefined) {
    throw new Error('createCassetteFetch: record mode requires a realFetch');
  }

  // How often each request hash has been seen in this closure's current scope.
  // An operation that polls one URL sends byte-identical requests, so the hash
  // alone would key every poll to one recording and replay the first,
  // non-terminal body forever; the occurrence is what makes a recorded sequence
  // replay as a sequence. Closure-scoped so a later process replays from the
  // beginning, and cleared when {@link beginCassetteScope} has moved the scope
  // on, so a closure that outlives one logical run does not carry its counts
  // into the next.
  const occurrences = new Map<string, number>();
  let scope = currentScope;

  return async function cassetteFetch(
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> {
    if (scope !== currentScope) {
      scope = currentScope;
      occurrences.clear();
    }

    const request = new Request(input, init);
    const descriptor = await requestToDescriptor(request);
    const hash = descriptorHash(descriptor);
    const occurrence = occurrences.get(hash) ?? 0;
    occurrences.set(hash, occurrence + 1);
    const key = cassetteKey(hash, occurrence);

    const cached = store.read(key);
    if (cached !== undefined && cached.exchanges.length > 0) {
      return replayFromCassette(cached);
    }

    if (mode === 'replay-only' || realFetch === undefined) {
      throw new CassetteMissError(descriptor, key);
    }

    const upstream = await realFetch(request);

    if (upstream.status >= 400) {
      return upstream;
    }

    return recordAndPassThrough(upstream, key, descriptor, store);
  };
}

export function replayFromCassette(cassette: Cassette): Response {
  // Use the first exchange. Each logical operation that produces multiple
  // HTTP calls keys each one to its own cassette — so a single cassette
  // holds one exchange in practice. The caller already guards on
  // `cassette.exchanges.length > 0`; throw explicitly if a hand-edited
  // cassette breaks the invariant rather than reach for a non-null assertion.
  const exchange = cassette.exchanges[0];
  if (exchange === undefined) {
    throw new Error('replayFromCassette invariant: cassette.exchanges is empty');
  }
  if (exchange.chunks.length === 0) {
    return new Response(null, {
      status: exchange.status,
      statusText: exchange.statusText,
      headers: exchange.headers,
    });
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const base64 of exchange.chunks) {
        const bytes = Buffer.from(base64, 'base64');
        controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: exchange.status,
    statusText: exchange.statusText,
    headers: exchange.headers,
  });
}

async function recordAndPassThrough(
  upstream: Response,
  key: string,
  descriptor: RequestDescriptor,
  store: CassetteStore
): Promise<Response> {
  // Tee the body so the caller's read does not consume the chunks we need to
  // record. The record branch is drained here, before the caller sees the
  // response, so the whole body is buffered into the caller's branch by the
  // tee — a tee enqueues each chunk to both branches whatever the idle
  // branch's demand, which is what lets this drain complete with no reader on
  // the other side.
  const [callerBranch, recordBranch] = upstream.body === null ? [null, null] : upstream.body.tee();

  // Collect headers as a plain Record for serialization. Skip
  // `content-encoding` because the SDK's response parsers handle decoding
  // before our level — recording the encoded bytes would replay as
  // double-encoded.
  const headers: Record<string, string> = {};
  for (const [name, value] of upstream.headers.entries()) {
    if (name.toLowerCase() === 'content-encoding') continue;
    headers[name] = value;
  }

  const request = {
    method: descriptor.method,
    pathAndQuery: descriptor.pathAndQuery,
    headers: descriptor.headers,
    ...(descriptor.body === undefined ? {} : { body: descriptor.body }),
  };

  if (recordBranch === null) {
    // Bodyless response — record an empty cassette so a future hit replays
    // status + headers correctly.
    store.write(key, {
      version: 1,
      exchanges: [
        { status: upstream.status, statusText: upstream.statusText, headers, chunks: [] },
      ],
      recordedAt: new Date().toISOString(),
      ...recordedFromShaStamp(),
      request,
    });
  } else {
    // Awaited, not fired: a recording that fails to finish — a mid-stream
    // error, a rejected store write — must fail the call that made it, or the
    // charged gateway call it was paying for is lost silently and the next run
    // pays for it again. The cost is that a stalled drain hangs its own test
    // rather than vanishing, which is the trade this seam wants.
    await drainAndStore({
      stream: recordBranch,
      key,
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
      request,
      store,
    });
  }

  return new Response(callerBranch, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
}

interface DrainAndStoreInput {
  stream: ReadableStream<Uint8Array>;
  key: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  request: Cassette['request'];
  store: CassetteStore;
}

async function drainAndStore(input: DrainAndStoreInput): Promise<void> {
  const { stream, key, status, statusText, headers, request, store } = input;
  const chunks: string[] = [];
  for await (const value of stream) {
    // Convert Uint8Array → base64 via Buffer (Node-native, no string churn).
    const buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    chunks.push(buffer.toString('base64'));
  }
  store.write(key, {
    version: 1,
    exchanges: [{ status, statusText, headers, chunks }],
    recordedAt: new Date().toISOString(),
    ...recordedFromShaStamp(),
    request,
  });
}

/**
 * Stamp a recording with the CI commit sha when present. `GITHUB_SHA` is a
 * GitHub Actions runtime detail with no `envConfig`/`envUtils` slot, so reading
 * `process.env` directly is the deliberate exception: this is diagnostic-only
 * metadata (correlating a recording to the commit that produced it) and
 * production code never runs through the record path.
 */
function recordedFromShaStamp(): { recordedFromSha: string } | Record<string, never> {
  const sha = process.env['GITHUB_SHA'];
  return sha === undefined ? {} : { recordedFromSha: sha };
}
