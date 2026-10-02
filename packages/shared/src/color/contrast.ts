/**
 * The WCAG relative-luminance and contrast-ratio arithmetic, written once for
 * every caller that pins a colour pair against a contrast floor. Callers differ
 * only in where their colours come from — hex parsed out of the shared token
 * stylesheet, HSL literals declared in TypeScript — so the parsing is separated
 * from the arithmetic rather than duplicated alongside it.
 */

/** Channels in the 0-255 sRGB range, unrounded so a parsed colour loses nothing. */
type Rgb = readonly [number, number, number];

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
// A leading minus is deliberately unmatched: {@link hslToRgb} clamps `k` before the CSS
// Color 4 algorithm's implicit mod-12 wrap, so a negative hue converts to the wrong
// colour rather than its positive equivalent. Nothing here declares one; rejecting beats
// normalising, which would hand a caller a ratio for a colour it did not name.
const HSL_COLOR = /^hsl\(\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%\s*\)$/i;

const SRGB_KNEE = 0.040_45;

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number): number => {
    const k = (n + hue / 30) % 12;
    return (l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)))) * 255;
  };
  return [channel(0), channel(8), channel(4)];
}

/**
 * Parses the two colour notations this repo declares colours in: `#rrggbb` and
 * space-separated `hsl(h s% l%)`. Anything else throws rather than degrading to
 * a wrong ratio that a contrast assertion would then pass.
 */
export function parseCssColor(color: string): Rgb {
  const [, r, g, b] = HEX_COLOR.exec(color) ?? [];
  if (r !== undefined && g !== undefined && b !== undefined) {
    return [Number.parseInt(r, 16), Number.parseInt(g, 16), Number.parseInt(b, 16)];
  }
  const [, h, s, l] = HSL_COLOR.exec(color) ?? [];
  if (h !== undefined && s !== undefined && l !== undefined) {
    return hslToRgb(Number(h), Number(s), Number(l));
  }
  throw new Error(`unsupported colour notation: ${color}`);
}

/** One channel's linear-light value, from the 0-255 sRGB range. */
function toLinear(raw: number): number {
  const value = raw / 255;
  return value <= SRGB_KNEE ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2 relative luminance. */
export function relativeLuminance([red, green, blue]: Rgb): number {
  return 0.2126 * toLinear(red) + 0.7152 * toLinear(green) + 0.0722 * toLinear(blue);
}

/** WCAG 2 contrast ratio, from 1:1 to 21:1. Symmetric in its two arguments. */
export function contrastRatio(foreground: Rgb, background: Rgb): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].toSorted(
    (a, b) => b - a
  ) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}
