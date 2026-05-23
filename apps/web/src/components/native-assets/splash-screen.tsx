import * as React from 'react';
import { CipherWall } from '@hushbox/ui';
import logoUrl from '@hushbox/ui/assets/HushBoxLogo.png';
import type { ThemeColors } from '@hushbox/ui';

const BRAND_RED = '#ec4755';

/**
 * The four strings baked into the native splash PNG. Listed in placement
 * order — index N renders at row offset `[-8, -5, 5, 8][N]` from center
 * (see createFrozenSnapshot). PNG byte-identicality with the previously
 * shipped splash relies on this order and these exact strings; do not
 * reorder or edit without regenerating the splash assets via
 * `pnpm tsx scripts/generate-assets.ts`.
 */
const SPLASH_MESSAGES: readonly string[] = [
  'Encrypted By Default',
  'Every Model, One Place',
  'Private Group Chats',
  'No Subscriptions Required',
];

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
        // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
        backgroundColor: theme.background,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', inset: 0, transform: 'scale(1.5)' }}>
        <CipherWall
          frozen
          messages={SPLASH_MESSAGES}
          themeOverride={theme.colors}
          cipherOpacity={0.5}
        />
      </div>

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
        {/* eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use <Img> from @hushbox/ui */}
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
              // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
              fontSize: '48px',
              fontWeight: 700,
              // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
              color: theme.foreground,
              // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            Hush
          </span>
          <span
            style={{
              // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
              fontSize: '48px',
              fontWeight: 700,
              // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
              color: BRAND_RED,
              // eslint-disable-next-line no-restricted-syntax -- native asset generator: renders to PNG, can't use Tailwind/CSS variables
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
