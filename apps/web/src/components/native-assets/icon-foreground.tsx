import * as React from 'react';
import logoUrl from '@hushbox/ui/assets/HushBoxLogo.png';

export function IconForeground(): React.JSX.Element {
  return (
    <div
      data-testid="icon-foreground"
      style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <img
        src={logoUrl}
        alt="HushBox Logo"
        style={{
          width: '40%',
          height: '40%',
          objectFit: 'contain',
        }}
      />
    </div>
  );
}
