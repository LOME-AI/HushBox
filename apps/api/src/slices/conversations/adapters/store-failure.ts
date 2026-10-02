import { unavailableError } from '../../../lib/errors/index.js';
import type { DomainError } from '../../../lib/errors/index.js';

/** One mapper for every store query: infra rejections become `unavailable`. */
export function storeFailure(cause: unknown): DomainError {
  return unavailableError('conversations store query failed', cause);
}
