import * as React from 'react';
import { useCipherWall } from '@/hooks/use-cipher-wall';
import type { ThemeColors } from '@/components/auth/cipher-wall-engine';

interface CipherWallProps {
  frozen?: boolean;
  frozenMessageCount?: number;
  themeOverride?: ThemeColors;
  cipherOpacity?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function CipherWall(props: Readonly<CipherWallProps> = {}): React.JSX.Element {
  const { className, style, ...options } = props;
  const canvasRef = useCipherWall(options);

  const maskStyles: React.CSSProperties | undefined = options.frozen
    ? undefined
    : {
        maskImage: 'linear-gradient(to right, transparent 0%, black 15%)',
        WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 15%)',
      };

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
