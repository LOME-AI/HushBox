import { useLayoutEffect, useState } from 'react';
import { AbsoluteFill } from 'remotion';

import { PortalContainerProvider } from '@hushbox/ui';
import { MotionProvider } from '@hushbox/ui/accessibility';
import { useA11yStore } from '@hushbox/ui/accessibility/store';

import { ProductFrame } from '../visual/product-frame.js';

import type { ComponentType, CSSProperties } from 'react';
import type { UiContext, UiProps } from '../look/index.js';

/**
 * Every CSS transition and animation on the page stopped, the UI's own and any
 * it portals out of the layer: they run on the browser's clock, so each would
 * draw a frame from how long its page had been open. The film moves the UI.
 */
const FROZEN_MOTION =
  '*, *::before, *::after { transition: none !important; animation: none !important; }';

/** The UI at the frame's own size, one of the app's CSS pixels to one frame pixel. */
const FULL_FRAME: CSSProperties = { position: 'absolute', inset: 0 };

interface UiLayerProps {
  Ui: ComponentType<UiProps>;
  frame: number;
  ctx: UiContext;
  /** Where the layer sits among the canvases, and whether it shows. */
  style: CSSProperties;
}

/**
 * A look's UI component drawn live for the frame inside `ProductFrame`, with
 * the components' own wall-clock motion switched off: CSS transitions and
 * animations stop, and the app's reduced-motion override, which each host sets
 * for itself, renders its framer-motion components without motion. The UI
 * mounts once the override is set, so no component starts a motion first, and
 * once the layer's overlay element is in the page. Every `@hushbox/ui` overlay
 * the UI opens portals into that element through the provider, with no
 * `container` passed, so one open on the first frame lands inside the layer
 * rather than the document body.
 */
export function UiLayer({ Ui, frame, ctx, style }: Readonly<UiLayerProps>): React.JSX.Element {
  const [frozen, setFrozen] = useState(false);
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    useA11yStore.getState().setForcedReducedMotion(true);
    setFrozen(true);
  }, []);
  return (
    <AbsoluteFill style={style}>
      <style>{FROZEN_MOTION}</style>
      {frozen ? (
        <MotionProvider>
          <ProductFrame scale={1} style={FULL_FRAME}>
            {portal === null ? null : (
              <PortalContainerProvider container={portal}>
                <Ui frame={frame} ctx={ctx} />
              </PortalContainerProvider>
            )}
            <div ref={setPortal} />
          </ProductFrame>
        </MotionProvider>
      ) : null}
    </AbsoluteFill>
  );
}
