import * as React from 'react';

export interface ReadingGuideProps {
  /** When true, mounts the spotlight overlay; when false, renders nothing. */
  enabled: boolean;
  /** Height of the unobscured "spotlight" band, in pixels. Defaults to 50. */
  bandHeight?: number;
  /** Opacity (0–1) of the dim panels above and below the spotlight. Defaults to 0.5. */
  dimOpacity?: number;
  /** When true, follow `document.activeElement`; otherwise follow the cursor. */
  followFocus?: boolean;
}

/**
 * ReadingGuide — purely decorative spotlight overlay.
 *
 * Two fixed-position dim divs sandwich a horizontal "band" that follows either the
 * cursor (default) or the focused element (when `followFocus` is true). Marked
 * `aria-hidden` and `pointer-events: none` so it never interferes with assistive
 * technology or click handling.
 */
export function ReadingGuide({
  enabled,
  bandHeight = 50,
  dimOpacity = 0.5,
  followFocus = false,
}: Readonly<ReadingGuideProps>): React.JSX.Element | null {
  const [centerY, setCenterY] = React.useState<number>(() =>
    Math.floor(globalThis.innerHeight / 2)
  );

  React.useEffect(() => {
    if (!enabled) return;

    if (followFocus) {
      const handleFocus = (): void => {
        const active = document.activeElement;
        if (!active || active === document.body) return;
        const rect = active.getBoundingClientRect();
        setCenterY((rect.top + rect.bottom) / 2);
      };
      document.addEventListener('focusin', handleFocus);
      handleFocus(); // seed from current focus
      return () => {
        document.removeEventListener('focusin', handleFocus);
      };
    }

    const handleMouseMove = (event: MouseEvent): void => {
      setCenterY(event.clientY);
    };
    globalThis.addEventListener('mousemove', handleMouseMove);
    return () => {
      globalThis.removeEventListener('mousemove', handleMouseMove);
    };
  }, [enabled, followFocus]);

  if (!enabled) return null;

  const halfBand = bandHeight / 2;
  const topHeight = Math.max(0, centerY - halfBand);
  const bottomTop = centerY + halfBand;
  const background = `rgba(0, 0, 0, ${String(dimOpacity)})`;

  return (
    <>
      <div
        data-a11y-reading-guide=""
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          height: `${String(topHeight)}px`,
          background,
          pointerEvents: 'none',
          zIndex: 9998,
        }}
      />
      <div
        data-a11y-reading-guide=""
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: `${String(bottomTop)}px`,
          left: 0,
          right: 0,
          bottom: 0,
          background,
          pointerEvents: 'none',
          zIndex: 9998,
        }}
      />
    </>
  );
}
