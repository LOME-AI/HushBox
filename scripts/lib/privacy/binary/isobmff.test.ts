import { describe, expect, it } from 'vitest';

import { isoBmffScanRanges, matchesIsoBmff, parseIsoBmff } from './isobmff.js';

const box = (type: string, ...bodies: readonly Buffer[]): Buffer => {
  const body = Buffer.concat([...bodies]);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};

const ftyp = (): Buffer => box('ftyp', Buffer.from('isom'), Buffer.alloc(8));

const versionZeroHeader = (creation: number, modification: number): Buffer => {
  const body = Buffer.alloc(20);
  body.writeUInt32BE(creation, 4);
  body.writeUInt32BE(modification, 8);
  return body;
};

const ilstEntry = (name: string, value: string): Buffer =>
  box(name, box('data', Buffer.alloc(8), Buffer.from(value, 'latin1')));

const SECONDS_1904_TO_1970 = 2_082_844_800;

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

describe('matchesIsoBmff', () => {
  it('matches a file whose second box word is the brand marker', () => {
    expect(matchesIsoBmff(ftyp())).toBe(true);
  });

  it('does not match a blob too short to hold a box header', () => {
    expect(matchesIsoBmff(Buffer.alloc(4))).toBe(false);
  });

  it('does not match a blob whose leading box is not a brand', () => {
    expect(matchesIsoBmff(box('moov', Buffer.alloc(4)))).toBe(false);
  });
});

describe('parseIsoBmff', () => {
  it('reports no region for a file carrying only a brand and media data', () => {
    expect(parseIsoBmff(Buffer.concat([ftyp(), box('mdat', Buffer.alloc(32))]))).toEqual([]);
  });

  it('reports a uuid box as an identity carrier', () => {
    const body = Buffer.concat([Buffer.alloc(16), Buffer.from('c2pa manifest')]);
    const [region] = parseIsoBmff(Buffer.concat([ftyp(), box('uuid', body)]));
    expect(region?.kind).toBe('isobmff:uuid');
    expect(region?.carriesIdentity).toBe(true);
    expect(region?.text).toContain('c2pa manifest');
  });

  it('reports an item-list entry carrying a payload', () => {
    const bytes = Buffer.concat([
      ftyp(),
      box(
        'moov',
        box('udta', box('meta', Buffer.alloc(4), box('ilst', ilstEntry('©too', 'SomeMuxer'))))
      ),
    ]);
    const [region] = parseIsoBmff(bytes);
    expect(region?.kind).toBe('isobmff:ilst-entry');
    expect(region?.text).toContain('SomeMuxer');
  });

  it('names the structural path of an item-list entry', () => {
    const bytes = Buffer.concat([
      ftyp(),
      box(
        'moov',
        box('udta', box('meta', Buffer.alloc(4), box('ilst', ilstEntry('©cmt', 'a comment'))))
      ),
    ]);
    expect(parseIsoBmff(bytes)[0]?.location).toBe('moov/udta/meta/ilst/©cmt');
  });

  it('reports nothing for an empty item list', () => {
    const bytes = Buffer.concat([
      ftyp(),
      box('moov', box('udta', box('meta', Buffer.alloc(4), box('ilst')))),
    ]);
    expect(parseIsoBmff(bytes)).toEqual([]);
  });

  it('reports a free-form user-data leaf', () => {
    const bytes = Buffer.concat([
      ftyp(),
      box('moov', box('udta', box('©swr', Buffer.from('SomeTool 3')))),
    ]);
    const [region] = parseIsoBmff(bytes);
    expect(region?.kind).toBe('isobmff:udta-leaf');
    expect(region?.text).toContain('SomeTool 3');
  });

  it('decodes a non-zero movie-header creation time as a UTC instant', () => {
    const creation = SECONDS_1904_TO_1970 + 90_000;
    const bytes = Buffer.concat([ftyp(), box('moov', box('mvhd', versionZeroHeader(creation, 0)))]);
    const [region] = parseIsoBmff(bytes);
    expect(region?.kind).toBe('isobmff:mvhd');
    expect(region?.instants).toEqual([{ field: 'creationTime', secondsUtc: 90_000 }]);
  });

  it('reports both header instants when each is set', () => {
    const bytes = Buffer.concat([
      ftyp(),
      box('moov', box('mvhd', versionZeroHeader(SECONDS_1904_TO_1970, SECONDS_1904_TO_1970 + 5))),
    ]);
    expect(parseIsoBmff(bytes)[0]?.instants).toHaveLength(2);
  });

  it('ignores a zeroed movie-header time', () => {
    const bytes = Buffer.concat([ftyp(), box('moov', box('mvhd', versionZeroHeader(0, 0)))]);
    expect(parseIsoBmff(bytes)).toEqual([]);
  });

  it('reads a version-one header with 64-bit times', () => {
    const body = Buffer.alloc(32);
    body[0] = 1;
    body.writeBigUInt64BE(BigInt(SECONDS_1904_TO_1970 + 7), 4);
    const bytes = Buffer.concat([ftyp(), box('moov', box('mvhd', body))]);
    expect(parseIsoBmff(bytes)[0]?.instants[0]?.secondsUtc).toBe(7);
  });

  it('reports a track header separately from the movie header', () => {
    const bytes = Buffer.concat([
      ftyp(),
      box(
        'moov',
        box('trak', box('tkhd', versionZeroHeader(SECONDS_1904_TO_1970 + 1, 0))),
        box('trak', box('mdia', box('mdhd', versionZeroHeader(SECONDS_1904_TO_1970 + 2, 0))))
      ),
    ]);
    expect(parseIsoBmff(bytes).map((region) => region.kind)).toEqual([
      'isobmff:tkhd',
      'isobmff:mdhd',
    ]);
  });

  it('stops at a box whose declared size overruns the buffer', () => {
    const overrun = Buffer.alloc(8);
    overrun.writeUInt32BE(9999);
    overrun.write('uuid', 4, 'latin1');
    expect(refusals(parseIsoBmff(Buffer.concat([ftyp(), overrun])))).toBe(1);
  });

  it('stops at a box declaring a size smaller than its own header', () => {
    const degenerate = Buffer.alloc(8);
    degenerate.writeUInt32BE(2);
    degenerate.write('uuid', 4, 'latin1');
    expect(refusals(parseIsoBmff(Buffer.concat([ftyp(), degenerate])))).toBe(1);
  });

  it('reads a 64-bit extended box size', () => {
    const body = Buffer.concat([Buffer.alloc(16), Buffer.from('c2pa manifest')]);
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1);
    header.write('uuid', 4, 'latin1');
    header.writeBigUInt64BE(BigInt(16 + body.length), 8);
    const bytes = Buffer.concat([ftyp(), header, body]);
    expect(parseIsoBmff(bytes)[0]?.kind).toBe('isobmff:uuid');
  });

  it('treats a zero size as running to the end of the file', () => {
    const header = Buffer.alloc(8);
    header.write('uuid', 4, 'latin1');
    const bytes = Buffer.concat([ftyp(), header, Buffer.alloc(16), Buffer.from('c2pa manifest')]);
    expect(parseIsoBmff(bytes)[0]?.kind).toBe('isobmff:uuid');
  });
});

describe('isoBmffScanRanges', () => {
  it('offers the media-data payload for the bounded literal scan', () => {
    const bytes = Buffer.concat([ftyp(), box('mdat', Buffer.alloc(32))]);
    expect(isoBmffScanRanges(bytes)).toEqual([
      { location: 'mdat', start: ftyp().length + 8, end: bytes.length },
    ]);
  });

  it('offers nothing when the file carries no media data', () => {
    expect(isoBmffScanRanges(ftyp())).toEqual([]);
  });

  it('offers nothing when the box framing is damaged', () => {
    const overrun = Buffer.alloc(8);
    overrun.writeUInt32BE(9999);
    overrun.write('mdat', 4, 'latin1');
    expect(isoBmffScanRanges(Buffer.concat([ftyp(), overrun]))).toEqual([]);
  });

  it('stops at a truncated 64-bit box header', () => {
    const header = Buffer.alloc(10);
    header.writeUInt32BE(1);
    header.write('uuid', 4, 'latin1');
    expect(refusals(parseIsoBmff(Buffer.concat([ftyp(), header])))).toBe(1);
  });

  it('ignores a movie header too short to hold its time fields', () => {
    const bytes = Buffer.concat([ftyp(), box('moov', box('mvhd', Buffer.alloc(8)))]);
    expect(parseIsoBmff(bytes)).toEqual([]);
  });

  it('ignores a version-one movie header truncated inside its time fields', () => {
    const body = Buffer.alloc(16);
    body[0] = 1;
    body.writeBigUInt64BE(BigInt(SECONDS_1904_TO_1970 + 7), 4);
    const bytes = Buffer.concat([ftyp(), box('moov', box('mvhd', body))]);
    expect(parseIsoBmff(bytes)).toEqual([]);
  });

  it('refuses a container nested past the depth limit instead of overflowing the stack', () => {
    let nested = box('mvhd', Buffer.alloc(20));
    for (let depth = 0; depth < 5000; depth++) nested = box('moov', nested);
    const regions = parseIsoBmff(Buffer.concat([ftyp(), nested]));
    expect(refusals(regions)).toBe(1);
    expect(regions[0]?.kind).toBe('isobmff:over-deep-container');
  });

  it('walks nesting that stays inside the depth limit', () => {
    const header = Buffer.alloc(20);
    header.writeUInt32BE(SECONDS_1904_TO_1970 + 3600, 4);
    const bytes = Buffer.concat([
      ftyp(),
      box('moov', box('trak', box('mdia', box('mdhd', header)))),
    ]);
    expect(parseIsoBmff(bytes)[0]?.kind).toBe('isobmff:mdhd');
  });

  it('refuses a nested container whose own children stop parsing', () => {
    const overrun = Buffer.alloc(8);
    overrun.writeUInt32BE(9999);
    overrun.write('uuid', 4, 'latin1');
    const bytes = Buffer.concat([ftyp(), box('moov', overrun)]);
    const regions = parseIsoBmff(bytes);
    expect(refusals(regions)).toBe(1);
    expect(regions[0]?.kind).toBe('isobmff:boxes');
  });

  it('refuses a nested container whose children leave a tail unaccounted', () => {
    const bytes = Buffer.concat([ftyp(), box('moov', Buffer.alloc(4))]);
    expect(refusals(parseIsoBmff(bytes))).toBe(1);
  });

  it('reports a tail too short to hold a box header', () => {
    const bytes = Buffer.concat([ftyp(), Buffer.alloc(5, 0x41)]);
    const regions = parseIsoBmff(bytes);
    expect(regions[0]?.kind).toBe('isobmff:trailing');
  });

  it('names a printable box type in the location', () => {
    const bytes = Buffer.concat([
      ftyp(),
      box('moov', box('udta', box('\u00A9swr', Buffer.from('SomeTool 3')))),
    ]);
    expect(parseIsoBmff(bytes)[0]?.location).toBe('moov/udta/\u00A9swr');
  });

  it('refuses a box type carrying a control byte rather than naming it', () => {
    const bytes = Buffer.concat([
      ftyp(),
      box('moov', box('udta', box('a\u001Bbc', Buffer.from('SomeTool 3')))),
    ]);
    const regions = parseIsoBmff(bytes);
    expect(refusals(regions)).toBe(1);
    for (const region of regions) expect(region.location).not.toContain('\u001B');
  });

  it('refuses a size-zero box of a type it does not walk into', () => {
    const lid = Buffer.alloc(8);
    lid.write('junk', 4, 'latin1');
    const bytes = Buffer.concat([ftyp(), lid, Buffer.from('hidden content', 'latin1')]);
    expect(refusals(parseIsoBmff(bytes))).toBe(1);
  });
});

/**
 * A visual sample entry's fixed prologue: six reserved bytes, the data
 * reference index, sixteen bytes of predefined and reserved fields, width,
 * height, the two resolutions, one reserved word and the frame count — then a
 * thirty-two byte Pascal string the muxer fills with whatever it likes.
 */
const SAMPLE_ENTRY_PROLOGUE_BYTES = 42;

const compressorName = (value: string): Buffer => {
  const field = Buffer.alloc(32);
  field.writeUInt8(value.length);
  field.write(value, 1, 'latin1');
  return Buffer.concat([Buffer.alloc(SAMPLE_ENTRY_PROLOGUE_BYTES), field, Buffer.alloc(4)]);
};

/** `stsd` is a full box: a version-and-flags word and an entry count precede its children. */
const stsd = (...entries: readonly Buffer[]): Buffer =>
  box('stsd', Buffer.alloc(4), Buffer.from([0, 0, 0, entries.length]), ...entries);

const trackWith = (sampleDescription: Buffer): Buffer =>
  box('moov', box('trak', box('mdia', box('minf', box('stbl', sampleDescription)))));

describe('parseIsoBmff — the sample description', () => {
  it('reads the text a sample entry carries', () => {
    const regions = parseIsoBmff(
      Buffer.concat([ftyp(), trackWith(stsd(box('avc1', compressorName('SomeEncoder 1.2'))))])
    );
    expect(regions.map((region) => region.text)).toEqual(['SomeEncoder 1.2']);
  });

  it('names where the entry sits without interpolating its own bytes', () => {
    const [region] = parseIsoBmff(
      Buffer.concat([ftyp(), trackWith(stsd(box('avc1', compressorName('SomeEncoder 1.2'))))])
    );
    expect(region).toMatchObject({
      kind: 'isobmff:sample-entry',
      location: 'moov/trak/mdia/minf/stbl/stsd/avc1',
      carriesIdentity: false,
    });
  });

  it('reports no region for a sample entry carrying no text', () => {
    const regions = parseIsoBmff(
      Buffer.concat([ftyp(), trackWith(stsd(box('avc1', compressorName(''))))])
    );
    expect(regions).toEqual([]);
  });

  it('refuses a sample description whose entries do not fill it', () => {
    const short = box('stsd', Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), Buffer.alloc(6));
    expect(refusals(parseIsoBmff(Buffer.concat([ftyp(), trackWith(short)])))).toBe(1);
  });

  it('walks through the media information and sample table to reach it', () => {
    // The two boxes between the media box and the sample description are the
    // reason this text went unreported: neither was walked into.
    const regions = parseIsoBmff(
      Buffer.concat([
        ftyp(),
        box('moov', box('trak', box('mdia', box('minf', box('stbl', stsd()))))),
      ])
    );
    expect(refusals(regions)).toBe(0);
  });
});

/**
 * The nested walk keeps what it found and appends its refusal; the top-level
 * walk threw both away. A gate that reports the damage still refuses the blob,
 * so nothing escapes — what is lost is the inventory the operator and the
 * stripper act on, and the same branch also emptied the payload ranges, so the
 * bitstream literals went with it.
 */
describe('parseIsoBmff — damage adds to the findings rather than replacing them', () => {
  const disclosing = (): Buffer =>
    Buffer.concat([
      ftyp(),
      box(
        'moov',
        box('udta', box('meta', Buffer.alloc(4), box('ilst', ilstEntry('©too', 'a muxer'))))
      ),
    ]);

  /** Sixteen bytes no box header can be read out of. */
  const damage = (): Buffer => Buffer.alloc(16);

  it('keeps every region it walked before the framing stopped making sense', () => {
    const intact = parseIsoBmff(disclosing());
    const damaged = parseIsoBmff(Buffer.concat([disclosing(), damage()]));

    expect(intact.length).toBeGreaterThan(0);
    expect(damaged.filter((region) => region.malformed === undefined)).toEqual(intact);
  });

  it('reports the damage alongside them', () => {
    expect(refusals(parseIsoBmff(Buffer.concat([disclosing(), damage()])))).toBe(1);
  });

  it('still declares the coded payload ranges it walked', () => {
    const clip = Buffer.concat([ftyp(), box('mdat', Buffer.alloc(32))]);
    expect(isoBmffScanRanges(Buffer.concat([clip, damage()]))).toHaveLength(1);
  });
});

/**
 * A box the framing legally declares but this gate's enumeration does not name
 * was read by nothing at all — a sixty-four-byte file whose only payload is a
 * padding box carrying a host path and a full datetime came back clean, and
 * padding boxes are ordinary toolchain output rather than a construction.
 *
 * The remedy reconciles the byte space instead of lengthening the carrier list.
 * A list only covers the carriers somebody thought of; the next padding type
 * blinds it again.
 */
describe('parseIsoBmff — a declared box no rule names is still read', () => {
  const disclosure = ['', 'home', 'someone', 'clip'].join('/');

  it('reads a padding box for values', () => {
    const regions = parseIsoBmff(
      Buffer.concat([ftyp(), box('free', Buffer.from(disclosure, 'latin1'))])
    );
    expect(regions.map((region) => region.text).join('\n')).toContain(disclosure);
  });

  it('reads a box of a type this gate has never heard of', () => {
    const regions = parseIsoBmff(
      Buffer.concat([ftyp(), box('zqrx', Buffer.from(disclosure, 'latin1'))])
    );
    expect(regions.map((region) => region.text).join('\n')).toContain(disclosure);
  });

  it('does not report the existence of such a box on its own', () => {
    const regions = parseIsoBmff(Buffer.concat([ftyp(), box('free', Buffer.alloc(32))]));
    expect(regions).toEqual([]);
  });

  it('leaves the coded payload to the sweep that already declares it', () => {
    const regions = parseIsoBmff(
      Buffer.concat([ftyp(), box('mdat', Buffer.from(disclosure, 'latin1'))])
    );
    expect(regions).toEqual([]);
  });
});
