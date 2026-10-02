import { z } from 'zod';
import { isFetchableSegment } from '@hushbox/shared/model-weights';
import type { Bindings } from '../../../lib/context/index.js';
import type { ModelWeightsBucket } from '../ports/index.js';

/** MODEL_WEIGHTS is a per-consumer binding (not pipeline-gated). */
export interface ModelWeightsBindings extends Bindings {
  MODEL_WEIGHTS?: ModelWeightsBucket;
}

/**
 * One path segment of an artifact key. The rule — the allowlisted character set,
 * the length cap and the parent-directory check — belongs to the artifact
 * contract in `@hushbox/shared`, which the publisher predicts this route's answer
 * through; a second spelling here would let a tightened route 404 every object
 * published under the looser one.
 *
 * Hono decodes a percent-escaped path parameter before a validator sees it, so
 * `..%2F` and `%2e%2e%2f` both arrive as the traversal they encode and a
 * still-encoded value arrives carrying `%`. That is why an allowlist is the only
 * reading that covers every spelling: it refuses the decoded and the encoded form
 * by the same omission.
 */
const artifactSegment = z.string().refine(isFetchableSegment);

export const artifactParamsSchema = z.object({
  model: artifactSegment,
  version: artifactSegment,
  file: artifactSegment,
});

/**
 * The key layout belongs to the artifact contract in `@hushbox/shared`, which
 * the publisher and the on-device loaders address the same objects through. It
 * is published under this slice's own vocabulary rather than restated: a route
 * serving one key layout while the publisher writes another 404s every fetch,
 * and the feature those objects serve is built to fail silently.
 */
export { modelWeightsObjectKey as artifactObjectKey } from '@hushbox/shared/model-weights';

/**
 * The `content-type` served, derived from the requested file name rather than
 * read off the stored object: the type decides what a client does with the
 * bytes, and deriving it here keeps that decision in reviewed code instead of
 * in whatever metadata an upload happened to carry.
 */
export function artifactContentType(file: string): string {
  return file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
}
