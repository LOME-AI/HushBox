import { invalidRequestError } from './inference-error.js';
import type { InferenceRequest, ModelDescriptor } from '@hushbox/shared';

/**
 * The boundary every family adapter validates its call against, so the
 * contract holds identically for language and media rather than being restated
 * per family.
 *
 * ZDR is fail-closed: models absent from OpenRouter's `/endpoints/zdr` list
 * carry `zdrReachable: false` (set by the catalog) and are refused here before
 * any gateway call. That is a second gate, not the only one — the domain
 * exposure predicate already refuses to publish such a descriptor, and every
 * request separately pins the ZDR routing block through the shared routing
 * options.
 */
export function validateInferenceCall(
  request: InferenceRequest,
  descriptor: ModelDescriptor
): void {
  if (request.model !== descriptor.id) {
    throw invalidRequestError(
      `Request model does not match descriptor (${request.model} vs ${descriptor.id})`
    );
  }
  if (!descriptor.zdrReachable) {
    throw invalidRequestError(
      `Model is not ZDR-reachable (${descriptor.id}); unverified models are refused fail-closed`
    );
  }
}
