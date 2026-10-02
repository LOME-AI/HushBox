export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** An 8-bit greyscale picture, one byte per pixel, rows from the top. */
export interface GrayImage extends ImageSize {
  readonly pixels: Uint8Array;
}

function requireDimension(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(
      `${name} ${String(value)} is not an integer of at least ${String(minimum)} pixels`
    );
  }
}

/** A black picture of the given size; refuses a width below 1 or a height below `minHeight`. */
export function blankImage(size: ImageSize, minHeight: number): GrayImage {
  requireDimension('width', size.width, 1);
  requireDimension('height', size.height, minHeight);
  return {
    width: size.width,
    height: size.height,
    pixels: new Uint8Array(size.width * size.height),
  };
}
