import { describe, it, expect } from 'vitest';
import { getAssetConfigs, getOutputPath } from './generate-assets.js';

describe('getAssetConfigs', () => {
  it('returns exactly 5 asset configurations', () => {
    const configs = getAssetConfigs();
    expect(configs).toHaveLength(5);
  });

  it('includes icon-only at 1024x1024 output', () => {
    const configs = getAssetConfigs();
    const iconOnly = configs.find((c) => c.name === 'icon-only');
    expect(iconOnly).toBeDefined();
    expect(iconOnly!.outputWidth).toBe(1024);
    expect(iconOnly!.outputHeight).toBe(1024);
  });

  it('includes icon-background at 1024x1024 output', () => {
    const configs = getAssetConfigs();
    const bg = configs.find((c) => c.name === 'icon-background');
    expect(bg).toBeDefined();
    expect(bg!.outputWidth).toBe(1024);
    expect(bg!.outputHeight).toBe(1024);
  });

  it('includes icon-foreground at 1024x1024 output', () => {
    const configs = getAssetConfigs();
    const fg = configs.find((c) => c.name === 'icon-foreground');
    expect(fg).toBeDefined();
    expect(fg!.outputWidth).toBe(1024);
    expect(fg!.outputHeight).toBe(1024);
  });

  it('includes splash-dark at 2732x2732 output', () => {
    const configs = getAssetConfigs();
    const dark = configs.find((c) => c.name === 'splash-dark');
    expect(dark).toBeDefined();
    expect(dark!.outputWidth).toBe(2732);
    expect(dark!.outputHeight).toBe(2732);
  });

  it('includes splash at 2732x2732 output', () => {
    const configs = getAssetConfigs();
    const splash = configs.find((c) => c.name === 'splash');
    expect(splash).toBeDefined();
    expect(splash!.outputWidth).toBe(2732);
    expect(splash!.outputHeight).toBe(2732);
  });

  it('has cssWidth * dpr equal to outputWidth for all assets', () => {
    const configs = getAssetConfigs();
    for (const config of configs) {
      expect(config.cssWidth * config.dpr).toBe(config.outputWidth);
    }
  });

  it('has cssHeight * dpr equal to outputHeight for all assets', () => {
    const configs = getAssetConfigs();
    for (const config of configs) {
      expect(config.cssHeight * config.dpr).toBe(config.outputHeight);
    }
  });

  it('uses DPR 2 for icons with 512x512 CSS viewport', () => {
    const configs = getAssetConfigs();
    const icons = configs.filter((c) => c.name.startsWith('icon'));
    for (const icon of icons) {
      expect(icon.dpr).toBe(2);
      expect(icon.cssWidth).toBe(512);
      expect(icon.cssHeight).toBe(512);
    }
  });

  it('uses DPR 2 for splashes with 1366x1366 CSS viewport', () => {
    const configs = getAssetConfigs();
    const splashes = configs.filter((c) => c.name.startsWith('splash'));
    for (const splash of splashes) {
      expect(splash.dpr).toBe(2);
      expect(splash.cssWidth).toBe(1366);
      expect(splash.cssHeight).toBe(1366);
    }
  });

  it('has a render URL for each asset', () => {
    const configs = getAssetConfigs();
    for (const config of configs) {
      expect(config.renderUrl).toBe(`/dev/render-asset/${config.name}`);
    }
  });

  it('has a PNG filename for each asset', () => {
    const configs = getAssetConfigs();
    for (const config of configs) {
      expect(config.filename).toBe(`${config.name}.png`);
    }
  });
});

describe('getOutputPath', () => {
  it('returns path under resources/assets', () => {
    const result = getOutputPath('/root', 'app-icon.png');
    expect(result).toBe('/root/apps/web/resources/assets/app-icon.png');
  });

  it('handles different filenames', () => {
    const result = getOutputPath('/project', 'splash-dark.png');
    expect(result).toBe('/project/apps/web/resources/assets/splash-dark.png');
  });
});
