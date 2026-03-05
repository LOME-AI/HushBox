import * as React from 'react';
import { createFileRoute, redirect, useParams } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
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

export const Route = createFileRoute('/dev/render-asset/$name')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw redirect({ to: ROUTES.LOGIN });
    }
  },
  component: RenderAssetPage,
});

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
    <div data-testid="render-asset-wrapper" className="m-0 overflow-hidden p-0">
      <AssetComponent />
    </div>
  );
}
