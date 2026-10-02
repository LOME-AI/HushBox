import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseCssColor, relativeLuminance } from '@hushbox/shared/color/contrast';

import { declaredValue } from './css-declarations';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const contrastCss = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
const tailwindCss = readFileSync(
  path.join(stylesDir, '../../../../../config/tailwind/index.css'),
  'utf8'
);

const DEFAULT_MUTED_LIGHT = declaredValue(tailwindCss, ':root', '--foreground-muted');
const DEFAULT_MUTED_DARK = declaredValue(tailwindCss, '.dark', '--foreground-muted');

const lightTiers = [
  'html.a11y-contrast-high',
  'html.a11y-contrast-low',
  'html.a11y-contrast-increased',
] as const;
const darkTiers = [
  'html.a11y-contrast-high.dark',
  'html.a11y-contrast-low.dark',
  'html.a11y-contrast-increased.dark',
] as const;

describe('accessibility contrast tiers — muted text override', () => {
  it('the real muted token has a default value in the tailwind config', () => {
    expect(DEFAULT_MUTED_LIGHT).not.toBeNull();
    expect(DEFAULT_MUTED_DARK).not.toBeNull();
  });

  it.each(lightTiers)(
    '%s overrides the real --foreground-muted token (not a dead alias)',
    (selector) => {
      const value = declaredValue(contrastCss, selector, '--foreground-muted');
      expect(value).not.toBeNull();
    }
  );

  it.each(darkTiers)(
    '%s overrides the real --foreground-muted token (not a dead alias)',
    (selector) => {
      const value = declaredValue(contrastCss, selector, '--foreground-muted');
      expect(value).not.toBeNull();
    }
  );

  it.each(lightTiers)('%s changes muted text away from the light default', (selector) => {
    const value = declaredValue(contrastCss, selector, '--foreground-muted');
    expect(value).not.toBe(DEFAULT_MUTED_LIGHT);
  });

  it.each(darkTiers)('%s changes muted text away from the dark default', (selector) => {
    const value = declaredValue(contrastCss, selector, '--foreground-muted');
    expect(value).not.toBe(DEFAULT_MUTED_DARK);
  });

  it('a11y-contrast-low keeps muted text less prominent than body (hierarchy not inverted)', () => {
    const foreground = declaredValue(contrastCss, 'html.a11y-contrast-low', '--foreground');
    const muted = declaredValue(contrastCss, 'html.a11y-contrast-low', '--foreground-muted');
    expect(foreground).not.toBeNull();
    expect(muted).not.toBeNull();
    // Light mode: lower luminance reads as more prominent. Muted must not be
    // darker (more prominent) than the body foreground.
    expect(relativeLuminance(parseCssColor(muted!))).toBeGreaterThan(
      relativeLuminance(parseCssColor(foreground!))
    );
  });
});
