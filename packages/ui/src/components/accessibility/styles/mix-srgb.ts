/**
 * Models CSS `color-mix(in srgb, top <fraction>%, bottom)` for the style tests, which
 * measure colours that only exist as stylesheet source and are never rendered.
 */

import { parseCssColor } from '@hushbox/shared/color/contrast';

/**
 * The mix `color-mix(in srgb, …)` produces: per-channel interpolation on the
 * gamma-encoded sRGB channels, `fraction` weighting `top`. The result comes back in the
 * `#rrggbb` notation the callers' other colours arrive in, so a mix composes with
 * {@link parseCssColor} and nests as the argument of another mix; 8 bits per channel is
 * also the precision the browser rasterizes the declaration to.
 */
export function mixSrgb(top: string, bottom: string, fraction: number): string {
  const [topRed, topGreen, topBlue] = parseCssColor(top);
  const [bottomRed, bottomGreen, bottomBlue] = parseCssColor(bottom);
  const channel = (over: number, under: number): string =>
    Math.round(fraction * over + (1 - fraction) * under)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(topRed, bottomRed)}${channel(topGreen, bottomGreen)}${channel(topBlue, bottomBlue)}`;
}
