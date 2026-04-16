import { describe, it, expect } from 'vitest';
import {
  getScreenshotConfigs,
  getResolutionConfigs,
  getScreenshotOutputPath,
} from './generate-screenshots.js';

describe('getScreenshotConfigs', () => {
  it('returns exactly 6 screenshot configurations', () => {
    const configs = getScreenshotConfigs();
    expect(configs).toHaveLength(6);
  });

  it('includes all required screenshot names', () => {
    const configs = getScreenshotConfigs();
    const names = configs.map((c) => c.name);
    expect(names).toContain('chat');
    expect(names).toContain('model-picker');
    expect(names).toContain('group-chat');
    expect(names).toContain('document-code');
    expect(names).toContain('document-mermaid');
    expect(names).toContain('privacy');
  });

  it('has a conversation seed key for each screenshot', () => {
    const configs = getScreenshotConfigs();
    for (const config of configs) {
      expect(config.conversationSeedKey).toMatch(/^screenshot-conv-/);
    }
  });

  it('model-picker uses the same conversation as chat', () => {
    const configs = getScreenshotConfigs();
    const chat = configs.find((c) => c.name === 'chat');
    const modelPicker = configs.find((c) => c.name === 'model-picker');
    expect(chat).toBeDefined();
    expect(modelPicker).toBeDefined();
    expect(modelPicker!.conversationSeedKey).toBe(chat!.conversationSeedKey);
  });

  it('has PNG filenames for each screenshot', () => {
    const configs = getScreenshotConfigs();
    for (const config of configs) {
      expect(config.filename).toBe(`${config.name}.png`);
    }
  });
});

describe('getResolutionConfigs', () => {
  it('returns exactly 4 resolution configurations', () => {
    const configs = getResolutionConfigs();
    expect(configs).toHaveLength(4);
  });

  it('includes apple-phone at 1320x2868 output', () => {
    const configs = getResolutionConfigs();
    const applePhone = configs.find((c) => c.name === 'apple-phone');
    expect(applePhone).toBeDefined();
    expect(applePhone!.outputWidth).toBe(1320);
    expect(applePhone!.outputHeight).toBe(2868);
  });

  it('includes apple-tablet at 2064x2752 output', () => {
    const configs = getResolutionConfigs();
    const appleTablet = configs.find((c) => c.name === 'apple-tablet');
    expect(appleTablet).toBeDefined();
    expect(appleTablet!.outputWidth).toBe(2064);
    expect(appleTablet!.outputHeight).toBe(2752);
  });

  it('includes google-phone at 1080x1920 output', () => {
    const configs = getResolutionConfigs();
    const googlePhone = configs.find((c) => c.name === 'google-phone');
    expect(googlePhone).toBeDefined();
    expect(googlePhone!.outputWidth).toBe(1080);
    expect(googlePhone!.outputHeight).toBe(1920);
  });

  it('includes google-tablet at 1200x1920 output', () => {
    const configs = getResolutionConfigs();
    const googleTablet = configs.find((c) => c.name === 'google-tablet');
    expect(googleTablet).toBeDefined();
    expect(googleTablet!.outputWidth).toBe(1200);
    expect(googleTablet!.outputHeight).toBe(1920);
  });

  it('has cssWidth * dpr equal to outputWidth for all resolutions', () => {
    const configs = getResolutionConfigs();
    for (const config of configs) {
      expect(config.cssWidth * config.dpr).toBe(config.outputWidth);
    }
  });

  it('has cssHeight * dpr equal to outputHeight for all resolutions', () => {
    const configs = getResolutionConfigs();
    for (const config of configs) {
      expect(config.cssHeight * config.dpr).toBe(config.outputHeight);
    }
  });

  it('uses DPR 3 for phones with realistic CSS viewports', () => {
    const configs = getResolutionConfigs();
    const applePhone = configs.find((c) => c.name === 'apple-phone')!;
    expect(applePhone.dpr).toBe(3);
    expect(applePhone.cssWidth).toBe(440);
    expect(applePhone.cssHeight).toBe(956);

    const googlePhone = configs.find((c) => c.name === 'google-phone')!;
    expect(googlePhone.dpr).toBe(3);
    expect(googlePhone.cssWidth).toBe(360);
    expect(googlePhone.cssHeight).toBe(640);
  });

  it('uses DPR 2 for tablets', () => {
    const configs = getResolutionConfigs();
    const tablets = configs.filter((c) => c.name.includes('tablet'));
    for (const tablet of tablets) {
      expect(tablet.dpr).toBe(2);
    }
  });
});

describe('getScreenshotOutputPath', () => {
  it('returns path under resources/assets/screenshots', () => {
    const result = getScreenshotOutputPath('/root', 'apple-phone', 'chat.png');
    expect(result).toBe('/root/apps/web/resources/assets/screenshots/apple-phone/chat.png');
  });

  it('handles different resolutions and filenames', () => {
    const result = getScreenshotOutputPath('/project', 'google-tablet', 'privacy.png');
    expect(result).toBe(
      '/project/apps/web/resources/assets/screenshots/google-tablet/privacy.png'
    );
  });
});
