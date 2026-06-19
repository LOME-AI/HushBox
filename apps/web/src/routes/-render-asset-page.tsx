import * as React from 'react';
import { useParams } from '@tanstack/react-router';
import { TEST_IDS } from '@hushbox/shared';
import {
  AppIcon,
  IconBackground,
  IconForeground,
  SplashDark,
  SplashLight,
} from '@/components/native-assets';

// Asset names must match ASSET_DEFINITIONS in dev.assets.tsx
const ASSET_MAP: Record<string, React.ComponentType> = {
  'icon-only': AppIcon,
  'icon-background': IconBackground,
  'icon-foreground': IconForeground,
  'splash-dark': SplashDark,
  splash: SplashLight,
};

export function RenderAssetPage(): React.JSX.Element {
  const { name } = useParams({ from: '/dev/render-asset/$name' });
  const AssetComponent = ASSET_MAP[name];

  if (!AssetComponent) {
    return (
      <div className="flex h-dvh items-center justify-center">
        <p>Unknown asset: {name}</p>
      </div>
    );
  }

  return (
    <div data-testid={TEST_IDS.renderAssetWrapper} className="m-0 overflow-hidden p-0">
      <AssetComponent />
    </div>
  );
}
