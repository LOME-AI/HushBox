import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COMING_SOON_FEATURES, SHIPPED_FEATURES } from '../../packages/shared/src/features.js';
import { generateIcons, getIconSvg, makeThemeAware, toKebabCase } from './generate-icons.js';

describe('toKebabCase', () => {
  it('converts PascalCase to kebab-case', () => {
    expect(toKebabCase('MessagesSquare')).toBe('messages-square');
    expect(toKebabCase('ArrowLeftRight')).toBe('arrow-left-right');
    expect(toKebabCase('FileCode2')).toBe('file-code2');
    expect(toKebabCase('Globe')).toBe('globe');
    expect(toKebabCase('Share2')).toBe('share2');
    expect(toKebabCase('ShieldCheck')).toBe('shield-check');
  });
});

describe('getIconSvg', () => {
  it('returns SVG string for a valid Lucide icon name', () => {
    const svg = getIconSvg('Globe');
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });

  it('throws for an unknown icon name', () => {
    expect(() => getIconSvg('NonExistentIcon999')).toThrow('not found in lucide-static');
  });
});

describe('makeThemeAware', () => {
  it('removes stroke="currentColor" and injects theme-aware style', () => {
    const input = '<svg class="lucide lucide-globe" stroke="currentColor"><circle/></svg>';
    const result = makeThemeAware(input);

    expect(result).not.toContain('stroke="currentColor"');
    expect(result).not.toContain('class=');
    expect(result).toContain('<style>');
    expect(result).toContain('#1f2328');
    expect(result).toContain('#e6edf3');
    expect(result).toContain('prefers-color-scheme:dark');
  });

  it('preserves original SVG content', () => {
    const input = '<svg stroke="currentColor"><circle cx="12" cy="12" r="10"/></svg>';
    const result = makeThemeAware(input);

    expect(result).toContain('<circle cx="12" cy="12" r="10"/>');
  });
});

describe('generateIcons', () => {
  let temporaryDir: string;

  beforeEach(() => {
    temporaryDir = mkdtempSync(path.join(tmpdir(), 'generate-icons-test-'));
  });

  afterEach(() => {
    rmSync(temporaryDir, { recursive: true, force: true });
  });

  it('generates SVG files for all shipped and coming-soon features', () => {
    const generated = generateIcons(temporaryDir);
    const totalFeatures = SHIPPED_FEATURES.length + COMING_SOON_FEATURES.length;

    expect(generated).toHaveLength(totalFeatures);
  });

  it('creates actual files on disk', () => {
    generateIcons(temporaryDir);
    const files = readdirSync(temporaryDir);

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith('.svg'))).toBe(true);
  });

  it('generates theme-aware SVGs without currentColor', () => {
    generateIcons(temporaryDir);
    const files = readdirSync(temporaryDir);

    for (const file of files) {
      const content = readFileSync(path.join(temporaryDir, file), 'utf8');
      expect(content).not.toContain('currentColor');
      expect(content).toContain('prefers-color-scheme:dark');
    }
  });
});
