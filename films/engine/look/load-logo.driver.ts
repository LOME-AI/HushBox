import logoFile from '@hushbox/ui/assets/HushBoxLogo.png';

import { logoPathData, traceLogo } from './logo.js';

import type { LookLogo } from './contract.js';

/**
 * Decodes the brand logo file as written (not premultiplied, no colour
 * conversion) and traces its mark from the decoded alpha, so the parts a look
 * fills are derived from the file on every load and never drift from it.
 */
export async function loadLookLogo(): Promise<LookLogo> {
  const response = await fetch(logoFile);
  if (!response.ok) {
    throw new Error(
      `the brand logo did not load from ${logoFile} (HTTP ${String(response.status)})`
    );
  }
  const image = await createImageBitmap(await response.blob(), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('the browser gave the logo tracer no 2D context');
  }
  context.drawImage(image, 0, 0);
  const parts = traceLogo(context.getImageData(0, 0, image.width, image.height)).map((part) => ({
    ...part,
    path: new Path2D(logoPathData(part.outline)),
  }));
  return { image, width: image.width, height: image.height, parts };
}
