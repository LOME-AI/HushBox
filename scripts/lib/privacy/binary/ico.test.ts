import { describe, expect, it } from 'vitest';

import { matchesIco, parseIco } from './ico.js';
import { PNG_SIGNATURE } from './png.js';

const DIRECTORY_HEADER_BYTES = 6;
const DIRECTORY_ENTRY_BYTES = 16;

const ico = (images: readonly Buffer[]): Buffer => {
  const header = Buffer.alloc(DIRECTORY_HEADER_BYTES);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = DIRECTORY_HEADER_BYTES + DIRECTORY_ENTRY_BYTES * images.length;
  const entries = images.map((image) => {
    const entry = Buffer.alloc(DIRECTORY_ENTRY_BYTES);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images]);
};

const dib = (): Buffer => {
  const image = Buffer.alloc(40);
  image.writeUInt32LE(40, 0);
  return image;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};

const embeddedPng = (): Buffer =>
  Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', Buffer.concat([Buffer.from('Software'), Buffer.from([0]), Buffer.from('Tool')])),
    chunk('IEND', Buffer.alloc(0)),
  ]);

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

describe('matchesIco', () => {
  it('matches an icon directory', () => {
    expect(matchesIco(ico([dib()]))).toBe(true);
  });

  it('does not match a cursor directory', () => {
    const bytes = ico([dib()]);
    bytes.writeUInt16LE(2, 2);
    expect(matchesIco(bytes)).toBe(false);
  });

  it('does not match a directory declaring no images', () => {
    const bytes = ico([]);
    expect(matchesIco(bytes)).toBe(false);
  });

  it('does not match a blob too short to hold a directory header', () => {
    expect(matchesIco(Buffer.alloc(4))).toBe(false);
  });
});

describe('parseIco', () => {
  it('reports no region for a directory of device-independent bitmaps', () => {
    expect(parseIco(ico([dib(), dib()]))).toEqual([]);
  });

  it('reports the metadata of an embedded PNG image', () => {
    const [region] = parseIco(ico([embeddedPng()]));
    expect(region?.kind).toBe('png:tEXt');
  });

  it('names the containing image in the region path', () => {
    expect(parseIco(ico([dib(), embeddedPng()]))[0]?.location).toBe('image[1]/tEXt');
  });

  it('keeps an embedded region at its absolute offset', () => {
    const bytes = ico([embeddedPng()]);
    const imageStart = DIRECTORY_HEADER_BYTES + DIRECTORY_ENTRY_BYTES;
    expect(parseIco(bytes)[0]?.offset).toBe(imageStart + PNG_SIGNATURE.length + 25);
  });

  it('skips an entry whose declared extent overruns the buffer', () => {
    const bytes = ico([embeddedPng()]);
    bytes.writeUInt32LE(9999, DIRECTORY_HEADER_BYTES + 8);
    const regions = parseIco(bytes);
    // Two refusals: the entry's extent overruns, and with no readable image the
    // directory then accounts for none of the bytes behind it.
    expect(refusals(regions)).toBe(2);
    expect(regions.map((region) => region.kind)).toEqual(['ico:image', 'ico:trailing']);
  });

  it('stops where the directory declares more entries than the blob holds', () => {
    const bytes = ico([embeddedPng()]);
    bytes.writeUInt16LE(2, 4);
    // Two refusals: the first entry's image extent runs past the end, and the
    // second entry's directory record is not there at all.
    expect(
      refusals(parseIco(bytes.subarray(0, DIRECTORY_HEADER_BYTES + DIRECTORY_ENTRY_BYTES)))
    ).toBe(2);
  });

  it('parses one image extent once however many entries alias it', () => {
    const image = embeddedPng();
    const entries = 64;
    const header = Buffer.alloc(DIRECTORY_HEADER_BYTES);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries, 4);
    const imageStart = DIRECTORY_HEADER_BYTES + entries * DIRECTORY_ENTRY_BYTES;
    const directory = Buffer.concat(
      Array.from({ length: entries }, () => {
        const entry = Buffer.alloc(DIRECTORY_ENTRY_BYTES);
        entry.writeUInt32LE(image.length, 8);
        entry.writeUInt32LE(imageStart, 12);
        return entry;
      })
    );
    const regions = parseIco(Buffer.concat([header, directory, image]));
    expect(regions).toHaveLength(entries);
    expect(new Set(regions.map((region) => region.offset)).size).toBe(1);
  });

  /**
   * The per-blob budget cannot see this shape: the aliased image yields no
   * regions at all, so re-parsing it costs nothing the budget meters while
   * costing the walk every time. Measured at twenty thousand entries, parsing
   * each distinct extent once is the difference between ten milliseconds and
   * three quarters of a minute — which is why the memo is a correctness
   * property here rather than an optimisation.
   */
  it('walks an aliased extent once even when it yields no regions', () => {
    const entries = 20_000;
    const image = Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      chunk('IHDR', Buffer.alloc(13)),
      ...Array.from({ length: 20_000 }, () => chunk('IDAT', Buffer.alloc(1))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const header = Buffer.alloc(DIRECTORY_HEADER_BYTES);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries, 4);
    const imageStart = DIRECTORY_HEADER_BYTES + entries * DIRECTORY_ENTRY_BYTES;
    const directory = Buffer.concat(
      Array.from({ length: entries }, () => {
        const entry = Buffer.alloc(DIRECTORY_ENTRY_BYTES);
        entry.writeUInt32LE(image.length, 8);
        entry.writeUInt32LE(imageStart, 12);
        return entry;
      })
    );

    const started = process.hrtime.bigint();
    const regions = parseIco(Buffer.concat([header, directory, image]));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(regions).toEqual([]);
    expect(elapsedMs).toBeLessThan(5000);
  });

  /**
   * The shape the memo cannot catch and the region budget cannot meter: every
   * entry shares the image's start, so the signature still matches, but declares
   * a different length — a memo miss every time, yielding no regions, so nothing
   * that counts results ever trips. Measured before the work charge existed:
   * quadratic, and at the format ceiling a file under two megabytes occupied the
   * gate for minutes and then reported clean.
   */
  it('bounds entries that vary the declared length to miss the memo', () => {
    const entries = 40_000;
    const image = Buffer.concat([
      Buffer.from(PNG_SIGNATURE),
      chunk('IHDR', Buffer.alloc(13)),
      ...Array.from({ length: 8000 }, () => chunk('IDAT', Buffer.alloc(1))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const header = Buffer.alloc(DIRECTORY_HEADER_BYTES);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries, 4);
    const imageStart = DIRECTORY_HEADER_BYTES + entries * DIRECTORY_ENTRY_BYTES;
    const directory = Buffer.concat(
      Array.from({ length: entries }, (_unused, index) => {
        const entry = Buffer.alloc(DIRECTORY_ENTRY_BYTES);
        entry.writeUInt32LE(Math.max(64, image.length - (index % 7000) * 13), 8);
        entry.writeUInt32LE(imageStart, 12);
        return entry;
      })
    );

    const regions = parseIco(Buffer.concat([header, directory, image]));

    // The point is *which* bound stopped it. Both bounds end in a refusal, so a
    // refusal proves nothing; the region count does. Metered by the work charge
    // the parse stops in the hundreds, and metered only by its results it runs
    // all the way to the region ceiling — which is the hole this closes.
    expect(regions.at(-1)?.kind).toBe('blob:budget');
    // Half the region ceiling, written out: an expected value read from the
    // module under test moves with it and cannot fail for its own subject.
    expect(regions.length).toBeLessThan(2048);
  });
});

/**
 * A directory entry pointing at anything other than a PNG was skipped whole, so
 * a device-independent bitmap was the one image extent in this format that
 * nothing read. The same walk that bounds the aliased-extent case carries it, so
 * the memo and the work charge still hold.
 */
describe('parseIco — an entry this parser cannot decode is still read', () => {
  const disclosure = ['', 'home', 'someone', 'icon'].join('/');

  it('reads a non-PNG image extent for values', () => {
    const image = Buffer.concat([dib(), Buffer.from(disclosure, 'latin1')]);
    expect(
      parseIco(ico([image]))
        .map((region) => region.text)
        .join('\n')
    ).toContain(disclosure);
  });

  it('reports nothing for a device-independent bitmap carrying no value', () => {
    expect(parseIco(ico([dib()]))).toEqual([]);
  });

  it('walks one aliased non-PNG extent once', () => {
    const entries = 20_000;
    const image = Buffer.concat([dib(), Buffer.alloc(4096)]);
    const header = Buffer.alloc(DIRECTORY_HEADER_BYTES);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries, 4);
    const imageStart = DIRECTORY_HEADER_BYTES + entries * DIRECTORY_ENTRY_BYTES;
    const directory = Buffer.concat(
      Array.from({ length: entries }, () => {
        const entry = Buffer.alloc(DIRECTORY_ENTRY_BYTES);
        entry.writeUInt32LE(image.length, 8);
        entry.writeUInt32LE(imageStart, 12);
        return entry;
      })
    );

    const started = process.hrtime.bigint();
    const regions = parseIco(Buffer.concat([header, directory, image]));
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(regions).toEqual([]);
    expect(elapsedMs).toBeLessThan(5000);
  });
});
