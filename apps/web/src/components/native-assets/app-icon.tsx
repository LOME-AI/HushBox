import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import logoUrl from '@hushbox/ui/assets/HushBoxLogo.png';

export function AppIcon(): React.JSX.Element {
  return (
    <div
      data-testid={TEST_IDS.appIcon}
      style={{
        width: '100vw',
        height: '100vh',
        // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
        backgroundColor: '#0a0a0a',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {/* eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use <Img> from @hushbox/ui */}
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
