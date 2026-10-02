/**
 * Typed inference errors for the ModelProvider adapters.
 *
 * The port's stream has no error event variant — failures travel as thrown
 * `InferenceError`s carrying a closed code set. A classification built from an
 * Error-shaped provider/SDK failure preserves that failure on `cause`; a
 * string stream-error payload is interpolated into the message;
 * locally-synthesized failures — aborts, truncation, empty completions,
 * invalid requests — carry no cause. Messages carry codes and shapes, never
 * content.
 *
 * OpenRouter surfaces failures two ways, and NEITHER carries a transport
 * status that reflects the failure:
 *   - mid-stream: a `{ type: 'error', error }` stream part (`finishReason:
 *     'error'`), where `error` is the inner OpenRouter error object;
 *   - non-stream: an `APICallError` with `statusCode: 200` wrapping a body
 *     `{ error: { code, message, type, metadata } }` (the parsed inner object
 *     lands on `.data`).
 * So the code is decided by the LOGICAL `error.code` and `error.type`, never by
 * `APICallError.statusCode`. A ZDR miss is a logical 404 ("No endpoints
 * available matching your guardrail restrictions and data policy") — a
 * no-providers error.
 */

import { z } from 'zod';

export const INFERENCE_ERROR_CODES = [
  'invalid_request',
  'unsupported_modality',
  'no_providers_available',
  'no_reasoning_endpoints',
  'rate_limited',
  'content_policy',
  'context_length',
  'network',
  'aborted',
  'truncated_stream',
  'empty_completion',
  'upstream_error',
] as const;

export type InferenceErrorCode = (typeof INFERENCE_ERROR_CODES)[number];

interface InferenceErrorOptions {
  cause?: unknown;
}

export class InferenceError extends Error {
  readonly code: InferenceErrorCode;

  constructor(code: InferenceErrorCode, message: string, options?: InferenceErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'InferenceError';
    this.code = code;
  }
}

export function abortedError(reason?: string): InferenceError {
  return new InferenceError(
    'aborted',
    reason === undefined ? 'Inference aborted' : `Inference aborted: ${reason}`
  );
}

export function truncatedStreamError(): InferenceError {
  return new InferenceError('truncated_stream', 'Stream ended without the provider finish part');
}

export function emptyCompletionError(finishReason?: string): InferenceError {
  return new InferenceError(
    'empty_completion',
    `Model produced no output (finishReason: ${finishReason ?? 'unknown'})`
  );
}

export function invalidRequestError(message: string): InferenceError {
  return new InferenceError('invalid_request', message);
}

/**
 * The no-endpoints refusal on a reasoning call: the require-parameters
 * routing guard rides every request that carries a reasoning config, so
 * OpenRouter's logical-404 "no endpoints" can also mean "no endpoint
 * supports reasoning under the pinned routing" — typed distinctly from the
 * plain ZDR no-providers miss so the client can suggest changing
 * effort/model rather than a generic unavailability.
 */
export function noReasoningEndpointsError(cause: unknown): InferenceError {
  return new InferenceError(
    'no_reasoning_endpoints',
    'No endpoints support the reasoning config under the pinned routing',
    { cause }
  );
}

/**
 * The honest audio/embedding disposition: no call-shape adapter exists for
 * the family (embedding until a consumer does), so the request is refused with
 * a typed error, never crashed on.
 */
export function unsupportedModalityError(outputs: readonly string[]): InferenceError {
  return new InferenceError(
    'unsupported_modality',
    `No call-shape adapter for model outputs (${outputs.join(', ')})`
  );
}

/**
 * OpenRouter's error object — the inner `{ code, message, type, metadata }`.
 * It appears bare (a stream error-part payload, or an APICallError's `.data`)
 * or wrapped as `{ error: … }` (a raw response body). `code` may be a number
 * or a numeric string; `type` may also live at `metadata.error_type`.
 */
const openrouterErrorObjectSchema = z.looseObject({
  code: z.union([z.string(), z.number()]).nullish(),
  message: z.string().nullish(),
  type: z.string().nullish(),
  metadata: z.looseObject({ error_type: z.string().nullish() }).nullish(),
});

const openrouterErrorEnvelopeSchema = z.looseObject({
  error: openrouterErrorObjectSchema,
});

interface OpenRouterErrorFacts {
  code: number | undefined;
  type: string | undefined;
  message: string | undefined;
}

function numericCode(value: string | number | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

type OpenRouterErrorObject = z.infer<typeof openrouterErrorObjectSchema>;

function factsFromObject(object: OpenRouterErrorObject): OpenRouterErrorFacts {
  return {
    code: numericCode(object.code),
    type: object.type ?? object.metadata?.error_type ?? undefined,
    message: object.message ?? undefined,
  };
}

/**
 * Does the object carry an explicit OpenRouter error signal (`code`/`type`, or
 * `metadata.error_type`)? A plain `Error` carries only `message`, so requiring
 * a real signal keeps it from being misread as a provider error object.
 */
function hasErrorSignal(record: Record<string, unknown>): boolean {
  if ('code' in record || 'type' in record) return true;
  const metadata = record['metadata'];
  return typeof metadata === 'object' && metadata !== null && 'error_type' in metadata;
}

/** Recognize an OpenRouter error object — wrapped `{ error: … }` or bare. */
function openrouterErrorFacts(candidate: unknown): OpenRouterErrorFacts | undefined {
  if (candidate === null || typeof candidate !== 'object') return undefined;

  if ('error' in candidate) {
    const envelope = openrouterErrorEnvelopeSchema.safeParse(candidate);
    if (envelope.success) return factsFromObject(envelope.data.error);
  }

  if (!hasErrorSignal(candidate as Record<string, unknown>)) return undefined;
  const parsed = openrouterErrorObjectSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return factsFromObject(parsed.data);
}

/** Pull an OpenRouter error body off an SDK error (parsed `data` or raw `responseBody`). */
function errorBodyFacts(error: object): OpenRouterErrorFacts | undefined {
  const direct = openrouterErrorFacts(error);
  if (direct !== undefined) return direct;

  const data = (error as { data?: unknown }).data;
  const fromData = openrouterErrorFacts(data);
  if (fromData !== undefined) return fromData;

  const responseBody = (error as { responseBody?: unknown }).responseBody;
  if (typeof responseBody !== 'string') return undefined;
  try {
    return openrouterErrorFacts(JSON.parse(responseBody));
    // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort error-fact extraction; an unparseable body yields no facts.
  } catch {
    return undefined;
  }
}

function statusCodeOf(error: object): number | undefined {
  const candidates: unknown[] = [
    (error as { statusCode?: unknown }).statusCode,
    (error as { status?: unknown }).status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

interface ChainFacts {
  aborted: boolean;
  status: number | undefined;
  error: OpenRouterErrorFacts | undefined;
  message: string | undefined;
}

/** Walk the error and its `cause` chain, keeping the first fact of each kind. */
function collectChainFacts(value: unknown): ChainFacts {
  const facts: ChainFacts = {
    aborted: false,
    status: undefined,
    error: undefined,
    message: undefined,
  };
  let current: unknown = value;
  // Bounded walk: a pathological self-referencing cause chain must not spin.
  for (let depth = 0; depth < 8 && typeof current === 'object' && current !== null; depth++) {
    if (current instanceof Error) {
      if (current.name === 'AbortError') facts.aborted = true;
      facts.message ??= current.message;
    }
    facts.status ??= statusCodeOf(current);
    facts.error ??= errorBodyFacts(current);
    current = (current as { cause?: unknown }).cause;
  }
  return facts;
}

function rateLimited(value: unknown): InferenceError {
  return new InferenceError('rate_limited', 'Provider rate limit exceeded', { cause: value });
}

function upstreamError(label: string, value: unknown): InferenceError {
  return new InferenceError('upstream_error', `Inference upstream error (${label})`, {
    cause: value,
  });
}

/** Classify from the LOGICAL OpenRouter error code/type, never the transport status. */
function classifyByErrorObject(
  error: OpenRouterErrorFacts | undefined,
  value: unknown
): InferenceError | undefined {
  if (error === undefined) return undefined;
  const { code, type } = error;
  if (type === 'no_providers_available' || code === 404) {
    return new InferenceError(
      'no_providers_available',
      'No ZDR-eligible providers available for the request',
      { cause: value }
    );
  }
  if (type === 'rate_limit_exceeded' || code === 429) return rateLimited(value);
  if (code === 400) {
    return new InferenceError('invalid_request', 'Provider rejected the request as invalid', {
      cause: value,
    });
  }
  if (code !== undefined) return upstreamError(String(code), value);
  return undefined;
}

function indicatesContextLength(message: string | undefined): boolean {
  if (message === undefined) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('context length') ||
    lower.includes('context_length') ||
    lower.includes('maximum context')
  );
}

function indicatesContentPolicy(type: string | undefined, message: string | undefined): boolean {
  if (type?.toLowerCase() === 'moderation') return true;
  if (message === undefined) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('content policy') ||
    lower.includes('moderation') ||
    lower.includes('safety') ||
    lower.includes('harmful') ||
    lower.includes('flagged')
  );
}

/**
 * Classify by the LOGICAL failure reason carried in the message/type, ahead of
 * the HTTP-shaped code/status buckets: a context-length overflow (often a
 * logical 400) and a moderation refusal (often a logical 403) each get their
 * own code so the client can render a targeted next action rather than a
 * generic "unavailable".
 */
function classifyByReason(facts: ChainFacts, value: unknown): InferenceError | undefined {
  const messages = [facts.error?.message, facts.message];
  if (messages.some((message) => indicatesContextLength(message))) {
    return new InferenceError('context_length', 'Request exceeds the model context length', {
      cause: value,
    });
  }
  if (messages.some((message) => indicatesContentPolicy(facts.error?.type, message))) {
    return new InferenceError('content_policy', 'Request refused by provider content policy', {
      cause: value,
    });
  }
  return undefined;
}

const NETWORK_MESSAGE_MARKERS = [
  'fetch failed',
  'network',
  'econnreset',
  'econnrefused',
  'enotfound',
  'socket hang up',
];

/**
 * A genuine connection failure: no logical error body and no transport status
 * ever arrived, so nothing reached the provider — a link cut, not a request the
 * provider rejected.
 */
function isNetworkFailure(facts: ChainFacts, value: unknown): boolean {
  if (facts.status !== undefined || facts.error !== undefined) return false;
  if (value instanceof TypeError) return true;
  const message = facts.message?.toLowerCase();
  return (
    message !== undefined && NETWORK_MESSAGE_MARKERS.some((marker) => message.includes(marker))
  );
}

/** Fall back to the transport status when no logical error body was present. */
function classifyByStatus(status: number | undefined, value: unknown): InferenceError | undefined {
  if (status === undefined) return undefined;
  if (status === 429) return rateLimited(value);
  if (status === 408 || status >= 500) return upstreamError(String(status), value);
  return undefined;
}

/**
 * Classify any failure surfaced by the SDK (a stream `error` part payload
 * or a thrown iteration error) into a typed InferenceError, keying on the
 * LOGICAL error code, never the transport status.
 */
export function classifyInferenceFailure(value: unknown): InferenceError {
  if (value instanceof InferenceError) return value;

  const facts = collectChainFacts(value);
  if (facts.aborted) return abortedError();

  const reason = classifyByReason(facts, value);
  if (reason !== undefined) return reason;

  const classified =
    classifyByErrorObject(facts.error, value) ?? classifyByStatus(facts.status, value);
  if (classified !== undefined) return classified;

  if (isNetworkFailure(facts, value)) {
    return new InferenceError('network', 'Failed to reach the inference provider', {
      cause: value,
    });
  }

  if (typeof value === 'string') {
    return new InferenceError('upstream_error', `Inference stream error: ${value}`);
  }
  const detail = facts.message === undefined ? '' : `: ${facts.message}`;
  return new InferenceError('upstream_error', `Inference stream error${detail}`, { cause: value });
}
