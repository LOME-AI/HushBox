import * as React from 'react';
import { CipherWall } from '@hushbox/ui';
import type { ThemeColors } from '@hushbox/ui';
import logoUrl from '@hushbox/ui/assets/HushBoxLogo.png';

const BRAND_RED = '#ec4755';

const THEMES: Record<
  'dark' | 'light',
  { colors: ThemeColors; background: string; foreground: string }
> = {
  dark: {
    colors: {
      background: '#0a0a0a',
      foreground: '#fafafa',
      brandRed: BRAND_RED,
      foregroundMuted: '#888888',
    },
    background: '#0a0a0a',
    foreground: '#fafafa',
  },
  light: {
    colors: {
      background: '#ffffff',
      foreground: '#0a0a0a',
      brandRed: BRAND_RED,
      foregroundMuted: '#525252',
    },
    background: '#ffffff',
    foreground: '#0a0a0a',
  },
};

interface SplashScreenProps {
  variant: 'dark' | 'light';
}

export function SplashScreen({ variant }: Readonly<SplashScreenProps>): React.JSX.Element {
  const theme = THEMES[variant];

  return (
    <div
      data-testid={`splash-${variant}`}
      style={{
        width: '100vw',
        height: '100vh',
        backgroundColor: theme.background,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Frozen cipher wall background at reduced opacity */}
      <div style={{ position: 'absolute', inset: 0, transform: 'scale(1.5)' }}>
        <CipherWall
          frozen
          frozenMessageCount={4}
          themeOverride={theme.colors}
          cipherOpacity={0.5}
        />
      </div>

      {/* Centered logo overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '24px',
        }}
      >
        <img
          src={logoUrl}
          alt="HushBox Logo"
          style={{
            width: '120px',
            height: '120px',
            objectFit: 'contain',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0' }}>
          <span
            style={{
              fontSize: '48px',
              fontWeight: 700,
              color: theme.foreground,
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            Hush
          </span>
          <span
            style={{
              fontSize: '48px',
              fontWeight: 700,
              color: BRAND_RED,
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            Box
          </span>
        </div>
      </div>
    </div>
  );
}
