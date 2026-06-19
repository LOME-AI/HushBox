import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const contrastCss = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
const tailwindCss = readFileSync(
  path.join(stylesDir, '../../../../../config/tailwind/index.css'),
  'utf8'
);

/**
 * Reads a CSS custom property value from the body of a single selector block.
 * Tier overrides carry !important; the marker is stripped from the returned value.
 */
function readVariableInBlock(css: string, selector: string, variableName: string): string | null {
  const escapedSelector = selector.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
  const blockMatch = new RegExp(String.raw`${escapedSelector}\s*{([^}]*)}`).exec(css);
  if (blockMatch === null) return null;
  const variableMatch = new RegExp(String.raw`${variableName}:\s*([^;!]+)`).exec(blockMatch[1]!);
  return variableMatch === null ? null : variableMatch[1]!.trim();
}

function hexToLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

const DEFAULT_MUTED_LIGHT = readVariableInBlock(tailwindCss, ':root', '--foreground-muted');
const DEFAULT_MUTED_DARK = readVariableInBlock(tailwindCss, '.dark', '--foreground-muted');

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
      const value = readVariableInBlock(contrastCss, selector, '--foreground-muted');
      expect(value).not.toBeNull();
    }
  );

  it.each(darkTiers)(
    '%s overrides the real --foreground-muted token (not a dead alias)',
    (selector) => {
      const value = readVariableInBlock(contrastCss, selector, '--foreground-muted');
      expect(value).not.toBeNull();
    }
  );

  it.each(lightTiers)('%s changes muted text away from the light default', (selector) => {
    const value = readVariableInBlock(contrastCss, selector, '--foreground-muted');
    expect(value).not.toBe(DEFAULT_MUTED_LIGHT);
  });

  it.each(darkTiers)('%s changes muted text away from the dark default', (selector) => {
    const value = readVariableInBlock(contrastCss, selector, '--foreground-muted');
    expect(value).not.toBe(DEFAULT_MUTED_DARK);
  });

  it('a11y-contrast-low keeps muted text less prominent than body (hierarchy not inverted)', () => {
    const foreground = readVariableInBlock(contrastCss, 'html.a11y-contrast-low', '--foreground');
    const muted = readVariableInBlock(contrastCss, 'html.a11y-contrast-low', '--foreground-muted');
    expect(foreground).not.toBeNull();
    expect(muted).not.toBeNull();
    // Light mode: lower luminance reads as more prominent. Muted must not be
    // darker (more prominent) than the body foreground.
    expect(hexToLuminance(muted!)).toBeGreaterThan(hexToLuminance(foreground!));
  });
});
