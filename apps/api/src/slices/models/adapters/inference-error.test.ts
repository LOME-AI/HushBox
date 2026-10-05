import { describe, expect, it } from 'vitest';
import {
  InferenceError,
  abortedError,
  classifyInferenceFailure,
  emptyCompletionError,
  invalidRequestError,
  noReasoningEndpointsError,
  truncatedStreamError,
} from './inference-error.js';

function withData(message: string, data: unknown): Error {
  return Object.assign(new Error(message), { data });
}

/** An OpenRouter non-stream failure: APICallError with statusCode 200 + inner error on `.data`. */
function apiCallError(inner: unknown): Error {
  return Object.assign(new Error('OpenRouter request failed'), { statusCode: 200, data: inner });
}

describe('classifyInferenceFailure', () => {
  it('passes an existing InferenceError through unchanged', () => {
    const original = truncatedStreamError();

    expect(classifyInferenceFailure(original)).toBe(original);
  });

  it('classifies an AbortError as aborted', () => {
    const error = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });

    const classified = classifyInferenceFailure(error);
    expect(classified.code).toBe('aborted');
  });

  it('classifies a bare mid-stream error payload by its logical code', () => {
    // The `{ type: 'error', error }` stream part carries the inner error object.
    const streamError = { code: 429, message: 'slow down', type: 'rate_limit_exceeded' };

    const classified = classifyInferenceFailure(streamError);
    expect(classified.code).toBe('rate_limited');
  });

  it('classifies a 200-status APICallError body by its logical code (503)', () => {
    const classified = classifyInferenceFailure(
      apiCallError({ code: 503, message: 'upstream unavailable' })
    );

    expect(classified.code).toBe('upstream_error');
  });

  it('classifies a 402 logical code as an upstream error', () => {
    const classified = classifyInferenceFailure(
      apiCallError({ code: 402, message: 'insufficient credits' })
    );

    expect(classified.code).toBe('upstream_error');
  });

  it('classifies a ZDR-miss 404 as no_providers_available', () => {
    const classified = classifyInferenceFailure(
      apiCallError({
        code: 404,
        message: 'No endpoints available matching your guardrail restrictions and data policy',
      })
    );

    expect(classified.code).toBe('no_providers_available');
  });

  it('classifies a no_providers_available error type as no_providers_available', () => {
    const classified = classifyInferenceFailure(
      apiCallError({ code: 502, message: 'nope', type: 'no_providers_available' })
    );

    expect(classified.code).toBe('no_providers_available');
  });

  it('classifies a 400 logical code as invalid_request', () => {
    const classified = classifyInferenceFailure(apiCallError({ code: 400, message: 'bad body' }));

    expect(classified.code).toBe('invalid_request');
  });

  it('reads the error type from metadata.error_type when top-level type is absent', () => {
    const classified = classifyInferenceFailure(
      apiCallError({ code: 200, message: 'x', metadata: { error_type: 'rate_limit_exceeded' } })
    );

    expect(classified.code).toBe('rate_limited');
  });

  it('reads a metadata-only error signal (no code or type present)', () => {
    const classified = classifyInferenceFailure({
      message: 'x',
      metadata: { error_type: 'no_providers_available' },
    });

    expect(classified.code).toBe('no_providers_available');
  });

  it('coerces a numeric string logical code (503 → upstream)', () => {
    const classified = classifyInferenceFailure(apiCallError({ code: '503', message: 'x' }));

    expect(classified.code).toBe('upstream_error');
  });

  it('treats a type-only error object (no code) by its type', () => {
    const classified = classifyInferenceFailure({ type: 'rate_limit_exceeded', message: 'slow' });

    expect(classified.code).toBe('rate_limited');
  });

  it('ignores an error envelope whose error is not an object, then reads the sibling code', () => {
    const classified = classifyInferenceFailure({ error: 'not-an-object', code: 429 });

    expect(classified.code).toBe('rate_limited');
  });

  it('falls back when a signalled object fails the error schema', () => {
    // `code` is present (a signal) but not string|number → not a provider error.
    const classified = classifyInferenceFailure({ code: {} });

    expect(classified.code).toBe('upstream_error');
  });

  it('classifies a real 408 transport status as an upstream error', () => {
    const error = Object.assign(new Error('timeout'), { statusCode: 408 });

    const classified = classifyInferenceFailure(error);
    expect(classified.code).toBe('upstream_error');
  });

  it('falls back to upstream_error for a transport status that is neither 429/408/5xx', () => {
    const error = Object.assign(new Error('gone'), { statusCode: 410 });

    expect(classifyInferenceFailure(error).code).toBe('upstream_error');
  });

  it('finds the error body through the cause chain', () => {
    const inner = withData('api call failed', { error: { code: 404, message: 'no endpoints' } });
    const outer = new Error('request failed', { cause: inner });

    expect(classifyInferenceFailure(outer).code).toBe('no_providers_available');
  });

  it('parses a responseBody string when data is absent', () => {
    const error = Object.assign(new Error('api call failed'), {
      responseBody: JSON.stringify({ error: { code: 429, message: 'slow down' } }),
    });

    expect(classifyInferenceFailure(error).code).toBe('rate_limited');
  });

  it('classifies a real 429 transport status as rate_limited', () => {
    const error = Object.assign(new Error('Too many requests'), { statusCode: 429 });

    expect(classifyInferenceFailure(error).code).toBe('rate_limited');
  });

  it('classifies a real 5xx transport status as an upstream error', () => {
    const error = Object.assign(new Error('bad gateway'), { statusCode: 502 });

    const classified = classifyInferenceFailure(error);
    expect(classified.code).toBe('upstream_error');
  });

  it('ignores a non-string responseBody', () => {
    const error = Object.assign(new Error('api call failed'), { responseBody: 42 });

    expect(classifyInferenceFailure(error).code).toBe('upstream_error');
  });

  it('ignores a responseBody that is not valid JSON', () => {
    const error = Object.assign(new Error('api call failed'), { responseBody: 'not json' });

    expect(classifyInferenceFailure(error).code).toBe('upstream_error');
  });

  it('falls back to upstream_error for an unrecognized Error', () => {
    const classified = classifyInferenceFailure(new Error('something broke'));

    expect(classified.code).toBe('upstream_error');
    expect(classified.message).toContain('something broke');
  });

  it('wraps a string failure as upstream_error', () => {
    const classified = classifyInferenceFailure('plain failure');

    expect(classified.code).toBe('upstream_error');
    expect(classified.message).toContain('plain failure');
  });

  it('wraps a non-error value as upstream_error with a generic message', () => {
    const classified = classifyInferenceFailure({ odd: true });

    expect(classified.code).toBe('upstream_error');
  });

  it('preserves the original failure as cause', () => {
    const original = new Error('something broke');

    expect(classifyInferenceFailure(original).cause).toBe(original);
  });

  it('classifies a context-length overflow by its message', () => {
    const classified = classifyInferenceFailure(
      apiCallError({ code: 400, message: "This model's maximum context length is 8192 tokens" })
    );

    expect(classified.code).toBe('context_length');
  });

  it('classifies a moderation-typed failure as content_policy', () => {
    const classified = classifyInferenceFailure(
      apiCallError({ code: 403, type: 'moderation', message: 'flagged' })
    );

    expect(classified.code).toBe('content_policy');
  });

  it('classifies a content-policy message as content_policy', () => {
    const classified = classifyInferenceFailure(
      apiCallError({ code: 403, message: 'Your prompt was flagged by our moderation system' })
    );

    expect(classified.code).toBe('content_policy');
  });

  it('classifies a bare fetch-failed connection error as network', () => {
    const classified = classifyInferenceFailure(new TypeError('fetch failed'));

    expect(classified.code).toBe('network');
  });
});

describe('classifyInferenceFailure — the status it names', () => {
  it('names the logical status of a non-stream failure wrapped in a 200 response', () => {
    const classified = classifyInferenceFailure(
      apiCallError({ code: 402, message: 'insufficient credits' })
    );

    expect(classified.status).toBe(402);
  });

  it('names the numeric code of a mid-stream error part as its status', () => {
    const classified = classifyInferenceFailure({
      code: 429,
      message: 'slow down',
      type: 'rate_limit_exceeded',
    });

    expect(classified.status).toBe(429);
  });

  it('names the transport status of a failure that carries no error body', () => {
    const error = Object.assign(new Error('service unavailable'), { statusCode: 503 });

    expect(classifyInferenceFailure(error).status).toBe(503);
  });

  it('names no status for a failure classified by an error type without a logical code', () => {
    const classified = classifyInferenceFailure(apiCallError({ type: 'rate_limit_exceeded' }));

    expect(classified.status).toBeUndefined();
  });

  it('names the transport status that classified a failure beside an error body without a logical code', () => {
    const error = Object.assign(new Error('OpenRouter request failed'), {
      statusCode: 503,
      responseBody: JSON.stringify({ error: { message: 'overloaded' } }),
    });

    const classified = classifyInferenceFailure(error);

    expect([classified.code, classified.status]).toEqual(['upstream_error', 503]);
  });

  it.each([402, 401, 403])(
    'names the transport status %i beside an error body without a logical code',
    (statusCode) => {
      const error = Object.assign(new Error('OpenRouter request failed'), {
        statusCode,
        responseBody: JSON.stringify({ error: { message: 'Insufficient credits' } }),
      });

      expect(classifyInferenceFailure(error).status).toBe(statusCode);
    }
  );

  it('names no status for a 200 transport beside an error body without a logical code', () => {
    const error = Object.assign(new Error('OpenRouter request failed'), {
      statusCode: 200,
      responseBody: JSON.stringify({ error: { message: 'Insufficient credits' } }),
    });

    expect(classifyInferenceFailure(error).status).toBeUndefined();
  });

  it('names no status for a 200 transport that carries no recognizable error body', () => {
    expect(classifyInferenceFailure(apiCallError({ message: 'odd' })).status).toBeUndefined();
  });

  it.each([200, 401, 503, undefined])(
    'names the logical code over the transport status %s',
    (statusCode) => {
      const error = Object.assign(new Error('OpenRouter request failed'), {
        statusCode,
        data: { code: 402, message: 'Insufficient credits' },
      });

      expect(classifyInferenceFailure(error).status).toBe(402);
    }
  );

  it('names no status for a logical code that is not an integer', () => {
    const classified = classifyInferenceFailure({ code: '502.5', message: 'odd' });

    expect(classified.status).toBeUndefined();
  });

  it('names no status for a connection failure', () => {
    expect(classifyInferenceFailure(new TypeError('fetch failed')).status).toBeUndefined();
  });

  it('names the logical status of a failure classified by its reason', () => {
    const classified = classifyInferenceFailure(
      apiCallError({ code: 403, type: 'moderation', message: 'flagged' })
    );

    expect(classified.status).toBe(403);
  });
});

describe('error factories', () => {
  it('builds an aborted error carrying the reason', () => {
    const error = abortedError('hard stop');

    expect(error).toBeInstanceOf(InferenceError);
    expect(error.code).toBe('aborted');
    expect(error.message).toContain('hard stop');
  });

  it('builds an aborted error without a reason', () => {
    expect(abortedError().code).toBe('aborted');
  });

  it('builds a truncated stream error', () => {
    const error = truncatedStreamError();
    expect(error.code).toBe('truncated_stream');
  });

  it('builds an empty completion error without a finish reason', () => {
    expect(emptyCompletionError().message).toContain('unknown');
  });

  it('builds an empty completion error naming the finish reason', () => {
    const error = emptyCompletionError('content-filter');

    expect(error.code).toBe('empty_completion');
    expect(error.message).toContain('content-filter');
  });

  it('builds an invalid request error', () => {
    const error = invalidRequestError('bad param');
    expect(error.code).toBe('invalid_request');
  });

  it('builds a no-reasoning-endpoints error carrying the status of the error it wraps', () => {
    const noProviders = classifyInferenceFailure(
      apiCallError({ code: 503, type: 'no_providers_available', message: 'no endpoints' })
    );

    const error = noReasoningEndpointsError(noProviders);

    expect([error.code, error.status, error.cause]).toEqual([
      'no_reasoning_endpoints',
      503,
      noProviders,
    ]);
  });
});
