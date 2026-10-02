import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import logoUrl from '@hushbox/ui/assets/HushBoxLogo.png';

export function IconForeground(): React.JSX.Element {
  return (
    <div
      data-testid={TEST_IDS.iconForeground}
      style={{
        width: '100vw',
        height: '100vh',
        // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
        backgroundColor: 'transparent',
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
          width: '40%',
          height: '40%',
          objectFit: 'contain',
        }}
      />
    </div>
  );
}
