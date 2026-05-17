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

  it('contrast.css applies saturation to body, never html (avoids stacking-context bug)', () => {
    const contents = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
    expect(contents).toMatch(/html\.a11y-saturate-0 body\s*{\s*filter:\s*saturate\(0\)/);
    expect(contents).toMatch(/html\.a11y-saturate-50 body\s*{\s*filter:\s*saturate\(0\.5\)/);
    expect(contents).toMatch(/html\.a11y-saturate-150 body\s*{\s*filter:\s*saturate\(1\.5\)/);
  });

  it('contrast.css uses !important on variable redefinitions to win against unlayered :root', () => {
    const contents = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
    expect(contents).toMatch(/--background:\s*#ffffff\s*!important/);
    expect(contents).toMatch(/--foreground:\s*#000000\s*!important/);
  });

  it('contrast-increased darkens foreground and border (not just muted-foreground)', () => {
    const contents = readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8');
    // Stronger contrast must visibly change actual text/border colors, not only
    // the rarely-rendered muted-foreground variable.
    expect(contents).toMatch(/html\.a11y-contrast-increased\s*{[^}]*--foreground:\s*#000000/);
    expect(contents).toMatch(/html\.a11y-contrast-increased\s*{[^}]*--border:/);
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

  it('typography.css scopes paragraph spacing to non-trailing paragraphs', () => {
    const contents = readFileSync(path.join(stylesDir, 'typography.css'), 'utf8');
    // :not(:last-child) is load-bearing — without it the trailing <p> in every
    // message bubble (user text rendered as a <p>; AI markdown's final prose
    // <p>) carries 2em margin-bottom, painting empty space inside the bubble.
    expect(contents).toMatch(
      /html\.a11y-para-spacing-double p:not\(:last-child\)\s*{\s*margin-bottom:\s*2em/
    );
  });

  it('motion.css forces 0.01ms duration and !important to beat Framer inline styles', () => {
    const contents = readFileSync(path.join(stylesDir, 'motion.css'), 'utf8');
    expect(contents).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(contents).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(contents).toMatch(/scroll-behavior:\s*auto\s*!important/);
  });

  it('pointer.css inlines SVG cursors via data URIs (no external asset files)', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    expect(contents).toMatch(/html\.a11y-cursor-large/);
    expect(contents).toMatch(/html\.a11y-cursor-xlarge/);
    // Each cursor variant must use a data: URL — no external /cursors/*.svg references
    expect(contents).toMatch(/cursor:\s*url\("data:image\/svg\+xml,/);
    expect(contents).not.toMatch(/\/cursors\//);
  });

  it('pointer.css forces the custom cursor on every descendant via cursor: inherit !important', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    // The universal-selector rule overrides element-level cursors (e.g. Tailwind cursor-pointer)
    // so the big-arrow cursor actually wins when hovering over interactive UI.
    expect(contents).toMatch(/html\.a11y-cursor-large \*[^{]*{[^}]*cursor:\s*inherit\s*!important/);
    expect(contents).toMatch(
      /html\.a11y-cursor-xlarge \*[^{]*{[^}]*cursor:\s*inherit\s*!important/
    );
  });

  it('pointer.css applies a hand-cursor variant to interactive elements when a custom size is active', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    // Hovering a button/card under a custom cursor should show the "clickable" cursor.
    // Quotes inside selectors are matched as either `"` or `'` so the assertion survives
    // Prettier's CSS-default single-quote normalization.
    expect(contents).toMatch(/html\.a11y-cursor-large button/);
    expect(contents).toMatch(/html\.a11y-cursor-large \[role=['"]button['"]]/);
    expect(contents).toMatch(/html\.a11y-cursor-large \[data-slot=['"]setting-card['"]]/);
    expect(contents).toMatch(/html\.a11y-cursor-large \.cursor-pointer/);
  });

  it('pointer.css defines a standalone a11y-cursor-white rule so the color picker works at normal size', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    // Compound rules (`html.a11y-cursor-white.a11y-cursor-large`) cover white at large/xlarge,
    // but white-at-normal needs an unchained selector. Without this, picking color=white while
    // size=normal added the class but matched no rule — silent no-op for the user.
    expect(contents).toMatch(
      /html\.a11y-cursor-white\s*\{[^}]*cursor:\s*url\("data:image\/svg\+xml,/
    );
  });

  it('pointer.css applies a hand-pointer variant to interactive elements at normal size when color is white', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    // Same interactive-element coverage as the large/xlarge variants, but for normal+white.
    expect(contents).toMatch(/html\.a11y-cursor-white button[^{]*\{[^}]*cursor:\s*url/);
    expect(contents).toMatch(
      /html\.a11y-cursor-white \[role=['"]button['"]][^{]*\{[^}]*cursor:\s*url/
    );
  });

  it('pointer.css forces descendant cursor inheritance for the standalone a11y-cursor-white rule', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    // Without this, element-default cursors (I-beam on inputs, etc.) would override the custom
    // white cursor on non-interactive descendants.
    expect(contents).toMatch(
      /html\.a11y-cursor-white \*[^{]*\{[^}]*cursor:\s*inherit\s*!important/
    );
  });

  it('pointer.css interactive hand-cursor SVG is a filled silhouette (not an empty outline drawing)', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    // The hand-pointer must read as a solid shape — an outline-only drawing
    // (`fill='none'` on the path) looks "hollow" against the page and was
    // the failure mode of an earlier Lucide-stroke-only implementation.
    const match = /html\.a11y-cursor-large button[^{]*\{[^}]*cursor:\s*url\("([^"]+)"/.exec(
      contents
    );
    expect(match).not.toBeNull();
    const decoded = decodeURIComponent(match![1]!);
    expect(decoded).toMatch(
      /<path[^>]*\sfill=['"](?:black|white|currentColor|#[0-9a-fA-F]{3,8})['"]/
    );
    expect(decoded).not.toMatch(/<path[^>]*\sfill=['"]none['"]/);
  });

  it('pointer.css disables pointer-events on the magnifier AND its descendants (click-through)', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    // pointer-events is non-inherited — must target both the lens and `*`
    // so cloned DOM elements inside don't intercept clicks meant for the
    // live element underneath.
    expect(contents).toMatch(
      /\[data-a11y-magnifier],\s*\[data-a11y-magnifier]\s*\*\s*{[^}]*pointer-events:\s*none\s*!important/
    );
  });

  it('pointer.css hides nested magnifier lenses inside the magnifier clone (no Droste recursion)', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    expect(contents).toMatch(
      /\[data-a11y-magnifier-content]\s*\[data-a11y-magnifier]\s*{[^}]*display:\s*none\s*!important/
    );
  });

  it('pointer.css focus rule fires on :focus AND :focus-visible (so click-focus also shows the ring)', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    expect(contents).toMatch(/html\.a11y-focus-strong \*:focus\b/);
    expect(contents).toMatch(/html\.a11y-focus-strong \*:focus-visible\b/);
  });

  it('pointer.css configures focus indicator width/color via CSS variables', () => {
    const contents = readFileSync(path.join(stylesDir, 'pointer.css'), 'utf8');
    expect(contents).toMatch(/outline:\s*var\(--a11y-focus-width/);
    expect(contents).toMatch(/var\(--a11y-focus-color/);
  });
});
