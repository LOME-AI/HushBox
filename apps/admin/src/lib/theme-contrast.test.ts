import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';
import { contrastRatio, parseCssColor } from '@hushbox/shared/color/contrast';

/**
 * The one place a contrast ratio is computed against the shared theme tokens in
 * packages/config/tailwind/index.css. Every app that depends on a token pair
 * clearing a WCAG floor pins it here rather than deriving a second ratio of its
 * own: a token edit that regresses any pinned pair fails here, per theme.
 */
function tokensCssPath(): string {
  // Walk up from the test runner's cwd to the workspace root (jsdom rewrites
  // import.meta.url to an http scheme, so path resolution anchors on cwd).
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, 'packages/config/tailwind/index.css');
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('packages/config/tailwind/index.css not found above cwd');
    }
    dir = parent;
  }
}

/** The nth match wins theme selection: 0 = light (`:root`), 1 = dark (`.dark`). */
function tokenValue(css: string, name: string, themeIndex: 0 | 1): string {
  const matches = [...css.matchAll(new RegExp(String.raw`--${name}:\s*(#[0-9a-fA-F]{6})\b`, 'g'))];
  const match = matches[themeIndex];
  if (match?.[1] === undefined) {
    throw new Error(`token --${name} not found for theme index ${String(themeIndex)}`);
  }
  return match[1].toLowerCase();
}

const css = readFileSync(tokensCssPath(), 'utf8');

describe('error token contrast (WCAG AA, small text)', () => {
  const pairings = [
    {
      theme: 'light',
      error: tokenValue(css, 'error', 0),
      surface: tokenValue(css, 'background-paper', 0),
    },
    {
      theme: 'light',
      error: tokenValue(css, 'error', 0),
      surface: tokenValue(css, 'background', 0),
    },
    {
      theme: 'dark',
      error: tokenValue(css, 'error', 1),
      surface: tokenValue(css, 'background-paper', 1),
    },
    {
      theme: 'dark',
      error: tokenValue(css, 'error', 1),
      surface: tokenValue(css, 'background', 1),
    },
    /* --background-subtle is a fill, not just a page canvas: the docket console
       fills the selected finding row with it, and that row carries a severity
       badge in --error at 12px. Error text therefore has to clear the small-text
       floor on the subtle fill too, not only on the two page surfaces. */
    {
      theme: 'light',
      error: tokenValue(css, 'error', 0),
      surface: tokenValue(css, 'background-subtle', 0),
    },
    {
      theme: 'dark',
      error: tokenValue(css, 'error', 1),
      surface: tokenValue(css, 'background-subtle', 1),
    },
  ] as const;

  it.each(pairings)('$theme --error on $surface meets >= 4.5:1', ({ error, surface }) => {
    expect(contrastRatio(parseCssColor(error), parseCssColor(surface))).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * --foreground-muted is the console's dominant text colour: secondary lines,
 * metadata, uppercase section labels and mono paths, nearly all of it at 12px on
 * a surface an operator reads for hours. Sustained reading is the AAA case, so
 * the floor here is 7:1 rather than the 4.5:1 the size alone would demand, and
 * it holds on every surface the text lands on, --background-subtle included
 * (chips, wells, hover states and the selected row are all filled with it).
 */
describe('muted foreground contrast (WCAG AAA, sustained reading)', () => {
  const surfaces = ['background', 'background-paper', 'background-subtle'] as const;
  const pairings = (['light', 'dark'] as const).flatMap((theme, index) =>
    surfaces.map((surface) => ({
      theme,
      surface,
      muted: tokenValue(css, 'foreground-muted', index as 0 | 1),
      value: tokenValue(css, surface, index as 0 | 1),
    }))
  );

  it.each(pairings)('$theme --foreground-muted on --$surface meets >= 7:1', ({ muted, value }) => {
    expect(contrastRatio(parseCssColor(muted), parseCssColor(value))).toBeGreaterThanOrEqual(7);
  });

  /* Raising muted text must not erase the two-tier text hierarchy it exists to
     express. Muted stays at least 1.5:1 away from --foreground so "secondary"
     still reads as secondary rather than as a second primary. */
  it.each(['light', 'dark'] as const)(
    '%s --foreground-muted stays distinguishable from --foreground',
    (theme) => {
      const index = theme === 'light' ? 0 : 1;
      const muted = tokenValue(css, 'foreground-muted', index);
      const foreground = tokenValue(css, 'foreground', index);
      expect(contrastRatio(parseCssColor(muted), parseCssColor(foreground))).toBeGreaterThanOrEqual(
        1.5
      );
    }
  );
});

/**
 * The docket console marks the row a reader is on with a rule down its leading
 * edge in --brand-red, over a row filled with --background-subtle and abutting
 * the --background pane. A tint cannot carry that state (it measures 1.16:1), so
 * the rule is the whole cue, and SC 1.4.11 puts its floor at 3:1. Light sits at
 * 3.06, which is close enough that a nudge to either token would fail the
 * criterion in silence.
 */
describe('brand token contrast (WCAG non-text, UI component)', () => {
  const pairings = [
    {
      theme: 'light',
      brand: tokenValue(css, 'brand-red', 0),
      surface: tokenValue(css, 'background-subtle', 0),
    },
    {
      theme: 'light',
      brand: tokenValue(css, 'brand-red', 0),
      surface: tokenValue(css, 'background', 0),
    },
    {
      theme: 'dark',
      brand: tokenValue(css, 'brand-red', 1),
      surface: tokenValue(css, 'background-subtle', 1),
    },
    {
      theme: 'dark',
      brand: tokenValue(css, 'brand-red', 1),
      surface: tokenValue(css, 'background', 1),
    },
  ] as const;

  it.each(pairings)('$theme --brand-red on $surface meets >= 3:1', ({ brand, surface }) => {
    expect(contrastRatio(parseCssColor(brand), parseCssColor(surface))).toBeGreaterThanOrEqual(3);
  });
});

/**
 * --success and --warning carry sentence-sized copy, not only icons and fills,
 * so the small-text floor is the one that binds them. The contrast tiers never
 * redefine either token
 * (packages/ui/src/components/accessibility/styles/contrast.css), so no
 * accessibility setting can rescue a value that misses that floor — the token
 * value is the whole guarantee, on every surface the text lands on,
 * --background-subtle included.
 */
describe('status token contrast (WCAG AA, small text)', () => {
  const surfaces = ['background', 'background-paper', 'background-subtle'] as const;
  const pairings = (['light', 'dark'] as const).flatMap((theme, index) =>
    (['success', 'warning'] as const).flatMap((token) =>
      surfaces.map((surface) => ({
        theme,
        token,
        surface,
        value: tokenValue(css, token, index as 0 | 1),
        surfaceValue: tokenValue(css, surface, index as 0 | 1),
      }))
    )
  );

  it.each(pairings)('$theme --$token on --$surface meets >= 4.5:1', ({ value, surfaceValue }) => {
    expect(contrastRatio(parseCssColor(value), parseCssColor(surfaceValue))).toBeGreaterThanOrEqual(
      4.5
    );
  });
});

/**
 * --border-control is every control's boundary — inputs, the composer, outline buttons,
 * chips — and the boundary is what tells a control from the page, so SC 1.4.11 puts its
 * floor at 3:1 on every surface a control sits on: the canvas, cards, the subtle fill and
 * the sidebar rail. --border is a hairline and does not clear it, which is why a control
 * has a token of its own.
 */
describe('control border contrast (WCAG non-text, UI component)', () => {
  const surfaces = ['background', 'background-paper', 'background-subtle', 'sidebar'] as const;
  const pairings = (['light', 'dark'] as const).flatMap((theme, index) =>
    surfaces.map((surface) => ({
      theme,
      surface,
      border: tokenValue(css, 'border-control', index as 0 | 1),
      surfaceValue: tokenValue(css, surface, index as 0 | 1),
    }))
  );

  it.each(pairings)(
    '$theme --border-control on --$surface meets >= 3:1',
    ({ border, surfaceValue }) => {
      expect(
        contrastRatio(parseCssColor(border), parseCssColor(surfaceValue))
      ).toBeGreaterThanOrEqual(3);
    }
  );
});

/** The share of its tone a status tint lays over the surface beneath it. */
const STATUS_TINT_SHARE = 0.12;

/**
 * A status tint as it paints: `color-mix(in srgb, <tone> 12%, transparent)` composited
 * over the surface, which is a per-channel mix of the gamma-encoded channels.
 */
function tintOver(tone: string, surface: string): ReturnType<typeof parseCssColor> {
  const [toneRed, toneGreen, toneBlue] = parseCssColor(tone);
  const [red, green, blue] = parseCssColor(surface);
  const mix = (over: number, under: number): number =>
    STATUS_TINT_SHARE * over + (1 - STATUS_TINT_SHARE) * under;
  return [mix(toneRed, red), mix(toneGreen, green), mix(toneBlue, blue)];
}

/**
 * A badge or status line sets its words in the tone's `-text` ink on a 12% tint of the
 * tone itself. The words are small, so the AA floor binds, and it holds on the tint over
 * every surface such a mark lands on.
 */
describe('status text on its own tint (WCAG AA, small text)', () => {
  const surfaces = ['background', 'background-paper', 'background-subtle', 'sidebar'] as const;
  const tones = ['success', 'warning', 'error', 'info'] as const;
  const pairings = (['light', 'dark'] as const).flatMap((theme, index) =>
    tones.flatMap((tone) =>
      surfaces.map((surface) => ({
        theme,
        tone,
        surface,
        ink: tokenValue(css, `${tone}-text`, index as 0 | 1),
        tint: tintOver(
          tokenValue(css, tone, index as 0 | 1),
          tokenValue(css, surface, index as 0 | 1)
        ),
      }))
    )
  );

  it.each(pairings)(
    '$theme --$tone-text on a $tone tint over --$surface meets >= 4.5:1',
    ({ ink, tint }) => {
      expect(contrastRatio(parseCssColor(ink), tint)).toBeGreaterThanOrEqual(4.5);
    }
  );
});
