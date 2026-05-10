import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));

function escapeRegex(value: string): string {
  return value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
}

function importPattern(module: string, layer: string): RegExp {
  const escapedModule = escapeRegex(module);
  const escapedLayer = escapeRegex(layer);
  return new RegExp(String.raw`@import\s+['"]${escapedModule}['"]\s+layer\(${escapedLayer}\)`);
}

function colorblindPattern(key: string): RegExp {
  const escapedKey = escapeRegex(key);
  return new RegExp(
    String.raw`html\.a11y-cb-${escapedKey} body\s*{\s*filter:\s*url\(#a11y-cb-${escapedKey}\)`
  );
}

describe('accessibility styles bundle', () => {
  const indexPath = path.join(stylesDir, 'index.css');
  const indexContents = readFileSync(indexPath, 'utf8');

  const expectedImports = [
    { module: './contrast.css', layer: 'accessibility' },
    { module: './colorblind.css', layer: 'accessibility' },
    { module: './typography.css', layer: 'accessibility' },
    { module: './motion.css', layer: 'accessibility' },
    { module: './pointer.css', layer: 'accessibility' },
  ];

  it.each(expectedImports)(
    'index.css imports $module into the $layer cascade layer',
    ({ module, layer }) => {
      expect(indexContents).toMatch(importPattern(module, layer));
    }
  );

  it.each(expectedImports)('referenced file $module exists on disk', ({ module }) => {
    const resolved = path.join(stylesDir, module);
    expect(existsSync(resolved)).toBe(true);
  });

  it('contrast.css overrides background, foreground, border, and muted-foreground for high-contrast mode', () => {
    const contents = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
    expect(contents).toMatch(/html\.a11y-contrast-high\s*{[^}]*--background:\s*#ffffff/);
    expect(contents).toMatch(/html\.a11y-contrast-high\s*{[^}]*--foreground:\s*#000000/);
    expect(contents).toMatch(/html\.a11y-contrast-high\s*{[^}]*--border:\s*#000000/);
    expect(contents).toMatch(/html\.a11y-contrast-high\s*{[^}]*--muted-foreground:\s*#1a1a1a/);
  });

  it('contrast.css declares chat reader-mode rules that hide chrome and narrow main', () => {
    const contents = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
    expect(contents).toMatch(
      /html\[data-reader-mode\]\s+\[data-chrome\]\s*{\s*display:\s*none\s*!important/
    );
    expect(contents).toMatch(
      /html\[data-reader-mode\]\s+main\s*{[^}]*max-width:\s*65ch[^}]*margin-inline:\s*auto/
    );
  });

  it('contrast.css applies saturation/invert to body, never html (avoids stacking-context bug)', () => {
    const contents = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
    expect(contents).toMatch(/html\.a11y-saturate-0 body\s*{\s*filter:\s*saturate\(0\)/);
    expect(contents).toMatch(/html\.a11y-saturate-50 body\s*{\s*filter:\s*saturate\(0\.5\)/);
    expect(contents).toMatch(/html\.a11y-saturate-150 body\s*{\s*filter:\s*saturate\(1\.5\)/);
    expect(contents).toMatch(/html\.a11y-invert body\s*{\s*filter:\s*invert\(1\)/);
  });

  it('colorblind.css references the SVG filter ids injected by SvgColorblindDefs', () => {
    const contents = readFileSync(path.join(stylesDir, 'colorblind.css'), 'utf8');
    for (const key of ['protan', 'deutan', 'tritan', 'achroma', 'achromatomaly']) {
      expect(contents).toMatch(colorblindPattern(key));
    }
  });

  it('typography.css scales the html font-size for the four magnification steps', () => {
    const contents = readFileSync(path.join(stylesDir, 'typography.css'), 'utf8');
    expect(contents).toMatch(/html\.a11y-font-scale-125\s*{\s*font-size:\s*20px/);
    expect(contents).toMatch(/html\.a11y-font-scale-150\s*{\s*font-size:\s*24px/);
    expect(contents).toMatch(/html\.a11y-font-scale-175\s*{\s*font-size:\s*28px/);
    expect(contents).toMatch(/html\.a11y-font-scale-200\s*{\s*font-size:\s*32px/);
  });

  it('motion.css forces 0.01ms duration and !important to beat Framer inline styles', () => {
    const contents = readFileSync(path.join(stylesDir, 'motion.css'), 'utf8');
    expect(contents).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(contents).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(contents).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it('pointer.css references SVG cursor assets for large/xlarge variants', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    expect(contents).toMatch(/html\.a11y-cursor-large/);
    expect(contents).toMatch(/html\.a11y-cursor-xlarge/);
    expect(contents).toMatch(/cursors\/arrow-32-black\.svg/);
    expect(contents).toMatch(/cursors\/arrow-48-black\.svg/);
    expect(contents).toMatch(/cursors\/pointer-32-black\.svg/);
  });

  it('pointer.css configures focus indicator width/color via CSS variables', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    expect(contents).toMatch(
      /html\.a11y-focus-strong \*:focus-visible\s*{[^}]*outline:\s*var\(--a11y-focus-width/
    );
    expect(contents).toMatch(/var\(--a11y-focus-color/);
  });
});
