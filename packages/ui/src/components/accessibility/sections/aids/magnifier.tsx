import * as React from 'react';

export interface MagnifierProps {
  /** When true, mounts the magnifier; when false, renders nothing. */
  enabled: boolean;
  /** Magnification factor. Defaults to 2. Recommended range 1.5–3. */
  zoom?: number;
  /** Lens diameter in pixels. Defaults to 200. */
  size?: number;
}

const DEBOUNCE_MS = 100;

/**
 * Magnifier — purely decorative cursor-tracking magnifier lens.
 *
 * Approach: a circular fixed-position lens follows the cursor. Inside the lens we
 * mount a snapshot of `document.body.outerHTML` rendered by `dangerouslySetInnerHTML`,
 * scaled with `transform: scale(zoom)` and re-anchored via `transform-origin` to the
 * cursor's viewport position. The clone is refreshed on a 100ms-debounced
 * `MutationObserver` tick so DOM changes propagate without re-cloning every keystroke.
 *
 * Why this approach: it actually magnifies the *visible* text content (the primary
 * use case for low-vision users) and works deterministically in jsdom — no
 * `Range.cloneContents`, no iframe `srcdoc`, no off-screen canvas dependencies.
 * Trade-off: dynamic state (input values, focus rings) is not preserved in the clone,
 * which is acceptable for v1 of a "see what's under my cursor more clearly" tool.
 *
 * The lens itself is `aria-hidden` and `pointer-events: none`, so screen readers
 * never encounter it and clicks pass straight through.
 */
export function Magnifier({
  enabled,
  zoom = 2,
  size = 200,
}: Readonly<MagnifierProps>): React.JSX.Element | null {
  const [cursor, setCursor] = React.useState<{ x: number; y: number }>(() => ({
    x: Math.floor(globalThis.innerWidth / 2),
    y: Math.floor(globalThis.innerHeight / 2),
  }));
  const [bodyHtml, setBodyHtml] = React.useState<string>(() => document.body.innerHTML);

  React.useEffect(() => {
    if (!enabled) return;

    const handleMouseMove = (event: MouseEvent): void => {
      setCursor({ x: event.clientX, y: event.clientY });
    };
    globalThis.addEventListener('mousemove', handleMouseMove);

    let debounceId: ReturnType<typeof setTimeout> | null = null;
    const refreshClone = (): void => {
      setBodyHtml(document.body.innerHTML);
    };
    const observer = new MutationObserver(() => {
      if (debounceId !== null) clearTimeout(debounceId);
      debounceId = setTimeout(refreshClone, DEBOUNCE_MS);
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      globalThis.removeEventListener('mousemove', handleMouseMove);
      observer.disconnect();
      if (debounceId !== null) clearTimeout(debounceId);
    };
  }, [enabled]);

  if (!enabled) return null;

  const half = size / 2;

  return (
    <div
      data-a11y-magnifier=""
      aria-hidden="true"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: `${String(size)}px`,
        height: `${String(size)}px`,
        borderRadius: '50%',
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 9999,
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.25)',
        border: '2px solid rgba(0, 0, 0, 0.6)',
        transform: `translate(${String(cursor.x - half)}px, ${String(cursor.y - half)}px)`,
      }}
    >
      <div
        data-a11y-magnifier-content=""
        style={{
          position: 'absolute',
          inset: 0,
          transform: `scale(${String(zoom)})`,
          transformOrigin: `${String(cursor.x)}px ${String(cursor.y)}px`,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
        }}
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
    </div>
  );
}
