import { assertPost } from './post.js';

import type { GlRegistration } from './layer.js';

function assertSampleCount(samples: number, name: string): void {
  if (!Number.isInteger(samples) || samples < 1) {
    throw new RangeError(`${name} must be a whole number of at least 1, got ${String(samples)}`);
  }
}

/** Refuses a registration no frame can draw: a layer's sample count, or a post chain value. */
export function assertRegistration(registration: GlRegistration): void {
  if (registration.kind === 'post') {
    assertPost(registration.post);
    return;
  }
  for (const layer of registration.layers) {
    assertSampleCount(layer.samples, `layer "${layer.id}" samples`);
  }
}
