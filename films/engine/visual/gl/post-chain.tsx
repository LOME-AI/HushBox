import { useMemo } from 'react';

import { GlMarker } from './gl-marker.js';
import { assertPost } from './post.js';

import type { GlRegistration } from './layer.js';
import type { PostSettings } from './post.js';

/**
 * The finish of the enclosing `GlCanvas`: threshold bloom, edge-masked chromatic
 * aberration, vignette, flash, then a highlight roll-off, sRGB encoding and a static
 * dither. Every prop is a value the caller computes from the frame. Without a
 * `PostChain` a canvas presents its scene sRGB-encoded, with no roll-off and no
 * dither, so a layer's colours reach the frame as it drew them.
 */
export function PostChain({
  bloom,
  aberration,
  vignette,
  flash,
}: Readonly<PostSettings>): React.JSX.Element {
  assertPost({ bloom, aberration, vignette, flash });
  const registration = useMemo(
    (): GlRegistration => ({ kind: 'post', post: { bloom, aberration, vignette, flash } }),
    [bloom, aberration, vignette, flash]
  );
  return <GlMarker registration={registration} />;
}
