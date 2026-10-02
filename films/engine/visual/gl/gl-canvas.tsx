import { createContext, useLayoutEffect, useRef, useState } from 'react';
import { AbsoluteFill, Freeze, useCurrentFrame, useDelayRender } from 'remotion';

import { HEIGHT, WIDTH } from '../../time/grid.js';
import { useBrand } from '../brand.js';
import { linearColor } from './color.js';
import { GlError } from './gl-error.js';
import { framePost } from './post.js';
import { createGlRenderer } from './renderer.driver.js';
import { passOffsets } from './sub-frames.js';

import type { ReactNode } from 'react';
import type { GlLayer, GlRegistration } from './layer.js';
import type { PostSettings } from './post.js';
import type { GlRenderer } from './renderer.driver.js';

/** Where each `GlMarker` under a canvas registers what it draws, keyed by its marker element. */
export const GlRegistryContext = createContext<Map<Element, GlRegistration> | null>(null);

/** The attribute every `GlMarker` element carries; markers are read in document order. */
export const MARKER_ATTRIBUTE = 'data-gl-marker';

const PASS_ATTRIBUTE = 'data-gl-pass';

interface Collected {
  passes: Map<number, GlLayer[]>;
  post: PostSettings | null;
}

/** What one pass's markers registered, in document order. */
function registrations(
  container: Element,
  registry: ReadonlyMap<Element, GlRegistration>
): GlRegistration[] {
  return [...container.querySelectorAll(`[${MARKER_ATTRIBUTE}]`)].flatMap(
    (marker) => registry.get(marker) ?? []
  );
}

/**
 * Every pass's layers in document order — the order the scene composes them, which no
 * mount history can change — and the post chain of the frame's own pass.
 */
function collect(
  root: Element,
  registry: ReadonlyMap<Element, GlRegistration>,
  offsets: readonly number[]
): Collected {
  const passes = new Map<number, GlLayer[]>();
  let posts: PostSettings[] = [];
  for (const container of root.querySelectorAll(`:scope > [${PASS_ATTRIBUTE}]`)) {
    const pass = Number(container.getAttribute(PASS_ATTRIBUTE));
    const registered = registrations(container, registry);
    const layers = registered.flatMap((entry) => (entry.kind === 'layers' ? entry.layers : []));
    passes.set(pass === 0 ? 0 : (offsets[pass - 1] ?? Number.NaN), layers);
    if (pass === 0) {
      posts = registered.flatMap((entry) => (entry.kind === 'post' ? [entry.post] : []));
    }
  }
  return { passes, post: framePost(posts) };
}

function sameOffsets(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((offset, index) => offset === b[index]);
}

interface GlCanvasProps {
  /** The layers: `PostChain` and other `GlMarker` users. Plain DOM here is never shown. */
  children: ReactNode;
}

/**
 * One WebGL2 canvas over the whole frame. It draws its layers synchronously for the
 * current frame and reads no clock; motion blur renders its children again under
 * `Freeze` at each sub-frame instant a layer asks for, so every sample is the scene
 * evaluated at that fractional frame. A lost context, a shader that fails to compile
 * or a resource that fails to load fails the render with a named error.
 */
export function GlCanvas({ children }: Readonly<GlCanvasProps>): React.JSX.Element {
  const frame = useCurrentFrame();
  const brand = useBrand();
  const { delayRender, continueRender, cancelRender } = useDelayRender();
  const canvas = useRef<HTMLCanvasElement>(null);
  const passesRoot = useRef<HTMLDivElement>(null);
  const renderer = useRef<GlRenderer | null>(null);
  const passHold = useRef<number | null>(null);
  const [registry] = useState(() => new Map<Element, GlRegistration>());
  const [offsets, setOffsets] = useState<readonly number[]>([]);
  const [, setVersion] = useState(0);

  useLayoutEffect(() => {
    const element = canvas.current;
    if (element === null) {
      return;
    }
    const onLost = (): void => {
      cancelRender(new GlError('context-lost', 'the WebGL2 context was lost'));
    };
    element.addEventListener('webglcontextlost', onLost);
    try {
      renderer.current = createGlRenderer(element, {
        hold: (label) => delayRender(label),
        release: continueRender,
        invalidate: () => {
          setVersion((version) => version + 1);
        },
        fail: cancelRender,
      });
    } catch (error) {
      cancelRender(error);
    }
    return (): void => {
      element.removeEventListener('webglcontextlost', onLost);
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, [delayRender, continueRender, cancelRender]);

  // Runs after every commit, once every layer below has registered for it.
  useLayoutEffect(() => {
    const active = renderer.current;
    const root = passesRoot.current;
    if (active === null || root === null) {
      return;
    }
    try {
      const { passes, post } = collect(root, registry, offsets);
      const needed = passOffsets((passes.get(0) ?? []).map((layer) => layer.samples));
      if (!sameOffsets(needed, offsets)) {
        passHold.current ??= delayRender('GlCanvas: rendering motion-blur sub-frames');
        setOffsets(needed);
        return;
      }
      const drawn = active.draw({ background: linearColor(brand.background), passes, post });
      if (drawn && passHold.current !== null) {
        continueRender(passHold.current);
        passHold.current = null;
      }
    } catch (error) {
      cancelRender(error);
    }
  });

  return (
    <AbsoluteFill>
      <canvas
        ref={canvas}
        width={WIDTH}
        height={HEIGHT}
        style={{ width: '100%', height: '100%' }}
      />
      <div ref={passesRoot} style={{ display: 'none' }}>
        <GlRegistryContext value={registry}>
          <div data-gl-pass="0">{children}</div>
          {offsets.map((offset, index) => (
            <div key={String(offset)} data-gl-pass={String(index + 1)}>
              <Freeze frame={frame + offset}>{children}</Freeze>
            </div>
          ))}
        </GlRegistryContext>
      </div>
    </AbsoluteFill>
  );
}
