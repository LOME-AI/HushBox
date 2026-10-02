/** Red, green, blue and alpha, each in [0, 1]. */
export type Rgba = [number, number, number, number];

const HEX = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/;

/** One sRGB-encoded channel in [0, 1] as linear light, by the sRGB transfer function. */
export function srgbToLinear(channel: number): number {
  if (channel <= 0.040_45) {
    return channel / 12.92;
  }
  return ((channel + 0.055) / 1.055) ** 2.4;
}

/** Whether the colour is written in one of the hex forms `linearColor` reads. */
export function isHexColor(css: string): boolean {
  return HEX.test(css.trim().toLowerCase());
}

/**
 * A hex colour (`#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, as the brand stylesheet and
 * the palettes write them) in linear light, its alpha left as written. Any other
 * syntax is refused rather than guessed at.
 */
export function linearColor(css: string): Rgba {
  if (!isHexColor(css)) {
    throw new RangeError(`"${css}" is not a hex colour (#rgb, #rgba, #rrggbb or #rrggbbaa)`);
  }
  const digits = css.trim().slice(1);
  const full = digits.length <= 4 ? digits.replaceAll(/./g, (digit) => digit + digit) : digits;
  const channel = (index: number): number =>
    Number.parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
  const alpha = full.length === 8 ? channel(3) : 1;
  return [srgbToLinear(channel(0)), srgbToLinear(channel(1)), srgbToLinear(channel(2)), alpha];
}
