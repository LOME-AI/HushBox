import * as React from 'react';
import { useCipherWall } from '@/hooks/use-cipher-wall';

export function CipherWall(): React.JSX.Element {
  const canvasRef = useCipherWall();

  return (
    <canvas
      ref={canvasRef}
      data-testid="cipher-wall"
      role="img"
      aria-label="Animated cipher wall showing messages being encrypted and decrypted"
      className="h-full w-full"
      style={{
        maskImage: 'linear-gradient(to right, transparent 0%, black 15%)',
        WebkitMaskImage: 'linear-gradient(to right, transparent 0%, black 15%)',
      }}
    />
  );
}
