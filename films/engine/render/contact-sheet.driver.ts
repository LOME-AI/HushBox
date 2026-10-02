import sharp from 'sharp';

import { SHEET_BACKGROUND, labelImage, sheetLayout } from './contact-sheet.js';
import { publishFile } from './run-directory.js';

import type { OverlayOptions } from 'sharp';

/** One rendered still and the frame it shows. */
export interface SheetStill {
  frame: number;
  file: string;
}

/**
 * Publishes a contact sheet of the stills, in the order given, each labelled
 * with its frame; a reader of `output` sees the earlier sheet or this one.
 */
export async function writeContactSheet(
  stills: readonly SheetStill[],
  output: string
): Promise<string> {
  const layout = sheetLayout(stills);
  const thumbnails = await Promise.all(
    layout.tiles.map(
      async ({ file, left, top }): Promise<OverlayOptions> => ({
        input: await sharp(file).resize(layout.thumbWidth, layout.thumbHeight).png().toBuffer(),
        left,
        top,
      })
    )
  );
  const labels = layout.tiles.map(({ frame, left, labelTop }): OverlayOptions => {
    const label = labelImage(String(frame));
    return {
      input: Buffer.from(label.pixels),
      raw: { width: label.width, height: label.height, channels: 4 },
      left,
      top: labelTop,
    };
  });
  const [r, g, b] = SHEET_BACKGROUND;
  const sheet = await sharp({
    create: { width: layout.width, height: layout.height, channels: 3, background: { r, g, b } },
  })
    .composite([...thumbnails, ...labels])
    .png()
    .toBuffer();
  return publishFile(output, new Uint8Array(sheet));
}
