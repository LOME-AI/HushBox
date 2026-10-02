import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchCrawl, fetchSitemap } from './api';
import type { CrawlView } from '../engine';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

interface FakeFetch {
  impl: typeof fetch;
  calls: Call[];
}

function requestedUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.toString() : input.url;
}

function respondWith(status: number, body: string): FakeFetch {
  const calls: Call[] = [];
  const impl: typeof fetch = (input, init) => {
    calls.push({ url: requestedUrl(input), init });
    return Promise.resolve(new Response(body, { status }));
  };
  return { impl, calls };
}

function failWith(failure: unknown): FakeFetch {
  const calls: Call[] = [];
  const impl: typeof fetch = (input, init) => {
    calls.push({ url: requestedUrl(input), init });
    throw failure;
  };
  return { impl, calls };
}

const VIEW_JSON = '{"url":"http://localhost:4321/","http":{"status":200}}';

function stubFetch(fake: FakeFetch): FakeFetch {
  vi.stubGlobal('fetch', fake.impl);
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchCrawl', () => {
  it('returns the parsed view and requests the url encoded as a query param', async () => {
    const fake = stubFetch(respondWith(200, VIEW_JSON));

    const outcome = await fetchCrawl('http://localhost:4321/?a=b');

    expect(fake.calls[0]?.url).toBe('/api/crawl?url=http%3A%2F%2Flocalhost%3A4321%2F%3Fa%3Db');
    expect(outcome).toEqual({ ok: true, view: JSON.parse(VIEW_JSON) as CrawlView });
  });

  it('surfaces the invalid_url envelope verbatim', async () => {
    stubFetch(respondWith(400, '{"error":{"code":"invalid_url","message":"Provide `url`."}}'));

    const outcome = await fetchCrawl('nonsense');

    expect(outcome).toEqual({ ok: false, code: 'invalid_url', message: 'Provide `url`.' });
  });

  it('surfaces the analyze_failed envelope verbatim', async () => {
    stubFetch(respondWith(502, '{"error":{"code":"analyze_failed","message":"Failed."}}'));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toEqual({ ok: false, code: 'analyze_failed', message: 'Failed.' });
  });

  it('reports the status when an error body carries no error member', async () => {
    stubFetch(respondWith(503, '{"detail":"gateway"}'));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toEqual({
      ok: false,
      code: 'unexpected_response',
      message: 'Server returned status 503.',
    });
  });

  it('reports the status when the error member is not an object', async () => {
    stubFetch(respondWith(500, '{"error":"boom"}'));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toMatchObject({ ok: false, code: 'unexpected_response' });
  });

  it('reports the status when the error member is null', async () => {
    stubFetch(respondWith(500, '{"error":null}'));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toMatchObject({ ok: false, code: 'unexpected_response' });
  });

  it('reports the status when the error member carries no string code', async () => {
    stubFetch(respondWith(500, '{"error":{"message":"no code here"}}'));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toMatchObject({ ok: false, code: 'unexpected_response' });
  });

  it('reports the status when the body is not an object', async () => {
    stubFetch(respondWith(500, '"just a string"'));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toMatchObject({ ok: false, code: 'unexpected_response' });
  });

  it('reports the status when the body is null', async () => {
    stubFetch(respondWith(500, 'null'));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toMatchObject({ ok: false, code: 'unexpected_response' });
  });

  it('reports the status when the body is not JSON at all', async () => {
    stubFetch(respondWith(500, '<html>proxy error</html>'));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toEqual({
      ok: false,
      code: 'unexpected_response',
      message: 'Server returned status 500.',
    });
  });

  it('reports a transport failure under network_error with the failure message', async () => {
    stubFetch(failWith(new TypeError('Failed to fetch')));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toEqual({
      ok: false,
      code: 'network_error',
      message: 'Failed to fetch',
    });
  });

  it('reports a transport failure that is not an Error under a generic message', async () => {
    const nonError: unknown = 'connection reset';
    stubFetch(failWith(nonError));

    const outcome = await fetchCrawl('http://localhost:4321/');

    expect(outcome).toEqual({
      ok: false,
      code: 'network_error',
      message: 'Request failed before reaching the server.',
    });
  });

  it('passes an abort signal through to the request', async () => {
    const fake = stubFetch(respondWith(200, VIEW_JSON));
    const controller = new AbortController();

    await fetchCrawl('http://localhost:4321/', controller.signal);

    expect(fake.calls[0]?.init).toEqual({ signal: controller.signal });
  });

  it('sends no request options when no signal is given', async () => {
    const fake = stubFetch(respondWith(200, VIEW_JSON));

    await fetchCrawl('http://localhost:4321/');

    expect(fake.calls[0]?.init).toEqual({});
  });
});

describe('fetchSitemap', () => {
  it('returns the parsed targets', async () => {
    const fake = stubFetch(
      respondWith(
        200,
        '{"targets":[{"label":"web","origin":"http://localhost:5173","urls":["http://localhost:5173/"]}]}'
      )
    );

    const response = await fetchSitemap();

    expect(fake.calls[0]?.url).toBe('/api/sitemap');
    expect(response.targets[0]?.urls).toEqual(['http://localhost:5173/']);
  });

  it('throws with the status when the request fails', async () => {
    stubFetch(respondWith(503, ''));

    await expect(fetchSitemap()).rejects.toThrow('sitemap request failed with status 503');
  });

  it('passes an abort signal through to the request', async () => {
    const fake = stubFetch(respondWith(200, '{"targets":[]}'));
    const controller = new AbortController();

    await fetchSitemap(controller.signal);

    expect(fake.calls[0]?.init).toEqual({ signal: controller.signal });
  });

  it('sends no request options when no signal is given', async () => {
    const fake = stubFetch(respondWith(200, '{"targets":[]}'));

    await fetchSitemap();

    expect(fake.calls[0]?.init).toEqual({});
  });
});
