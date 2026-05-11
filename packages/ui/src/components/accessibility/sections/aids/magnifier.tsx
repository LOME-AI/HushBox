import * as React from 'react';

export interface MagnifierProps {
  enabled: boolean;
  zoom?: number;
  size?: number;
}

const DEBOUNCE_MS = 100;

/**
 * Cursor-tracking magnifier lens. Renders a circular fixed-position viewport that
 * follows the cursor. Inside the viewport we mount a clone of `document.body.innerHTML`
 * shifted so its (0,0) maps to screen (0,0), then `transform: scale(zoom)` is applied
 * with `transform-origin` at the cursor's screen position. The result: the area under
 * the cursor stays anchored under the cursor while everything around it is enlarged.
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
  const lensLeft = cursor.x - half;
  const lensTop = cursor.y - half;

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
        transform: `translate(${String(lensLeft)}px, ${String(lensTop)}px)`,
      }}
    >
      <div
        data-a11y-magnifier-content=""
        style={{
          position: 'absolute',
          top: `${String(-lensTop)}px`,
          left: `${String(-lensLeft)}px`,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none',
          transform: `scale(${String(zoom)})`,
          transformOrigin: `${String(cursor.x)}px ${String(cursor.y)}px`,
        }}
        dangerouslySetInnerHTML={{ __html: bodyHtml }}
      />
    </div>
  );
}
