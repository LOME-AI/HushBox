import {
  AppIcon,
  IconBackground,
  IconForeground,
  SocialBannerDark,
  SocialBannerLight,
  SplashDark,
  SplashLight,
} from '@/components/native-assets';
import type { ComponentType } from 'react';

// `-`-prefixed sibling module: excluded from the TanStack route tree so the
// route files that read it (`dev.assets.tsx`, `dev.render-asset.$name.tsx`) can
// export only `Route` and stay code-split.

interface AssetDefinition {
  name: string;
  label: string;
  width: number;
  height: number;
  component: ComponentType;
}

export const ASSET_DEFINITIONS = [
  { name: 'icon-only', label: 'App Icon', width: 1024, height: 1024, component: AppIcon },
  {
    name: 'icon-background',
    label: 'Icon Background',
    width: 1024,
    height: 1024,
    component: IconBackground,
  },
  {
    name: 'icon-foreground',
    label: 'Icon Foreground',
    width: 1024,
    height: 1024,
    component: IconForeground,
  },
  {
    name: 'splash-dark',
    label: 'Splash (Dark)',
    width: 2732,
    height: 2732,
    component: SplashDark,
  },
  { name: 'splash', label: 'Splash (Light)', width: 2732, height: 2732, component: SplashLight },
  {
    name: 'social-banner',
    label: 'Social Banner (Light)',
    width: 1500,
    height: 500,
    component: SocialBannerLight,
  },
  {
    name: 'social-banner-dark',
    label: 'Social Banner (Dark)',
    width: 1500,
    height: 500,
    component: SocialBannerDark,
  },
] as const satisfies readonly AssetDefinition[];

interface ScreenshotDefinition {
  name: string;
  label: string;
}

interface ResolutionDefinition {
  name: string;
  label: string;
  width: number;
  height: number;
}

export const SCREENSHOT_DEFINITIONS = [
  { name: 'chat', label: 'Chat' },
  { name: 'model-picker', label: 'Model Picker' },
  { name: 'group-chat', label: 'Group Chat' },
  { name: 'document-code', label: 'Document (Code)' },
  { name: 'document-mermaid', label: 'Document (Mermaid)' },
  { name: 'privacy', label: 'Privacy' },
] as const satisfies readonly ScreenshotDefinition[];

export const RESOLUTION_DEFINITIONS = [
  { name: 'apple-phone', label: 'Apple iPhone (6.9")', width: 1320, height: 2868 },
  { name: 'apple-tablet', label: 'Apple iPad (13")', width: 2064, height: 2752 },
  { name: 'google-phone', label: 'Google Phone', width: 1080, height: 1920 },
  { name: 'google-tablet', label: 'Google Tablet', width: 1200, height: 1920 },
] as const satisfies readonly ResolutionDefinition[];
