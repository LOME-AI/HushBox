import { STACK_MODES } from './port-plan.js';

/**
 * One Upstash-REST command against the local Serverless-Redis-HTTP proxy, under
 * a bound of its own, reporting which shape of failure it met.
 *
 * The bearer token selects the pool, so a command is the smallest thing that
 * can demonstrate one stack reaching another stack's keyspace — which is what
 * the isolation fixture beside this module does with it.
 *
 * Two reachability failures are indistinguishable to a caller that only awaits.
 * A proxy that refuses the connection rejects at once and a proxy that takes the
 * connection and never writes rejects never, so without a bound the second one
 * expires the runner's per-case budget and is read as a starved worker — a
 * different fault, with a different repair, and the costume several unrelated
 * causes have already worn here. Every failure therefore names its shape, and
 * the unanswered one carries its own deadline.
 *
 * What the unanswered shape establishes is exactly that the transport reported
 * no failure and no answer arrived inside the bound. It does not separate a
 * hung proxy from a worker that lost its turns for that long, and nothing
 * observable from inside the request does.
 */

/** What the proxy answers with, on both the success and the error path. */
interface RedisRestBody {
  result?: unknown;
  error?: string;
}

/**
 * Requests one case of the isolation fixture beside this module issues: the
 * write, its read-back, one read per other stack, and the removal. Read off
 * that file's body rather than counted into a literal, so a stack added to
 * {@link STACK_MODES} moves the bound below with nothing here edited.
 */
export const REQUESTS_PER_ISOLATION_CASE = STACK_MODES.length + 2;

/**
 * The per-case budget a vitest worker resolves from the shared runner config,
 * which is the budget a failure here has to be reported inside. That config
 * raises it for a coverage run and lowers it for no run, so a bound that wins
 * under this figure wins under both, and the suite beside this module fails if
 * the config ever resolves less than it.
 */
export const RUNNER_CASE_BUDGET_MS = 15_000;

/**
 * How long one request may go unanswered before it is reported as unanswered.
 *
 * Derived from one limit above it and one below, rather than picked between
 * them.
 *
 * Above: a case has to report its own failure before the runner's budget
 * expires, or the file goes back to presenting as a starved worker. The
 * conservative worst case is every request the case issues hanging to the
 * bound — conservative because only two of them can, the first one the body
 * reaches and the removal in its `finally` — plus everything the case does that
 * is not a request, carried at one further bound's width. That sum is the
 * divisor.
 *
 * Below: a healthy proxy must never reach it. Every round trip in the fixture
 * is loopback HTTP to a container on this host, and the whole file's round
 * trips together complete in tens of milliseconds, so the bound sits some three
 * orders of magnitude above one of them.
 */
export const REQUEST_BOUND_MS = Math.floor(
  RUNNER_CASE_BUDGET_MS / (REQUESTS_PER_ISOLATION_CASE + 1)
);

/**
 * How much of the answer had arrived when the request failed. The bound covers
 * the head and the body alike, so either phase can hang and either can fail;
 * the shape is the same in both and only the clause saying what was established
 * differs.
 */
type AnswerReached = 'none' | 'head';

/**
 * Why a request never became an answer, named so a reader classifies it from
 * the message alone.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError`; every other rejection out
 * of `fetch` or out of reading its body is a transport failure, and its cause is
 * where the code worth quoting sits when it has one.
 */
function reachabilityFailure(
  where: string,
  boundMs: number,
  reached: AnswerReached,
  error: Error
): string {
  if (error.name === 'TimeoutError') {
    const stalled =
      reached === 'none'
        ? `no answer arrived within ${String(boundMs)}ms`
        : `the answer it began did not complete within ${String(boundMs)}ms`;
    return `${where}: the transport reported no failure and ${stalled} — unanswered, not unreachable.`;
  }
  const cause = error.cause;
  const when = reached === 'none' ? 'before any answer' : 'while the answer was being read';
  return `${where}: the transport failed ${when} (${String(cause instanceof Error ? cause : error)}) — unreachable, not unanswered.`;
}

/**
 * A command on the connection the bearer token selects.
 *
 * The command is a non-empty argv so the message can always name it, and the
 * bound is a parameter so a case driving the unanswered shape need not wait the
 * fixture's own.
 */
export async function redisCommand(
  url: string,
  token: string,
  argv: readonly [string, ...string[]],
  boundMs: number = REQUEST_BOUND_MS
): Promise<unknown> {
  const where = `Redis REST ${argv[0]} at ${url}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(argv),
      signal: AbortSignal.timeout(boundMs),
    });
  } catch (error) {
    // `fetch` rejects only with `TypeError` or `DOMException`, both of them
    // `Error`s. The binding is `unknown` because a `throw` may carry anything,
    // not because anything on this path can, and a guard for the case that
    // cannot arise would be a branch nothing can drive.
    throw new Error(reachabilityFailure(where, boundMs, 'none', error as Error));
  }

  const answered = `${where}: answered ${String(response.status)}`;
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // The head arriving is not the answer arriving: the body is under the same
    // bound and fails in the same two shapes, so it is classified by the same
    // function rather than propagating a rejection that names neither the
    // command nor a shape. The cast carries the justification above it.
    throw new Error(reachabilityFailure(where, boundMs, 'head', error as Error));
  }
  let body: RedisRestBody;
  try {
    body = JSON.parse(text) as RedisRestBody;
  } catch {
    throw new Error(`${answered} with a body that is not JSON: ${JSON.stringify(text)}`);
  }
  if (!response.ok || body.error !== undefined) {
    throw new Error(`${answered} with error: ${body.error ?? 'no error body'}`);
  }
  return body.result;
}
