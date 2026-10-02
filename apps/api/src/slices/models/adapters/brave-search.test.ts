import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEB_SEARCH_RESULT_MAX_CHARS } from '@hushbox/shared/affordability';
import { SECOND_MS, TEST_DAY_START, freezeClock } from '@hushbox/shared/test-time';
import { BraveSearchError, createBraveSearchProvider } from './brave-search.js';
import type { WebSearchResults } from '@hushbox/shared';
import type { SafeLogFields, Telemetry } from '../../../lib/telemetry/index.js';

interface RecordedCapture {
  readonly error: Error;
  readonly code: string;
}

interface RecordedLine {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

interface RecordingTelemetry {
  readonly telemetry: Telemetry;
  readonly captures: RecordedCapture[];
  readonly lines: RecordedLine[];
}

function recordingTelemetry(): RecordingTelemetry {
  const captures: RecordedCapture[] = [];
  const lines: RecordedLine[] = [];
  const record = (msg: string, fields?: SafeLogFields): void => {
    lines.push({ msg, fields });
  };
  const telemetry: Telemetry = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    captureError: (error, code) => {
      captures.push({ error, code });
    },
  };
  return { telemetry, captures, lines };
}

interface BraveResult {
  readonly title: string;
  readonly url: string;
  readonly description?: string;
  readonly age?: string;
}

function braveBody(results: readonly BraveResult[]): string {
  return JSON.stringify({ type: 'search', web: { type: 'search', results } });
}

function answering(body: string): typeof fetch {
  return (): Promise<Response> =>
    Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    );
}

interface CapturingTransport {
  readonly fetch: typeof fetch;
  readonly requests: Request[];
}

/** A transport that records every request it is handed and answers each with `respond`. */
function capturing(respond: (request: Request) => Promise<Response>): CapturingTransport {
  const requests: Request[] = [];
  return {
    requests,
    fetch: (input, init): Promise<Response> => {
      const request = new Request(input, init);
      requests.push(request);
      return respond(request);
    },
  };
}

function okResponse(body: string): Promise<Response> {
  return Promise.resolve(
    new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  );
}

const TEST_KEY = 'brave-unit-test-key';

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function onlyRequest(query: string): Promise<Request> {
  const transport = capturing(() => okResponse(braveBody([])));
  const provider = createBraveSearchProvider({
    apiKey: TEST_KEY,
    telemetry: recordingTelemetry().telemetry,
    fetch: transport.fetch,
  });
  await provider.search({ query }, { signal: signal() });
  const [request] = transport.requests;
  if (request === undefined || transport.requests.length !== 1) {
    throw new Error('expected exactly one outbound request');
  }
  return request;
}

describe('createBraveSearchProvider: the outbound request', () => {
  it('targets the Brave web search endpoint with exactly q, count, result_filter and text_decorations', async () => {
    const request = await onlyRequest('tide tables & moon phases');
    const url = new URL(request.url);

    expect(`${url.origin}${url.pathname}`).toBe('https://api.search.brave.com/res/v1/web/search');
    expect([...url.searchParams.entries()].toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
      ['count', '5'],
      ['q', 'tide tables & moon phases'],
      ['result_filter', 'web'],
      ['text_decorations', 'false'],
    ]);
  });

  it('sends exactly the Accept and X-Subscription-Token headers', async () => {
    const request = await onlyRequest('tide tables');

    expect(Object.fromEntries(request.headers.entries())).toEqual({
      accept: 'application/json',
      'x-subscription-token': TEST_KEY,
    });
  });

  it('sends a GET with no body', async () => {
    const request = await onlyRequest('tide tables');

    expect(request.method).toBe('GET');
    expect(request.body).toBeNull();
  });

  it("aborts the outbound request when the caller's signal aborts", async () => {
    const caller = new AbortController();
    const transport = capturing(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
          caller.abort();
        })
    );
    const provider = createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry: recordingTelemetry().telemetry,
      fetch: transport.fetch,
    });

    await expect(
      provider.search({ query: 'tide tables' }, { signal: caller.signal })
    ).rejects.toThrow();
    expect(transport.requests[0]?.signal.aborted).toBe(true);
  });
});

describe('createBraveSearchProvider: the query', () => {
  const REFUSED_QUERIES = [
    { label: 'an empty query', query: '' },
    { label: 'a query of only whitespace', query: '   ' },
    { label: 'a query over 600 characters', query: 'q'.repeat(601) },
    { label: 'a query over 75 words', query: Array.from({ length: 76 }, () => 'w').join(' ') },
  ] as const;

  it.each(REFUSED_QUERIES)('refuses $label without calling Brave', async ({ query }) => {
    const { telemetry, captures } = recordingTelemetry();
    const transport = capturing(() => okResponse(braveBody([])));
    const provider = createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry,
      fetch: transport.fetch,
    });

    await expect(provider.search({ query }, { signal: signal() })).rejects.toThrow();
    expect(transport.requests).toEqual([]);
    expect(captures).toEqual([]);
  });

  it('accepts a query of exactly 600 characters and 75 words', async () => {
    const words = Array.from({ length: 75 }, () => 'w').join(' ');
    const query = `${words}${'q'.repeat(600 - words.length)}`;
    const request = await onlyRequest(query);

    expect(new URL(request.url).searchParams.get('q')).toBe(query);
  });
});

describe('createBraveSearchProvider: result shaping', () => {
  it('drops a result whose url is not http(s)', async () => {
    const { telemetry } = recordingTelemetry();
    const provider = createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry,
      fetch: answering(
        braveBody([
          { title: 'Kept https', url: 'https://a.example/', description: 'one' },
          { title: 'Script', url: 'javascript:alert(1)', description: 'two' },
          { title: 'File transfer', url: 'ftp://b.example/', description: 'three' },
          { title: 'Kept http', url: 'http://c.example/', description: 'four' },
        ])
      ),
    });

    const shaped = await provider.search({ query: 'lighthouses' }, { signal: signal() });

    expect(shaped.results.map((result) => result.url)).toEqual([
      'https://a.example/',
      'http://c.example/',
    ]);
  });

  async function shapedFrom(results: readonly BraveResult[]): Promise<WebSearchResults> {
    const provider = createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry: recordingTelemetry().telemetry,
      fetch: answering(braveBody(results)),
    });
    return provider.search({ query: 'lighthouses' }, { signal: signal() });
  }

  it('maps title, url, description and age onto title, url, snippet and age', async () => {
    const shaped = await shapedFrom([
      { title: 'T', url: 'https://a.example/', description: 'D', age: '3 days ago' },
    ]);

    expect(shaped).toEqual({
      results: [{ title: 'T', url: 'https://a.example/', snippet: 'D', age: '3 days ago' }],
    });
  });

  it('leaves age off a result Brave returns without one', async () => {
    const shaped = await shapedFrom([{ title: 'T', url: 'https://a.example/', description: 'D' }]);

    expect(Object.keys(shaped.results[0] ?? {})).toEqual(['title', 'url', 'snippet']);
  });

  it('gives a result Brave returns without a description an empty snippet', async () => {
    const shaped = await shapedFrom([{ title: 'T', url: 'https://a.example/' }]);

    expect(shaped.results[0]?.snippet).toBe('');
  });

  it('truncates a title to 200 characters', async () => {
    const shaped = await shapedFrom([{ title: 't'.repeat(201), url: 'https://a.example/' }]);

    expect(shaped.results[0]?.title).toBe('t'.repeat(200));
  });

  it('truncates a snippet to 300 characters', async () => {
    const shaped = await shapedFrom([
      { title: 'T', url: 'https://a.example/', description: 's'.repeat(301) },
    ]);

    expect(shaped.results[0]?.snippet).toBe('s'.repeat(300));
  });

  it('truncates an age to 40 characters', async () => {
    const shaped = await shapedFrom([
      { title: 'T', url: 'https://a.example/', age: 'a'.repeat(41) },
    ]);

    expect(shaped.results[0]?.age).toBe('a'.repeat(40));
  });

  it('keeps a whole surrogate pair out of a truncated field rather than splitting it', async () => {
    const shaped = await shapedFrom([
      { title: `${'t'.repeat(199)}\u{1F30A}`, url: 'https://a.example/' },
    ]);

    expect(shaped.results[0]?.title).toBe('t'.repeat(199));
  });

  it('drops a result whose url exceeds 500 characters', async () => {
    const longUrl = `https://a.example/${'p'.repeat(501 - 'https://a.example/'.length)}`;
    const shaped = await shapedFrom([
      { title: 'Too long', url: longUrl },
      { title: 'Kept', url: 'https://b.example/' },
    ]);

    expect(shaped.results.map((result) => result.title)).toEqual(['Kept']);
  });

  it('keeps a result whose url is exactly 500 characters', async () => {
    const url = `https://a.example/${'p'.repeat(500 - 'https://a.example/'.length)}`;
    const shaped = await shapedFrom([{ title: 'Kept', url }]);

    expect(shaped.results.map((result) => result.url)).toEqual([url]);
  });

  it('returns no results, and captures nothing, for a 200 with zero results', async () => {
    const { telemetry, captures } = recordingTelemetry();
    const provider = createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry,
      fetch: answering(braveBody([])),
    });

    const shaped = await provider.search({ query: 'lighthouses' }, { signal: signal() });

    expect(shaped).toEqual({ results: [] });
    expect(captures).toEqual([]);
  });

  /** Brave documents every top-level section as present only when relevant. */
  const WEB_SECTION_MISSING = [
    { label: 'absent', body: JSON.stringify({ type: 'search', query: { original: 'q' } }) },
    { label: 'null', body: JSON.stringify({ type: 'search', web: null }) },
  ] as const;

  it.each(WEB_SECTION_MISSING)(
    'returns no results for a 200 whose web section is $label',
    async ({ body }) => {
      const provider = createBraveSearchProvider({
        apiKey: TEST_KEY,
        telemetry: recordingTelemetry().telemetry,
        fetch: answering(body),
      });

      const shaped = await provider.search({ query: 'lighthouses' }, { signal: signal() });

      expect(shaped).toEqual({ results: [] });
    }
  );

  it.each(WEB_SECTION_MISSING)(
    'captures nothing for a 200 whose web section is $label',
    async ({ body }) => {
      const { telemetry, captures } = recordingTelemetry();
      const provider = createBraveSearchProvider({
        apiKey: TEST_KEY,
        telemetry,
        fetch: answering(body),
      });

      await provider.search({ query: 'lighthouses' }, { signal: signal() }).catch(() => undefined);

      expect(captures).toEqual([]);
    }
  );
});

/** Text only a leak could carry out of the adapter: the query, and a result's own words. */
const QUERY_MARKER = 'quokka-marker-query';
const RESULT_MARKER = 'narwhal-marker-result';

/** Brave's documented error envelope, echoing the query the way a validation error can. */
function braveErrorBody(code: string): string {
  return JSON.stringify({
    type: 'ErrorResponse',
    time: 0,
    error: {
      id: 'error-id',
      status: 0,
      code,
      detail: `Unable to process ${QUERY_MARKER}`,
      meta: { errors: [{ loc: ['query', 'q'], input: QUERY_MARKER }] },
    },
  });
}

function status(code: number, body: string): typeof fetch {
  return (): Promise<Response> =>
    Promise.resolve(
      new Response(body, { status: code, headers: { 'content-type': 'application/json' } })
    );
}

/** A transport that never answers and rejects only when its request is aborted. */
function silent(): typeof fetch {
  return (input, init): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      new Request(input, init).signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
    });
}

/** A transport that fails the way a runtime reports a dead socket, quoting the URL it was sent. */
function unreachable(): typeof fetch {
  return (input): Promise<Response> =>
    Promise.reject(new TypeError(`fetch failed for ${new Request(input).url}`));
}

/** A transport that aborts the caller's signal mid-request, the way a run's hard stop does. */
function abortedBy(caller: AbortController): typeof fetch {
  return (input, init): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      new Request(input, init).signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      });
      caller.abort();
    });
}

const TIMEOUT_UNDER_TEST_MS = 20;

interface FailureCase {
  readonly label: string;
  readonly transport: (caller: AbortController) => typeof fetch;
}

interface CapturedFailureCase extends FailureCase {
  readonly code: string;
  readonly status: number | undefined;
}

const CAPTURED_FAILURES: readonly CapturedFailureCase[] = [
  {
    label: 'HTTP 401',
    transport: () => status(401, braveErrorBody('SUBSCRIPTION_TOKEN_INVALID')),
    code: 'search_provider_auth',
    status: 401,
  },
  {
    label: 'HTTP 403',
    transport: () => status(403, braveErrorBody('SUBSCRIPTION_TOKEN_INVALID')),
    code: 'search_provider_auth',
    status: 403,
  },
  {
    label: 'a SUBSCRIPTION_TOKEN_INVALID code on HTTP 422',
    transport: () => status(422, braveErrorBody('SUBSCRIPTION_TOKEN_INVALID')),
    code: 'search_provider_auth',
    status: 422,
  },
  {
    label: 'a SUBSCRIPTION_TOKEN_INVALID code on HTTP 429',
    transport: () => status(429, braveErrorBody('SUBSCRIPTION_TOKEN_INVALID')),
    code: 'search_provider_auth',
    status: 429,
  },
  {
    label: 'HTTP 402',
    transport: () => status(402, braveErrorBody('QUOTA_LIMITED')),
    code: 'search_provider_quota',
    status: 402,
  },
  {
    label: 'a QUOTA_LIMITED code on HTTP 429',
    transport: () => status(429, braveErrorBody('QUOTA_LIMITED')),
    code: 'search_provider_quota',
    status: 429,
  },
  {
    label: 'HTTP 500',
    transport: () => status(500, braveErrorBody('INTERNAL')),
    code: 'search_provider_unavailable',
    status: 500,
  },
  {
    label: 'HTTP 503',
    transport: () => status(503, `<html>${QUERY_MARKER}</html>`),
    code: 'search_provider_unavailable',
    status: 503,
  },
  {
    label: 'HTTP 404',
    transport: () => status(404, braveErrorBody('NOT_FOUND')),
    code: 'search_provider_unavailable',
    status: 404,
  },
  {
    label: 'a VALIDATION code on HTTP 422',
    transport: () => status(422, braveErrorBody('VALIDATION')),
    code: 'search_provider_unavailable',
    status: 422,
  },
  {
    label: 'a timeout',
    transport: () => silent(),
    code: 'search_provider_unavailable',
    status: undefined,
  },
  {
    label: 'a network failure',
    transport: () => unreachable(),
    code: 'search_provider_unavailable',
    status: undefined,
  },
  {
    label: 'a 200 whose body is not JSON',
    transport: () => status(200, `<html>${QUERY_MARKER} ${RESULT_MARKER}</html>`),
    code: 'search_provider_unavailable',
    status: 200,
  },
  {
    label: 'a 200 whose web section has no results array',
    transport: () =>
      status(
        200,
        JSON.stringify({
          type: 'search',
          web: { type: 'search' },
          query: { original: QUERY_MARKER },
        })
      ),
    code: 'search_provider_unavailable',
    status: 200,
  },
  {
    label: 'a 200 whose result has no title',
    transport: () =>
      status(
        200,
        JSON.stringify({
          type: 'search',
          web: { results: [{ url: 'https://a.example/', description: RESULT_MARKER }] },
        })
      ),
    code: 'search_provider_unavailable',
    status: 200,
  },
  {
    label: 'a 200 whose result has no url',
    transport: () =>
      status(
        200,
        JSON.stringify({
          type: 'search',
          web: { results: [{ title: RESULT_MARKER, description: RESULT_MARKER }] },
        })
      ),
    code: 'search_provider_unavailable',
    status: 200,
  },
];

const UNCAPTURED_FAILURES: readonly FailureCase[] = [
  { label: 'a rate limit', transport: () => status(429, braveErrorBody('RATE_LIMITED')) },
  { label: 'a bare HTTP 429', transport: () => status(429, '') },
  { label: "the caller's abort", transport: (caller) => abortedBy(caller) },
];

interface FailureRun {
  readonly thrown: unknown;
  readonly captures: readonly RecordedCapture[];
  readonly lines: readonly RecordedLine[];
}

async function runFailure(failure: FailureCase): Promise<FailureRun> {
  const { telemetry, captures, lines } = recordingTelemetry();
  const caller = new AbortController();
  const provider = createBraveSearchProvider({
    apiKey: TEST_KEY,
    telemetry,
    fetch: failure.transport(caller),
    timeoutMs: TIMEOUT_UNDER_TEST_MS,
  });
  const thrown = await provider.search({ query: QUERY_MARKER }, { signal: caller.signal }).then(
    () => undefined,
    (error: unknown) => error
  );
  return { thrown, captures, lines };
}

/** Everything a failure hands out of the adapter, as text: errors whole (own properties, stack) and log lines. */
function surfaces(run: FailureRun): string[] {
  const errorText = (error: unknown): string =>
    error instanceof Error
      ? [
          error.message,
          String(error.stack),
          JSON.stringify(Object.fromEntries(Object.entries(error))),
          String(error.cause),
        ].join('\n')
      : String(error);
  return [
    errorText(run.thrown),
    ...run.captures.map((capture) => errorText(capture.error)),
    ...run.lines.map((line) => JSON.stringify(line)),
  ];
}

describe('createBraveSearchProvider: failures an operator must act on', () => {
  it.each(CAPTURED_FAILURES)('throws on $label', async (failure) => {
    const { thrown } = await runFailure(failure);

    expect(thrown).toBeInstanceOf(BraveSearchError);
  });

  it.each(CAPTURED_FAILURES)('captures exactly one $code on $label', async (failure) => {
    const { captures } = await runFailure(failure);

    expect(captures.map((capture) => capture.code)).toEqual([failure.code]);
  });

  it.each(CAPTURED_FAILURES)(
    'carries the HTTP status Brave answered on $label',
    async (failure) => {
      const { captures } = await runFailure(failure);

      expect(captures.map((capture) => Reflect.get(capture.error, 'status'))).toEqual([
        failure.status,
      ]);
    }
  );

  it.each(CAPTURED_FAILURES)(
    'captures an error whose own keys are its message, name, stack and status on $label',
    async (failure) => {
      const { captures } = await runFailure(failure);

      expect(
        captures.map((capture) =>
          Object.getOwnPropertyNames(capture.error).toSorted((a, b) => a.localeCompare(b))
        )
      ).toEqual([['message', 'name', 'stack', 'status']]);
    }
  );
});

describe('createBraveSearchProvider: one request per search, with no retry', () => {
  it('makes exactly one request when the network fails', async () => {
    const transport = capturing(() => Promise.reject(new TypeError('fetch failed')));
    const provider = createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry: recordingTelemetry().telemetry,
      fetch: transport.fetch,
    });

    await expect(provider.search({ query: 'lighthouses' }, { signal: signal() })).rejects.toThrow();
    expect(transport.requests).toHaveLength(1);
  });

  it('makes exactly one request when Brave answers a server error', async () => {
    const transport = capturing(() =>
      Promise.resolve(new Response(braveErrorBody('INTERNAL'), { status: 503 }))
    );
    const provider = createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry: recordingTelemetry().telemetry,
      fetch: transport.fetch,
    });

    await expect(provider.search({ query: 'lighthouses' }, { signal: signal() })).rejects.toThrow();
    expect(transport.requests).toHaveLength(1);
  });
});

describe('createBraveSearchProvider: the default deadline', () => {
  const DEFAULT_DEADLINE_MS = 10 * SECOND_MS;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('abandons a silent Brave at ten seconds', async () => {
    // The timeout policy loads its library on first use; loading it under real
    // timers keeps that load out of the fake clock this test advances.
    await createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry: recordingTelemetry().telemetry,
      fetch: answering(braveBody([])),
    }).search({ query: 'lighthouses' }, { signal: signal() });
    freezeClock(TEST_DAY_START);
    const provider = createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry: recordingTelemetry().telemetry,
      fetch: silent(),
    });
    const search = provider.search({ query: 'lighthouses' }, { signal: signal() });
    let settled = false;
    const watching = (async (): Promise<void> => {
      await Promise.allSettled([search]);
      settled = true;
    })();

    await vi.advanceTimersByTimeAsync(DEFAULT_DEADLINE_MS - 1);
    const settledBefore = settled;
    // The deadline rules a turn after its timer fires, so the check after it allows slack.
    await vi.advanceTimersByTimeAsync(SECOND_MS);

    expect([settledBefore, settled]).toEqual([false, true]);
    await watching;
    await expect(search).rejects.toBeInstanceOf(BraveSearchError);
  });
});

describe('createBraveSearchProvider: failures nobody must act on', () => {
  it.each(UNCAPTURED_FAILURES)('throws on $label', async (failure) => {
    const { thrown } = await runFailure(failure);

    expect(thrown).toBeInstanceOf(Error);
  });

  it.each(UNCAPTURED_FAILURES)('captures nothing on $label', async (failure) => {
    const { captures } = await runFailure(failure);

    expect(captures).toEqual([]);
  });
});

describe('createBraveSearchProvider: no search content leaves on failure', () => {
  it.each([...CAPTURED_FAILURES, ...UNCAPTURED_FAILURES])(
    'leaks neither the query nor result text on $label',
    async (failure) => {
      const run = await runFailure(failure);

      const leaked = surfaces(run).filter(
        (text) => text.includes(QUERY_MARKER) || text.includes(RESULT_MARKER)
      );
      expect(leaked).toEqual([]);
    }
  );

  it('sees the query when an error does carry it, so its silence is evidence', () => {
    const planted: FailureRun = {
      thrown: new Error(`search for ${QUERY_MARKER} failed`),
      captures: [],
      lines: [],
    };

    expect(surfaces(planted).some((text) => text.includes(QUERY_MARKER))).toBe(true);
  });
});

describe('createBraveSearchProvider: the payload against the reserved result size', () => {
  const URL_PREFIX = 'https://a.example/';

  /** Five results whose every field Brave sends past its bound, so shaping leaves each at its maximum. */
  function atMaximum(): BraveResult[] {
    return Array.from({ length: 5 }, (_unused, index) => ({
      title: 't'.repeat(1000),
      url: `${URL_PREFIX}${String(index)}${'p'.repeat(500 - URL_PREFIX.length - 1)}`,
      description: 's'.repeat(1000),
      age: 'a'.repeat(1000),
    }));
  }

  /**
   * Five results dense in characters JSON must escape: a quote doubles and a
   * control character becomes six, so the serialized payload runs past the
   * bound though every field sits inside its own limit.
   */
  function escapeDense(): BraveResult[] {
    return Array.from({ length: 5 }, (_unused, index) => ({
      title: `${RESULT_MARKER}${'"'.repeat(200 - RESULT_MARKER.length)}`,
      url: `${URL_PREFIX}${String(index)}`,
      description: '\u0001'.repeat(300),
      age: '\u0002'.repeat(40),
    }));
  }

  async function searchWith(results: readonly BraveResult[]): Promise<{
    readonly shaped: WebSearchResults;
    readonly captures: readonly RecordedCapture[];
  }> {
    const { telemetry, captures } = recordingTelemetry();
    const provider = createBraveSearchProvider({
      apiKey: TEST_KEY,
      telemetry,
      fetch: answering(braveBody(results)),
    });
    const shaped = await provider.search({ query: QUERY_MARKER }, { signal: signal() });
    return { shaped, captures };
  }

  it('keeps five results with every field at its maximum length within the reserved size', async () => {
    const { shaped } = await searchWith(atMaximum());

    expect(shaped.results).toHaveLength(5);
    expect(JSON.stringify(shaped).length).toBeLessThanOrEqual(WEB_SEARCH_RESULT_MAX_CHARS);
  });

  it('captures nothing for five results at maximum length', async () => {
    const { captures } = await searchWith(atMaximum());

    expect(captures).toEqual([]);
  });

  it('returns every escape-dense result unchanged though the payload exceeds the reserved size', async () => {
    const { shaped } = await searchWith(escapeDense());

    expect(JSON.stringify(shaped).length).toBeGreaterThan(WEB_SEARCH_RESULT_MAX_CHARS);
    expect(shaped.results).toEqual(
      escapeDense().map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.description,
        age: result.age,
      }))
    );
  });

  it('captures exactly one search_result_oversize for an escape-dense payload', async () => {
    const { captures } = await searchWith(escapeDense());

    expect(captures.map((capture) => capture.code)).toEqual(['search_result_oversize']);
  });

  it('reports an oversize payload by its size alone', async () => {
    const { shaped, captures } = await searchWith(escapeDense());

    expect(
      captures.map((capture) =>
        Object.getOwnPropertyNames(capture.error).toSorted((a, b) => a.localeCompare(b))
      )
    ).toEqual([['message', 'name', 'resultChars', 'stack']]);
    expect(captures.map((capture) => Reflect.get(capture.error, 'resultChars'))).toEqual([
      JSON.stringify(shaped).length,
    ]);
  });

  it('carries no result or query text in the oversize capture', async () => {
    const { captures } = await searchWith(escapeDense());

    const leaked = surfaces({ thrown: undefined, captures, lines: [] }).filter(
      (text) => text.includes(QUERY_MARKER) || text.includes(RESULT_MARKER)
    );
    expect(leaked).toEqual([]);
  });
});
