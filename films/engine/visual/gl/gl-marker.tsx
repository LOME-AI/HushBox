import { useContext, useLayoutEffect, useRef } from 'react';

import { assertRegistration } from './entry.js';
import { GlRegistryContext, MARKER_ATTRIBUTE } from './gl-canvas.js';

import type { GlRegistration } from './layer.js';

interface GlMarkerProps {
  registration: GlRegistration;
}

/**
 * Registers layers, or the post chain, with the enclosing `GlCanvas`. It renders an
 * empty element whose place in the document fixes the draw order, so layers compose
 * in the order they appear in the scene whatever mounted first.
 */
export function GlMarker({ registration }: Readonly<GlMarkerProps>): React.JSX.Element {
  assertRegistration(registration);
  const registry = useContext(GlRegistryContext);
  if (registry === null) {
    throw new Error('GL layers draw inside a <GlCanvas>, and this one sits outside it');
  }
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const element = marker.current;
    if (element === null) {
      return;
    }
    registry.set(element, registration);
    return (): void => {
      registry.delete(element);
    };
  }, [registry, registration]);
  return <span ref={marker} {...{ [MARKER_ATTRIBUTE]: '' }} />;
}
