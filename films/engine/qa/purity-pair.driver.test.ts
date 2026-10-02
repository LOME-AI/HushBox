import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { pairPurityFrame } from './purity-pair.driver.js';

const SIDE_PX = 4;

/** A small opaque PNG of one flat colour. */
async function flatPng(red: number): Promise<Uint8Array> {
  const png = await sharp({
    create: {
      width: SIDE_PX,
      height: SIDE_PX,
      channels: 3,
      background: { r: red, g: 0, b: 0 },
    },
  })
    .png()
    .toBuffer();
  return new Uint8Array(png);
}

describe('pairPurityFrame', () => {
  it('leaves both sides undecoded when their bytes match', async () => {
    const master = await flatPng(10);
    const still = new Uint8Array(master);

    const paired = await pairPurityFrame('film', { frame: 3, master, still });

    expect(paired).toEqual({
      frame: 3,
      master: { bytes: master, raster: null },
      still: { bytes: still, raster: null },
    });
  });

  it('decodes both sides when their bytes differ', async () => {
    const master = await flatPng(10);
    const still = await flatPng(200);

    const paired = await pairPurityFrame('film', { frame: 3, master, still });

    expect([paired.master.raster?.data[0], paired.still.raster?.data[0]]).toEqual([10, 200]);
  });

  it('refuses a frame with no master PNG, naming the film and the frame', async () => {
    const still = await flatPng(10);

    await expect(pairPurityFrame('film', { frame: 3, master: undefined, still })).rejects.toThrow(
      'film: purity: frame 3 has no master PNG to compare'
    );
  });

  it('refuses a frame with no fresh-page still, naming the film and the frame', async () => {
    const master = await flatPng(10);

    await expect(pairPurityFrame('film', { frame: 3, master, still: undefined })).rejects.toThrow(
      'film: purity: frame 3 has no fresh-page still to compare'
    );
  });
});
