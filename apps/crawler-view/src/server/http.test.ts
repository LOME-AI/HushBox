import { describe, it, expect } from 'vitest';
import { applyCors, getQueryParameter, handlePreflight, sendJson } from './http';
import type { RequestLike, ResponseLike } from './http';

interface FakeRes extends ResponseLike {
  headers: Record<string, string>;
  body: string | undefined;
  endCalls: number;
}

function makeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    endCalls: 0,
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string): void {
      this.body = chunk;
      this.endCalls += 1;
    },
  };
}

function makeReq(headers: RequestLike['headers'], method?: string): RequestLike {
  return method === undefined ? { headers } : { headers, method };
}

describe('sendJson', () => {
  it('writes the status, a JSON content type, and the serialized body', () => {
    const res = makeRes();

    sendJson(res, 418, { hello: 'world' });

    expect(res.statusCode).toBe(418);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.body).toBe('{"hello":"world"}');
    expect(res.endCalls).toBe(1);
  });
});

describe('applyCors', () => {
  it('reflects a localhost origin with the full allow-header set', () => {
    const res = makeRes();

    applyCors(makeReq({ origin: 'http://localhost:4321' }), res);

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4321');
    expect(res.headers['vary']).toBe('Origin');
    expect(res.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type');
  });

  it('reflects a 127.0.0.1 origin', () => {
    const res = makeRes();

    applyCors(makeReq({ origin: 'http://127.0.0.1:5173' }), res);

    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
  });

  it('reflects the first value when the origin header repeats', () => {
    const res = makeRes();

    applyCors(makeReq({ origin: ['http://localhost:4321', 'http://localhost:5173'] }), res);

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:4321');
  });

  it('sets nothing when the origin header is an empty list', () => {
    const res = makeRes();

    applyCors(makeReq({ origin: [] }), res);

    expect(res.headers).toEqual({});
  });

  it('sets nothing when the request carries no origin', () => {
    const res = makeRes();

    applyCors(makeReq({}), res);

    expect(res.headers).toEqual({});
  });

  it('ignores an https localhost origin', () => {
    const res = makeRes();

    applyCors(makeReq({ origin: 'https://localhost:4321' }), res);

    expect(res.headers).toEqual({});
  });

  it('ignores a remote origin', () => {
    const res = makeRes();

    applyCors(makeReq({ origin: 'http://evil.example.com' }), res);

    expect(res.headers).toEqual({});
  });

  it('ignores an origin whose scheme is not http', () => {
    const res = makeRes();

    applyCors(makeReq({ origin: 'localhost:4321' }), res);

    expect(res.headers).toEqual({});
  });

  it('ignores an origin the URL parser rejects', () => {
    const res = makeRes();

    applyCors(makeReq({ origin: 'http://[' }), res);

    expect(res.headers).toEqual({});
  });
});

describe('handlePreflight', () => {
  it('answers an OPTIONS request with an empty 204 and reports it handled', () => {
    const res = makeRes();

    const handled = handlePreflight(makeReq({}, 'OPTIONS'), res);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(204);
    expect(res.endCalls).toBe(1);
    expect(res.body).toBeUndefined();
  });

  it('leaves a GET request untouched and reports it unhandled', () => {
    const res = makeRes();

    const handled = handlePreflight(makeReq({}, 'GET'), res);

    expect(handled).toBe(false);
    expect(res.statusCode).toBe(0);
    expect(res.endCalls).toBe(0);
  });

  it('leaves a request with no method untouched', () => {
    const res = makeRes();

    const handled = handlePreflight(makeReq({}), res);

    expect(handled).toBe(false);
    expect(res.endCalls).toBe(0);
  });
});

describe('getQueryParameter', () => {
  it('reads a param from a mount-relative url', () => {
    expect(getQueryParameter('/?url=http%3A%2F%2Flocalhost%3A1%2F', 'url')).toBe(
      'http://localhost:1/'
    );
  });

  it('reads a param from an absolute url', () => {
    expect(getQueryParameter('http://localhost:7000/api/crawl?url=x', 'url')).toBe('x');
  });

  it('returns null when the param is absent', () => {
    expect(getQueryParameter('/?other=1', 'url')).toBeNull();
  });

  it('returns null for an undefined url', () => {
    expect(getQueryParameter(undefined, 'url')).toBeNull();
  });

  it('returns null for an empty url', () => {
    expect(getQueryParameter('', 'url')).toBeNull();
  });

  it('returns null for a url the URL parser rejects', () => {
    expect(getQueryParameter('http://[?url=x', 'url')).toBeNull();
  });
});
