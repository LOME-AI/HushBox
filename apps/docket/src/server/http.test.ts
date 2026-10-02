import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { parseUrl, readJsonBody, sendJson, type ResponseLike } from './http';

function fakeResponse(): ResponseLike & { headers: Record<string, string>; body: string } {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    end(chunk?: string) {
      this.body = chunk ?? '';
    },
    write(chunk: string) {
      this.body += chunk;
    },
  };
}

function chunks(...parts: readonly string[]): AsyncIterable<Buffer> {
  return Readable.from(parts.map((part) => Buffer.from(part, 'utf8')));
}

describe('sendJson', () => {
  it('writes the status, the json content type and the serialized body', () => {
    const res = fakeResponse();

    sendJson(res, 201, { id: 'AC-1' });

    expect(res.statusCode).toBe(201);
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(JSON.parse(res.body)).toEqual({ id: 'AC-1' });
  });
});

describe('readJsonBody', () => {
  it('parses a json object split across chunks', async () => {
    const outcome = await readJsonBody(chunks('{"option":', '"A"}'));

    expect(outcome).toEqual({ ok: true, value: { option: 'A' } });
  });

  it('parses a stream that yields strings rather than buffers', async () => {
    const text: AsyncIterable<string> = Readable.from(['{"token":', '"abc"}']);

    expect(await readJsonBody(text)).toEqual({ ok: true, value: { token: 'abc' } });
  });

  it('reads an empty body as an empty object, so a no-body route needs no client body', async () => {
    const outcome = await readJsonBody(chunks());

    expect(outcome).toEqual({ ok: true, value: {} });
  });

  it('refuses a body that is not json', async () => {
    const outcome = await readJsonBody(chunks('not json'));

    expect(outcome).toEqual({ ok: false, error: 'invalid-json' });
  });

  it('refuses a body past the size cap rather than buffering it', async () => {
    const outcome = await readJsonBody(chunks('x'.repeat(20)), 8);

    expect(outcome).toEqual({ ok: false, error: 'too-large' });
  });

  it('refuses a json value that is not an object', async () => {
    const outcome = await readJsonBody(chunks('"a string"'));

    expect(outcome).toEqual({ ok: false, error: 'invalid-json' });
  });
});

describe('parseUrl', () => {
  it('splits the path from the query', () => {
    const { pathname, params } = parseUrl('/api/source?path=a.ts&start=4');

    expect(pathname).toBe('/api/source');
    expect(params.get('path')).toBe('a.ts');
    expect(params.get('start')).toBe('4');
  });

  it('reads a path with no query', () => {
    expect(parseUrl('/api/audit').pathname).toBe('/api/audit');
  });

  it('reads a missing url as the root path', () => {
    const missing: string | undefined = undefined;
    expect(parseUrl(missing).pathname).toBe('/');
  });
});
