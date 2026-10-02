import '@hushbox/config/tailwind';
import '@hushbox/ui/fonts';

import { useLayoutEffect, useRef } from 'react';
import { useCurrentFrame, useDelayRender } from 'remotion';

import type { CSSProperties, ReactNode } from 'react';

interface ProductFrameProps {
  /** How many frame pixels one of the app's CSS pixels spans. */
  scale: number;
  /** Placement in the parent; the scale wins over any transform set here. */
  style?: CSSProperties;
  children: ReactNode;
}

async function decodeImage(image: HTMLImageElement): Promise<void> {
  try {
    await image.decode();
  } catch (error) {
    throw new Error(`product image ${image.src} did not load`, { cause: error });
  }
}

/** Each face the text under `root` is drawn in, as a CSS `font` value, with the text it draws. */
function drawnFaces(root: HTMLElement): Map<string, string> {
  const faces = new Map<string, string>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? '';
    if (node.parentElement === null || text.trim() === '') {
      continue;
    }
    const style = getComputedStyle(node.parentElement);
    const face = `${style.fontStyle} ${style.fontWeight} 1em ${style.fontFamily}`;
    faces.set(face, (faces.get(face) ?? '') + text);
  }
  return faces;
}

async function loadFace(face: string, text: string): Promise<void> {
  const loaded = await document.fonts.load(face, text);
  if (loaded.length === 0) {
    throw new Error(
      `product face ${face} matched no declared font face, so its text draws in a fallback`
    );
  }
}

/**
 * Real `packages/ui` components on screen, styled by the app's own stylesheet
 * under its dark theme, in the app's chrome type and ink, scaled by `scale`
 * about their centre unless `style` moves the transform origin.
 *
 * Every frame is held until each image inside has decoded and each face its text
 * is drawn in has loaded. The faces are read from the text's computed styles after
 * layout, so no list of the weights inside the app's components is kept; Remotion
 * does not wait for a raw `<img>`, which those components draw. An image that
 * fails to load, or a face that matches no declared font face and so would draw
 * in a fallback, fails the render naming it.
 */
export function ProductFrame({
  scale,
  style,
  children,
}: Readonly<ProductFrameProps>): React.JSX.Element {
  if (!Number.isFinite(scale)) {
    throw new RangeError(`ProductFrame scale must be a finite number, got ${String(scale)}`);
  }
  // Subscribes ProductFrame to the frame so its image-and-face hold re-runs every
  // frame, covering whatever mounted or changed inside it, a later `Sequence` child included.
  useCurrentFrame();
  const root = useRef<HTMLDivElement>(null);
  const { delayRender, continueRender, cancelRender } = useDelayRender();

  useLayoutEffect(() => {
    if (root.current === null) {
      return;
    }
    const images = [...root.current.querySelectorAll('img')];
    const faces = [...drawnFaces(root.current)];
    if (images.length === 0 && faces.length === 0) {
      return;
    }
    const handle = delayRender('Loading the product images and faces');
    void (async (): Promise<void> => {
      try {
        await Promise.all([
          ...images.map(async (image) => decodeImage(image)),
          ...faces.map(async ([face, text]) => loadFace(face, text)),
        ]);
        continueRender(handle);
      } catch (error) {
        cancelRender(error);
      }
    })();
  });

  return (
    <div
      ref={root}
      className="dark"
      style={{
        // The app's body rule sets this type and ink; restated here they resolve
        // under this element's dark theme. The ink names `--foreground` itself:
        // its theme alias `--color-foreground` resolves at the root, in the light theme.
        fontFamily: 'var(--font-sans)',
        color: 'var(--foreground)',
        ...style,
        transform: `scale(${String(scale)})`,
      }}
    >
      {children}
    </div>
  );
}
