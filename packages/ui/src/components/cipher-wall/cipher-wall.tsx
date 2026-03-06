import * as React from 'react';
import { useCipherWall, RESIZE_DEBOUNCE_MS } from './use-cipher-wall';
import type { ThemeColors } from './cipher-wall-engine';

interface CipherWallProps {
  frozen?: boolean;
  frozenMessageCount?: number;
  themeOverride?: ThemeColors;
  cipherOpacity?: number;
  fadeMask?: 'left' | 'radial' | 'none';
  fadeMaskTarget?: string;
  className?: string;
  style?: React.CSSProperties;
}

const FADE_MASK_PADDING_X = 12;
const FADE_MASK_PADDING_Y = 24;

function getMaskStyles(
  fadeMask: 'left' | 'radial' | 'none' | undefined,
  frozen: boolean | undefined
): React.CSSProperties | undefined {
  if (frozen) return undefined;
  switch (fadeMask ?? 'left') {
    case 'left': {
      return {
        maskImage: 'linear-gradient(to right, transparent 0%, black 15%)',
        WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 15%)',
      };
    }
    case 'radial':
    case 'none': {
      return undefined;
    }
  }
}

function useRadialMask(
  fadeMask: CipherWallProps['fadeMask'],
  fadeMaskTarget: string | undefined,
  frozen: boolean | undefined
): React.CSSProperties | undefined {
  const [dynamicMask, setDynamicMask] = React.useState<React.CSSProperties | undefined>();

  React.useEffect(() => {
    if (fadeMask !== 'radial' || frozen) return;

    if (!fadeMaskTarget) {
      throw new Error('CipherWall: fadeMask="radial" requires fadeMaskTarget selector');
    }

    const targetCandidate = document.querySelector(fadeMaskTarget);
    if (!targetCandidate) {
      throw new Error(`CipherWall: fadeMaskTarget "${fadeMaskTarget}" not found in DOM`);
    }
    const target = targetCandidate;

    function updateMask(): void {
      const rect = target.getBoundingClientRect();
      const rx = Math.round(rect.width / 2) + FADE_MASK_PADDING_X;
      const ry = Math.round(rect.height / 2) + FADE_MASK_PADDING_Y;
      const gradient = `radial-gradient(${String(rx)}px ${String(ry)}px at center, transparent 100%, black 140%)`;
      setDynamicMask({ maskImage: gradient, WebkitMaskImage: gradient });
    }

    updateMask();

    let maskTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(maskTimer);
      maskTimer = setTimeout(updateMask, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(target);
    return (): void => {
      clearTimeout(maskTimer);
      ro.disconnect();
    };
  }, [fadeMask, fadeMaskTarget, frozen]);

  return dynamicMask;
}

export function CipherWall(props: Readonly<CipherWallProps> = {}): React.JSX.Element {
  const { className, style, fadeMask, fadeMaskTarget, ...options } = props;
  const canvasRef = useCipherWall(options);

  const dynamicMask = useRadialMask(fadeMask, fadeMaskTarget, options.frozen);
  const maskStyles = dynamicMask ?? getMaskStyles(fadeMask, options.frozen);

  return (
    <canvas
      ref={canvasRef}
      data-testid="cipher-wall"
      role="img"
      aria-label="Animated cipher wall showing messages being encrypted and decrypted"
      className={className ?? 'h-full w-full'}
      style={{
        ...maskStyles,
        ...style,
      }}
    />
  );
}
