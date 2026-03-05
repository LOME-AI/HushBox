import * as React from 'react';
import logoUrl from '@hushbox/ui/assets/HushBoxLogo.png';

export function AppIcon(): React.JSX.Element {
  return (
    <div
      data-testid="app-icon"
      style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: '#0a0a0a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <img
        src={logoUrl}
        alt="HushBox Logo"
        style={{
          width: '60%',
          height: '60%',
          objectFit: 'contain',
        }}
      />
    </div>
  );
}
