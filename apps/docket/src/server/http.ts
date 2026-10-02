/**
 * Framework-free HTTP helpers for the dev-only console API. Typed against small
 * structural shapes so the routes stay unit-testable with fake req/res objects;
 * a real Node `IncomingMessage`/`ServerResponse` satisfies them.
 */

export interface RequestLike {
  url?: string | undefined;
  method?: string | undefined;
}

export interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  write(chunk: string): unknown;
  end(chunk?: string): unknown;
}

export type BodyStream = AsyncIterable<Buffer | string>;

type JsonBodyOutcome =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false; readonly error: 'invalid-json' | 'too-large' };

/** Generous for a ruling with a paragraph of text, far below anything abusive. */
const MAX_BODY_BYTES = 256 * 1024;

export function sendJson(res: ResponseLike, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/**
 * Buffers and parses a JSON request body, refusing anything past the cap rather
 * than holding it in memory first. An empty body reads as `{}` so a route whose
 * input is optional needs no body at all.
 */
export async function readJsonBody(
  stream: BodyStream,
  limit: number = MAX_BODY_BYTES
): Promise<JsonBodyOutcome> {
  let text = '';
  for await (const chunk of stream) {
    text += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length > limit) return { ok: false, error: 'too-large' };
  }

  if (text.trim() === '') return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'invalid-json' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid-json' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

interface ParsedUrl {
  readonly pathname: string;
  readonly params: URLSearchParams;
}

/** Reads a connect-style `req.url`, which carries a path and query but no origin. */
export function parseUrl(rawUrl: string | undefined): ParsedUrl {
  const url = new URL(rawUrl ?? '/', 'http://localhost');
  return { pathname: url.pathname, params: url.searchParams };
}
