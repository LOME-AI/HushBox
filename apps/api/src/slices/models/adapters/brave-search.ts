import { z } from 'zod';
import { WebSearchQuery, isHttpUrl } from '@hushbox/shared';
import { WEB_SEARCH_RESULT_MAX_CHARS } from '@hushbox/shared/affordability';
import { Result } from '../../../lib/result/index.js';
import { timeoutPolicy } from '../../../lib/resilience/index.js';
import { anySignal } from '../../../lib/resilience/signals.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import type { WebSearchResults } from '@hushbox/shared';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { FingerprintCode } from '../../../lib/telemetry/fingerprint-codes.js';
import type { SearchProvider } from '../ports/search-provider.js';

const BRAVE_WEB_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const RESULT_COUNT = 5;

/**
 * No retry: a failed search reaches the model as a tool error, and the model
 * may search again within its tool-call budget. A retry here would be a second
 * Brave request the budget never counted.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Per-field bounds that keep an ordinary five-result payload's JSON inside
 * `WEB_SEARCH_RESULT_MAX_CHARS`, the result size the admission hold reserves
 * for. A URL is dropped rather than cut, because a truncated URL is a
 * different address.
 */
const TITLE_MAX_CHARS = 200;
const SNIPPET_MAX_CHARS = 300;
const AGE_MAX_CHARS = 40;
const URL_MAX_CHARS = 500;

/**
 * The fields this adapter reads from Brave's documented response. Brave sends a
 * top-level section only when it is relevant, so an absent or null `web` is a
 * search that found nothing. A `web` section without its `results`, or a result
 * without its `title` or `url`, throws as unparseable rather than passing as
 * zero results, so a contract change pages instead of answering searches empty.
 */
const BraveWebResult = z.object({
  title: z.string(),
  url: z.string(),
  description: z.string().optional(),
  age: z.string().optional(),
});

const BraveWebResponse = z.object({
  web: z.object({ results: z.array(BraveWebResult) }).nullish(),
});

type BraveWebResult = z.infer<typeof BraveWebResult>;

const BraveErrorEnvelope = z.object({ error: z.object({ code: z.string() }) });

const parseJson = Result.fromThrowable(
  (text: string): unknown => JSON.parse(text),
  (): 'unparseable' => 'unparseable'
);

/**
 * A failed search. The message is a fixed phrase and `status` is Brave's HTTP
 * status when Brave answered, so neither carries the query, a result, or a
 * response body. No cause is attached: a transport or parser error can quote
 * the request URL, which holds the query, or the body it choked on.
 */
export class BraveSearchError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'BraveSearchError';
    this.status = status;
  }
}

/**
 * A payload over the size the hold reserves for. The user's results are
 * returned whole regardless; this reports the overage by its size alone.
 */
class SearchResultOversize extends Error {
  readonly resultChars: number;

  constructor(resultChars: number) {
    super('web search payload exceeds the reserved result size');
    this.name = 'SearchResultOversize';
    this.resultChars = resultChars;
  }
}

export interface BraveSearchProviderOptions {
  readonly apiKey: string;
  readonly telemetry: Telemetry;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

interface Answer {
  readonly status: number;
  readonly body: string;
}

interface Failure {
  readonly message: string;
  readonly code: FingerprintCode | undefined;
}

/** The largest code point one UTF-16 unit holds; anything above it is a surrogate pair. */
const MAX_SINGLE_UNIT_CODE_POINT = 0xff_ff;

/** Cut to at most `max` UTF-16 units, never leaving half of a surrogate pair. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const pairAtCut = (value.codePointAt(max - 1) ?? 0) > MAX_SINGLE_UNIT_CODE_POINT;
  return value.slice(0, pairAtCut ? max - 1 : max);
}

function searchUrl(query: string): URL {
  const url = new URL(BRAVE_WEB_SEARCH_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(RESULT_COUNT));
  url.searchParams.set('result_filter', 'web');
  url.searchParams.set('text_decorations', 'false');
  return url;
}

/** Brave's `error.code`, read only to compare against a literal; the body goes no further. */
function braveErrorCode(body: string): string | undefined {
  const parsed = parseJson(body).map((value) => BraveErrorEnvelope.safeParse(value));
  return parsed.isOk() && parsed.value.success ? parsed.value.data.error.code : undefined;
}

/**
 * Brave's error code decides the class whatever status carries it, because the
 * status Brave pairs with a refused key or a spent quota is not documented. A
 * rate limit is the one refusal nobody must act on.
 */
function statusFailure(status: number, body: string): Failure {
  const braveCode = braveErrorCode(body);
  if (status === 401 || status === 403 || braveCode === 'SUBSCRIPTION_TOKEN_INVALID') {
    return { message: 'Brave refused the search key', code: FINGERPRINT_CODES.searchProviderAuth };
  }
  if (status === 402 || braveCode === 'QUOTA_LIMITED') {
    return {
      message: 'Brave search credit or quota is spent',
      code: FINGERPRINT_CODES.searchProviderQuota,
    };
  }
  if (status === 429) {
    return { message: 'Brave rate-limited the search', code: undefined };
  }
  return {
    message: 'Brave answered the search with an error status',
    code: FINGERPRINT_CODES.searchProviderUnavailable,
  };
}

function parseResults(body: string): readonly BraveWebResult[] | undefined {
  const parsed = parseJson(body).map((value) => BraveWebResponse.safeParse(value));
  if (!parsed.isOk() || !parsed.value.success) return undefined;
  return parsed.value.data.web?.results ?? [];
}

function shape(results: readonly BraveWebResult[]): WebSearchResults {
  return {
    results: results
      .filter((result) => result.url.length <= URL_MAX_CHARS && isHttpUrl(result.url))
      .map((result) => ({
        title: truncate(result.title, TITLE_MAX_CHARS),
        url: result.url,
        snippet: truncate(result.description ?? '', SNIPPET_MAX_CHARS),
        ...(result.age === undefined ? {} : { age: truncate(result.age, AGE_MAX_CHARS) }),
      })),
  };
}

/**
 * The production search backend: one GET to Brave's web search per call,
 * bounded by a timeout, with the key in its one header. Failures an operator
 * must act on are captured once each, under a code that names the repair.
 */
export function createBraveSearchProvider(options: BraveSearchProviderOptions): SearchProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const runner = timeoutPolicy({ timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  const headers = { Accept: 'application/json', 'X-Subscription-Token': options.apiKey };

  function failed(failure: Failure, status?: number): BraveSearchError {
    const error = new BraveSearchError(failure.message, status);
    if (failure.code !== undefined) options.telemetry.captureError(error, failure.code);
    return error;
  }

  return {
    async search(query, { signal }): Promise<WebSearchResults> {
      const parsedQuery = WebSearchQuery.safeParse(query);
      if (!parsedQuery.success) {
        throw new BraveSearchError('web search query is outside the accepted bounds');
      }
      const url = searchUrl(parsedQuery.data.query);

      const exchange = await runner.run(async (deadline): Promise<Answer> => {
        const linked = anySignal([signal, deadline]);
        try {
          const response = await fetchImpl(url, { headers, signal: linked.signal });
          return { status: response.status, body: await response.text() };
        } finally {
          linked.dispose();
        }
      });

      if (exchange.isErr()) {
        signal.throwIfAborted();
        throw failed({
          message:
            exchange.error.code === 'timeout'
              ? 'Brave search did not answer in time'
              : 'Brave search could not be reached',
          code: FINGERPRINT_CODES.searchProviderUnavailable,
        });
      }

      const { status, body } = exchange.value;
      if (status < 200 || status >= 300) throw failed(statusFailure(status, body), status);

      const results = parseResults(body);
      if (results === undefined) {
        throw failed(
          {
            message: 'Brave returned a search response it does not document',
            code: FINGERPRINT_CODES.searchProviderUnavailable,
          },
          status
        );
      }

      const shaped = shape(results);
      const resultChars = JSON.stringify(shaped).length;
      if (resultChars > WEB_SEARCH_RESULT_MAX_CHARS) {
        options.telemetry.captureError(
          new SearchResultOversize(resultChars),
          FINGERPRINT_CODES.searchResultOversize
        );
      }
      return shaped;
    },
  };
}
