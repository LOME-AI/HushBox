/**
 * Base DomainError taxonomy for domain code (the typed `Result` error
 * channel). This is the closed set of base kinds only — the error→HTTP-status
 * map is deliberately out of scope here and lives in `lib/context`, with the
 * rest of the transport vocabulary, so this module (which every slice imports
 * to build errors) stays free of the framework's type surface.
 *
 * Doctrine (ARCHITECTURE.md): expected domain failures are `Result` values
 * carrying one of these errors; exceptions are defects and must keep
 * throwing. Errors carry codes and operator-safe messages, never content.
 */

import { DOMAIN_ERROR_CODE_TO_WIRE_CODE } from '@hushbox/shared';
import type { ErrorCode } from '@hushbox/shared';

export const DOMAIN_ERROR_CODES = [
  'validation',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'timeout',
  'unavailable',
] as const;

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

export interface DomainErrorOf<C extends DomainErrorCode> {
  readonly code: C;
  readonly message: string;
  readonly cause?: unknown;
  /**
   * An optional, more specific wire code the route layer emits instead of the
   * generic taxonomy mapping (`DOMAIN_ERROR_CODE_TO_WIRE_CODE`). Additive: an
   * error without it maps exactly as before. Lets a `validation` failure carry
   * a precise client code (e.g. `UNSUPPORTED_MODALITY`) without widening the
   * closed base taxonomy.
   */
  readonly wireCode?: ErrorCode;
}

export type DomainError = { [C in DomainErrorCode]: DomainErrorOf<C> }[DomainErrorCode];

function factoryFor<C extends DomainErrorCode>(
  code: C
): (message: string, cause?: unknown, wireCode?: ErrorCode) => DomainErrorOf<C> {
  return (message: string, cause?: unknown, wireCode?: ErrorCode): DomainErrorOf<C> => ({
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
    ...(wireCode === undefined ? {} : { wireCode }),
  });
}

/**
 * The wire code a `DomainError` projects to: its explicit `wireCode` when
 * carried, else the generic taxonomy mapping. The single home for honoring the
 * carrier so every `respondDomainError` stays one line.
 */
export function domainWireCode(error: DomainError): ErrorCode {
  return error.wireCode ?? DOMAIN_ERROR_CODE_TO_WIRE_CODE[error.code];
}

export const validationError = factoryFor('validation');
export const unauthorizedError = factoryFor('unauthorized');
export const forbiddenError = factoryFor('forbidden');
export const notFoundError = factoryFor('not_found');
export const conflictError = factoryFor('conflict');
export const rateLimitedError = factoryFor('rate_limited');
export const timeoutError = factoryFor('timeout');
export const unavailableError = factoryFor('unavailable');

/**
 * Whether a taxonomy code says the dependency did not produce a usable answer,
 * as against one that computed a refusal. The single home for that split:
 * callers classify an availability failure differently from a refusal (an infra
 * sentinel rather than a domain one), and a second hand-written copy is what
 * lets two of them disagree about which codes count.
 */
export function isAvailabilityCode(code: DomainErrorCode): boolean {
  return code === 'unavailable' || code === 'timeout';
}

const DOMAIN_ERROR_CODE_SET: ReadonlySet<string> = new Set(DOMAIN_ERROR_CODES);

export function isDomainError(value: unknown): value is DomainError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { code?: unknown; message?: unknown };
  return (
    typeof candidate.code === 'string' &&
    DOMAIN_ERROR_CODE_SET.has(candidate.code) &&
    typeof candidate.message === 'string'
  );
}
