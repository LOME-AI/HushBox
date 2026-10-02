import { unavailableError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/** One mapper for every read query: infra rejections become `unavailable`. */
export function storeFailure(cause: unknown): DomainError {
  return unavailableError('billing store query failed', cause);
}

/** Defect guard: an expected row that is absent aborts the settlement. */
export function requireRow<T>(row: T | undefined, message: string): T {
  if (row === undefined) throw new Error(`billing store: ${message}`);
  return row;
}
