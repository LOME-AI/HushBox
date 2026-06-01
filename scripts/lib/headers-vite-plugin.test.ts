import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ServerResponse, IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import {
  parseHeadersFile,
  matchHeaders,
  applyHeaders,
  headersPlugin,
  HeadersParseError,
  type HeaderRule,
} from './headers-vite-plugin.js';

function rule(pattern: string, headers: Record<string, string>): HeaderRule {
  const [parsed] = parseHeadersFile(
    `${pattern}\n  ${Object.entries(headers)
      .map(([n, v]) => `${n}: ${v}`)
      .join('\n  ')}`
  );
  if (!parsed) throw new Error('failed to build test rule');
  return parsed;
}

function makeResponse(): ServerResponse {
  const req = new IncomingMessage(new Socket());
  return new ServerResponse(req);
}

describe('parseHeadersFile', () => {
  it('parses a single rule', () => {
    const rules = parseHeadersFile('/welcome\n  X-Foo: bar');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.pattern).toBe('/welcome');
    expect(rules[0]?.headers).toEqual({ 'X-Foo': 'bar' });
  });

  it('parses multiple rules separated by blank lines', () => {
    const rules = parseHeadersFile('/welcome\n  X-Foo: bar\n\n/blog\n  X-Baz: qux');
    expect(rules).toHaveLength(2);
    expect(rules[0]?.pattern).toBe('/welcome');
    expect(rules[1]?.pattern).toBe('/blog');
  });

  it('parses multiple rules without blank lines between them', () => {
    const rules = parseHeadersFile('/welcome\n  X-Foo: bar\n/blog\n  X-Baz: qux');
    expect(rules).toHaveLength(2);
    expect(rules[1]?.pattern).toBe('/blog');
    expect(rules[1]?.headers).toEqual({ 'X-Baz': 'qux' });
  });

  it('ignores full-line comments', () => {
    const rules = parseHeadersFile('# header\n/welcome\n  # inline-ish\n  X-Foo: bar');
    expect(rules).toHaveLength(1);
    expect(rules[0]?.headers).toEqual({ 'X-Foo': 'bar' });
  });

  it('handles CRLF line endings', () => {
    const rules = parseHeadersFile('/welcome\r\n  X-Foo: bar\r\n');
    expect(rules[0]?.headers).toEqual({ 'X-Foo': 'bar' });
  });

  it('accepts tab-indented header lines', () => {
    const rules = parseHeadersFile('/welcome\n\tX-Foo: bar');
    expect(rules[0]?.headers).toEqual({ 'X-Foo': 'bar' });
  });

  it('preserves values containing colons', () => {
    const rules = parseHeadersFile(
      "/welcome\n  Content-Security-Policy: default-src 'self'; script-src 'self'"
    );
    expect(rules[0]?.headers['Content-Security-Policy']).toBe(
      "default-src 'self'; script-src 'self'"
    );
  });

  it('throws when a header line has no preceding pattern', () => {
    expect(() => parseHeadersFile('  X-Foo: bar')).toThrow(HeadersParseError);
  });

  it('throws on malformed header lines (no colon)', () => {
    expect(() => parseHeadersFile('/welcome\n  X-Foo bar')).toThrow(HeadersParseError);
  });

  it('throws on empty header name', () => {
    expect(() => parseHeadersFile('/welcome\n  : bar')).toThrow(HeadersParseError);
  });

  it('throws on empty header value', () => {
    expect(() => parseHeadersFile('/welcome\n  X-Foo: ')).toThrow(HeadersParseError);
  });

  it('reports line numbers in errors', () => {
    try {
      parseHeadersFile('# comment\n  X-Foo: bar');
    } catch (error) {
      expect(error).toBeInstanceOf(HeadersParseError);
      expect((error as HeadersParseError).line).toBe(2);
      return;
    }
    throw new Error('expected parse to throw');
  });

  it('returns an empty array for an empty file', () => {
    expect(parseHeadersFile('')).toEqual([]);
    expect(parseHeadersFile('\n\n# only comments\n')).toEqual([]);
  });
});

describe('matchHeaders', () => {
  const allRules = [
    rule('/welcome', { 'X-Marketing': 'true' }),
    rule('/blog/*', { 'X-Blog': 'true' }),
    rule('/*', { 'X-Catch-All': 'true' }),
  ];

  it('matches a literal path', () => {
    expect(matchHeaders(allRules, '/welcome')).toEqual({
      'X-Marketing': 'true',
      'X-Catch-All': 'true',
    });
  });

  it('treats a trailing slash as a distinct path (Cloudflare Pages parity)', () => {
    // Cloudflare Pages `_headers` is exact-match per path. The preview
    // server must mirror that — otherwise lenient trailing-slash matching
    // here hides production CSP bugs (e.g. an `_headers` block keyed at
    // `/welcome` would silently work in preview but miss `/welcome/` in
    // prod, falling through to the SPA `/*` fallback).
    expect(matchHeaders(allRules, '/welcome/')).toEqual({ 'X-Catch-All': 'true' });
    expect(matchHeaders(allRules, '/welcome/')['X-Marketing']).toBeUndefined();
  });

  it('strips query strings before matching', () => {
    expect(matchHeaders(allRules, '/welcome?utm=x')['X-Marketing']).toBe('true');
  });

  it('strips hash fragments before matching', () => {
    expect(matchHeaders(allRules, '/welcome#section')['X-Marketing']).toBe('true');
  });

  it('matches a wildcard path', () => {
    expect(matchHeaders(allRules, '/blog/some-post')['X-Blog']).toBe('true');
  });

  it('falls back to /* for unknown paths', () => {
    expect(matchHeaders(allRules, '/chat/123')).toEqual({ 'X-Catch-All': 'true' });
  });

  it('lets more specific rules override the same header from less specific ones', () => {
    const rules = [rule('/*', { 'X-CSP': 'spa' }), rule('/welcome', { 'X-CSP': 'marketing' })];
    expect(matchHeaders(rules, '/welcome')['X-CSP']).toBe('marketing');
    expect(matchHeaders(rules, '/chat')['X-CSP']).toBe('spa');
  });

  it('returns an empty object when nothing matches', () => {
    const rules = [rule('/only-this-path', { 'X-Foo': 'bar' })];
    expect(matchHeaders(rules, '/something-else')).toEqual({});
  });

  it('matches wildcard prefix paths like /welcome*', () => {
    const rules = [rule('/welcome*', { 'X-Marketing': 'true' })];
    expect(matchHeaders(rules, '/welcome')['X-Marketing']).toBe('true');
    expect(matchHeaders(rules, '/welcome/anything')['X-Marketing']).toBe('true');
  });
});

describe('applyHeaders', () => {
  it('applies every header verbatim', () => {
    const res = makeResponse();
    applyHeaders(res, {
      'Content-Security-Policy': "default-src 'self'",
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    expect(res.getHeader('Content-Security-Policy')).toBe("default-src 'self'");
    expect(res.getHeader('X-Frame-Options')).toBe('DENY');
    expect(res.getHeader('Referrer-Policy')).toBe('no-referrer');
  });

  it('is a no-op when given an empty headers object', () => {
    const res = makeResponse();
    applyHeaders(res, {});
    expect(res.getHeaderNames()).toEqual([]);
  });
});

describe('headersPlugin', () => {
  let temporaryDir: string;
  let headersFile: string;

  beforeEach(async () => {
    temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'headers-plugin-'));
    headersFile = path.join(temporaryDir, '_headers');
  });

  afterEach(async () => {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  });

  it('returns a Plugin with the expected name', () => {
    const plugin = headersPlugin({ headersFile });
    expect(plugin.name).toBe('headers-vite-plugin');
  });

  it('does not register a dev-server hook (dev parity is not supported)', () => {
    const plugin = headersPlugin({ headersFile });
    expect(plugin.configureServer).toBeUndefined();
  });

  it('registers a preview-server middleware that applies headers enforced', async () => {
    await fs.writeFile(
      headersFile,
      "/welcome\n  Content-Security-Policy: default-src 'self'\n  X-Frame-Options: DENY"
    );
    const plugin = headersPlugin({ headersFile });

    const middlewares: ((req: { url?: string }, res: ServerResponse, next: () => void) => void)[] =
      [];
    const fakeServer = {
      middlewares: {
        use: (mw: (req: { url?: string }, res: ServerResponse, next: () => void) => void) =>
          middlewares.push(mw),
      },
    } as never;

    const configure = plugin.configurePreviewServer;
    if (typeof configure !== 'function')
      throw new Error('configurePreviewServer should be a function');
    await configure.call({} as never, fakeServer);

    const res = makeResponse();
    let nextCalled = false;
    middlewares[0]?.({ url: '/welcome' }, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.getHeader('Content-Security-Policy')).toBe("default-src 'self'");
    expect(res.getHeader('Content-Security-Policy-Report-Only')).toBeUndefined();
    expect(res.getHeader('X-Frame-Options')).toBe('DENY');
  });

  it('throws when the headers file is missing (fail-loud — broken chain must not silently skip CSP)', () => {
    const plugin = headersPlugin({ headersFile });
    const fakeServer = {
      middlewares: { use: () => {} },
    } as never;

    const configure = plugin.configurePreviewServer;
    if (typeof configure !== 'function')
      throw new Error('configurePreviewServer should be a function');
    expect(() => configure.call({} as never, fakeServer)).toThrow(/not found/);
  });

  it('middleware passes through when request has no URL', async () => {
    await fs.writeFile(headersFile, '/welcome\n  X-Foo: bar');
    const plugin = headersPlugin({ headersFile });

    const middlewares: ((req: { url?: string }, res: ServerResponse, next: () => void) => void)[] =
      [];
    const fakeServer = {
      middlewares: {
        use: (mw: (req: { url?: string }, res: ServerResponse, next: () => void) => void) =>
          middlewares.push(mw),
      },
    } as never;

    const configure = plugin.configurePreviewServer;
    if (typeof configure !== 'function')
      throw new Error('configurePreviewServer should be a function');
    await configure.call({} as never, fakeServer);

    const res = makeResponse();
    let nextCalled = false;
    middlewares[0]?.({}, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.getHeader('X-Foo')).toBeUndefined();
  });
});
