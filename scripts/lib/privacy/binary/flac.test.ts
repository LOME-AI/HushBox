import { describe, expect, it } from 'vitest';

import { flacAudioStart, flacScanRanges, matchesFlac, parseFlac } from './flac.js';

const block = (type: number, body: Buffer, last = false): Buffer => {
  const header = Buffer.alloc(4);
  header[0] = (last ? 0x80 : 0) | type;
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
};

const vorbisComment = (vendor: string, comments: readonly string[]): Buffer => {
  const parts: Buffer[] = [];
  const vendorBytes = Buffer.from(vendor, 'utf8');
  const vendorLength = Buffer.alloc(4);
  vendorLength.writeUInt32LE(vendorBytes.length);
  parts.push(vendorLength, vendorBytes);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length);
  parts.push(count);
  for (const comment of comments) {
    const value = Buffer.from(comment, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(value.length);
    parts.push(length, value);
  }
  return Buffer.concat(parts);
};

const streamInfo = (): Buffer => block(0, Buffer.alloc(34));

const flac = (...blocks: readonly Buffer[]): Buffer =>
  Buffer.concat([Buffer.from('fLaC', 'latin1'), streamInfo(), ...blocks]);

const id3Prefixed = (body: Buffer, bodyLength: number): Buffer =>
  Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([4, 0, 0]),
    Buffer.from([0, 0, 0, bodyLength]),
    Buffer.alloc(bodyLength),
    body,
  ]);

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

describe('matchesFlac', () => {
  it('matches a bare FLAC stream', () => {
    expect(matchesFlac(flac(block(1, Buffer.alloc(8), true)))).toBe(true);
  });

  it('matches a FLAC stream behind an ID3 prefix', () => {
    expect(matchesFlac(id3Prefixed(flac(block(1, Buffer.alloc(8), true)), 16))).toBe(true);
  });

  it('does not match an MPEG stream behind an ID3 prefix', () => {
    expect(matchesFlac(id3Prefixed(Buffer.from([0xff, 0xfb, 0, 0]), 16))).toBe(false);
  });
});

describe('parseFlac', () => {
  it('reports no region for a stream carrying only stream info and padding', () => {
    expect(parseFlac(flac(block(1, Buffer.alloc(64), true)))).toEqual([]);
  });

  it('decodes the vendor string of a comment block', () => {
    const [region] = parseFlac(flac(block(4, vorbisComment('SomeMuxer 1.2', []), true)));
    expect(region?.kind).toBe('flac:VORBIS_COMMENT');
    expect(region?.text).toContain('SomeMuxer 1.2');
  });

  it('decodes each user comment', () => {
    const [region] = parseFlac(
      flac(block(4, vorbisComment('v', ['encoder=SomeMuxer', 'aigc={"x":1}']), true))
    );
    expect(region?.text).toContain('encoder=SomeMuxer');
    expect(region?.text).toContain('aigc={"x":1}');
  });

  it('treats a comment block as an identity carrier', () => {
    const [region] = parseFlac(flac(block(4, vorbisComment('v', []), true)));
    expect(region?.carriesIdentity).toBe(true);
  });

  it('reports an application block', () => {
    const body = Buffer.concat([Buffer.from('ABCD'), Buffer.from('vendor payload')]);
    const [region] = parseFlac(flac(block(2, body, true)));
    expect(region?.kind).toBe('flac:APPLICATION');
    expect(region?.text).toContain('vendor payload');
  });

  it('locates a block at its absolute offset', () => {
    const [region] = parseFlac(flac(block(4, vorbisComment('v', []), true)));
    expect(region?.offset).toBe(4 + 38);
  });

  it('keeps offsets absolute behind an ID3 prefix', () => {
    const stream = flac(block(4, vorbisComment('v', []), true));
    const regions = parseFlac(id3Prefixed(stream, 16));
    expect(regions.some((region) => region.kind === 'flac:VORBIS_COMMENT')).toBe(true);
    expect(regions.find((region) => region.kind === 'flac:VORBIS_COMMENT')?.offset).toBe(
      26 + 4 + 38
    );
  });

  it('reports the ID3 prefix alongside the stream metadata', () => {
    const stream = flac(block(4, vorbisComment('v', []), true));
    const tagBody = Buffer.concat([
      Buffer.from('GEOB'),
      Buffer.from([0, 0, 0, 12]),
      Buffer.alloc(2),
      Buffer.from('c2pa payload'),
    ]);
    const bytes = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([4, 0, 0]),
      Buffer.from([0, 0, 0, tagBody.length]),
      tagBody,
      stream,
    ]);
    expect(parseFlac(bytes).map((region) => region.kind)).toEqual([
      'id3:GEOB',
      'flac:VORBIS_COMMENT',
    ]);
  });

  it('stops at a block whose declared length overruns the buffer', () => {
    const bytes = Buffer.concat([
      Buffer.from('fLaC', 'latin1'),
      streamInfo(),
      Buffer.from([0x84, 0xff, 0xff, 0xff]),
    ]);
    expect(refusals(parseFlac(bytes))).toBe(1);
  });

  it('reads no metadata block past the one marked last', () => {
    const bytes = Buffer.concat([
      flac(block(1, Buffer.alloc(4), true)),
      block(4, vorbisComment('v', [])),
    ]);
    const regions = parseFlac(bytes);
    expect(regions.filter((region) => region.malformed === undefined)).toEqual([]);
  });

  it('reports bytes past the last block that do not open an audio frame', () => {
    const bytes = Buffer.concat([
      flac(block(1, Buffer.alloc(4), true)),
      block(4, vorbisComment('v', [])),
    ]);
    const regions = parseFlac(bytes);
    expect(refusals(regions)).toBe(1);
    expect(regions[0]?.kind).toBe('flac:trailing');
  });

  it('accepts coded audio following the last metadata block', () => {
    const bytes = Buffer.concat([
      flac(block(1, Buffer.alloc(4), true)),
      Buffer.from([0xff, 0xf8, 0x00, 0x00]),
    ]);
    expect(parseFlac(bytes)).toEqual([]);
  });

  it('tolerates a comment block truncated mid-string', () => {
    const truncated = Buffer.from([200, 0, 0, 0]);
    const [region] = parseFlac(flac(block(4, truncated, true)));
    expect(region?.text).toBe('');
  });

  it('reads a comment block holding only a vendor string', () => {
    const vendor = Buffer.from('SomeMuxer', 'latin1');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(vendor.length);
    const [region] = parseFlac(flac(block(4, Buffer.concat([length, vendor]), true)));
    expect(region?.text).toBe('SomeMuxer');
  });

  it('stops at a comment count larger than the block holds', () => {
    const length = Buffer.alloc(4);
    const count = Buffer.alloc(4);
    count.writeUInt32LE(4);
    const [region] = parseFlac(flac(block(4, Buffer.concat([length, count]), true)));
    expect(region?.text).toBe('');
  });

  it('stops where the stream ends part-way through a block header', () => {
    const bytes = Buffer.concat([
      Buffer.from('fLaC', 'latin1'),
      streamInfo(),
      Buffer.from([0x04, 0x00]),
    ]);
    expect(refusals(parseFlac(bytes))).toBe(1);
  });

  it('does not match a stream whose first block is not stream info', () => {
    const bytes = Buffer.concat([Buffer.from('fLaC', 'latin1'), block(4, Buffer.alloc(34), true)]);
    expect(matchesFlac(bytes)).toBe(false);
  });

  it('does not match a stream whose stream-info block is the wrong size', () => {
    const bytes = Buffer.concat([Buffer.from('fLaC', 'latin1'), block(0, Buffer.alloc(20), true)]);
    expect(matchesFlac(bytes)).toBe(false);
  });

  it('does not match a blob too short to hold a stream-info header', () => {
    expect(matchesFlac(Buffer.from('fLaC', 'latin1'))).toBe(false);
  });
});

describe('parseFlac — where a read ends exactly at the boundary', () => {
  it('walks a last metadata block whose header ends the blob', () => {
    // The block-header room check is the only thing between "read this header"
    // and "declare damage", and a zero-length last block puts its edge exactly
    // at the blob's end — the one input that tells the two apart.
    expect(refusals(parseFlac(flac(block(1, Buffer.alloc(0), true))))).toBe(0);
  });

  it('reads a comment whose length field is the last thing in the block', () => {
    const body = Buffer.concat([vorbisComment('vendor', []), Buffer.alloc(4)]);
    body.writeUInt32LE(1, 4 + 'vendor'.length);
    const [region] = parseFlac(flac(block(4, body, true)));
    expect(region?.text).toBe(['vendor', ''].join('\n'));
  });
});

describe('parseFlac — the declared comment count', () => {
  it('reads exactly as many comments as the block declares', () => {
    const body = vorbisComment('vendor', ['a=1', 'b=2']);
    // The count field sits after the vendor string's length and bytes. Declaring
    // one comment while carrying two is what tells the loop bound from its
    // neighbour: a fixture holding exactly the declared number cannot.
    body.writeUInt32LE(1, 4 + 'vendor'.length);
    const [region] = parseFlac(flac(block(4, body, true)));
    expect(region?.text).toBe(['vendor', 'a=1'].join('\n'));
  });
});

/**
 * The format closes its block-type space: 0 stream info, 1 padding,
 * 2 application, 3 seek table, 4 vorbis comment, 5 cuesheet, 6 picture, 7-126
 * reserved and 127 forbidden. So the enumeration below is exhaustive by the
 * specification rather than by anyone's list, and a type can only be added to it
 * by a new revision of the format.
 *
 * Only stream info is mandatory. The types the specification defines and does
 * not require are named so the remedy may neutralise them; the refusal that
 * remains covers stream info and the reserved range, and that is the half this
 * pin exists to hold.
 */
describe('parseFlac — the disposition of every block type the format defines', () => {
  const disclosure = ['', 'home', 'someone', 'render'].join('/');
  const carried = Buffer.from(disclosure, 'latin1');
  const application = Buffer.concat([Buffer.from('ABCD'), carried]);
  const RESERVED_TYPE = 10;

  it.each([
    { name: 'stream info', type: 0, body: carried, kind: 'flac:unnamed' },
    { name: 'padding', type: 1, body: carried, kind: 'flac:PADDING' },
    { name: 'application', type: 2, body: application, kind: 'flac:APPLICATION' },
    { name: 'seek table', type: 3, body: carried, kind: 'flac:SEEKTABLE' },
    {
      name: 'vorbis comment',
      type: 4,
      body: vorbisComment(disclosure, []),
      kind: 'flac:VORBIS_COMMENT',
    },
    { name: 'cuesheet', type: 5, body: carried, kind: 'flac:CUESHEET' },
    { name: 'picture', type: 6, body: carried, kind: 'flac:PICTURE' },
    { name: 'a reserved type', type: RESERVED_TYPE, body: carried, kind: 'flac:unnamed' },
  ])('reports a $name block as $kind', ({ type, body, kind }) => {
    const [region] = parseFlac(flac(block(type, body, true)));
    expect(region?.kind).toBe(kind);
  });

  it.each([
    { name: 'padding', type: 1 },
    { name: 'seek table', type: 3 },
    { name: 'cuesheet', type: 5 },
    { name: 'picture', type: 6 },
  ])('reports no region for a $name block carrying nothing', ({ type }) => {
    // Naming a type is not the same as calling it a carrier: these blocks exist
    // in ordinary files, and reporting one for existing would make every stream
    // that pads itself out dirty.
    expect(parseFlac(flac(block(type, Buffer.alloc(32), true)))).toEqual([]);
  });
});

/** A frame sync is fourteen set bits, so coded audio opens `FF F8`. */
const audioFrame = Buffer.from([0xff, 0xf8, 0, 0]);

describe('flacAudioStart', () => {
  it('points at the first byte after the last metadata block', () => {
    const metadata = flac(block(1, Buffer.alloc(8), true));
    expect(flacAudioStart(Buffer.concat([metadata, audioFrame]))).toBe(metadata.length);
  });

  it('counts an ID3 prefix as part of what precedes the audio', () => {
    const metadata = id3Prefixed(flac(block(1, Buffer.alloc(8), true)), 16);
    expect(flacAudioStart(Buffer.concat([metadata, audioFrame]))).toBe(metadata.length);
  });

  it('reports the end of the blob when nothing follows the metadata', () => {
    const metadata = flac(block(1, Buffer.alloc(8), true));
    expect(flacAudioStart(metadata)).toBe(metadata.length);
  });

  it('refuses a blob whose block framing is damaged', () => {
    const bytes = Buffer.concat([
      Buffer.from('fLaC', 'latin1'),
      streamInfo(),
      Buffer.from([0x04, 0x00]),
    ]);
    expect(flacAudioStart(bytes)).toBeUndefined();
  });

  it('refuses a blob that is not a FLAC stream', () => {
    expect(flacAudioStart(Buffer.from([0xff, 0xfb, 0, 0]))).toBeUndefined();
  });
});

describe('flacScanRanges', () => {
  it('covers the coded audio from its first byte to the end of the blob', () => {
    const metadata = flac(block(1, Buffer.alloc(8), true));
    const bytes = Buffer.concat([metadata, audioFrame]);
    expect(flacScanRanges(bytes)).toEqual([
      { location: 'audio', start: metadata.length, end: bytes.length },
    ]);
  });

  it('declares no range where the metadata walk found no audio', () => {
    expect(flacScanRanges(Buffer.from([0xff, 0xfb, 0, 0]))).toEqual([]);
  });

  it('declares no range for a stream that carries no audio at all', () => {
    const metadata = flac(block(1, Buffer.alloc(8), true));
    expect(flacScanRanges(metadata)).toEqual([]);
  });
});

/**
 * A metadata block the framing declares but this gate's enumeration does not
 * name was read by nothing — a picture block's description and a padding block
 * are both legal places to leave a host path.
 */
describe('parseFlac — a declared block no rule names is still read', () => {
  const disclosure = ['', 'home', 'someone', 'voice'].join('/');

  it('reads an unregistered metadata block for values', () => {
    const bytes = flac(block(6, Buffer.from(disclosure, 'latin1'), true));
    expect(
      parseFlac(bytes)
        .map((region) => region.text)
        .join('\n')
    ).toContain(disclosure);
  });
});
