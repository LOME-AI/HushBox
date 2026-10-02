import { describe, expect, it } from 'vitest';

import { MATROSKA_SIGNATURE, matchesMatroska, parseMatroska } from './matroska.js';

const idBytes = (id: number): Buffer => {
  const bytes: number[] = [];
  let value = id;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from(bytes);
};

/** Eight-byte size vint: marker bit in the first byte, seven payload bytes. */
const sizeBytes = (length: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes[0] = 0x01;
  bytes.writeUIntBE(length, 2, 6);
  return bytes;
};

const element = (id: number, payload: Buffer): Buffer =>
  Buffer.concat([idBytes(id), sizeBytes(payload.length), payload]);

const ID_EBML = 0x1a_45_df_a3;
const ID_SEGMENT = 0x18_53_80_67;
const ID_INFO = 0x15_49_a9_66;
const ID_TAGS = 0x12_54_c3_67;
const ID_CLUSTER = 0x1f_43_b6_75;
const ID_DATE_UTC = 0x44_61;
const ID_MUXING_APP = 0x4d_80;
const ID_WRITING_APP = 0x57_41;

const header = (): Buffer => element(ID_EBML, Buffer.from('webm', 'latin1'));

const file = (...segmentChildren: readonly Buffer[]): Buffer =>
  Buffer.concat([header(), element(ID_SEGMENT, Buffer.concat([...segmentChildren]))]);

const NANOS_PER_SECOND = 1_000_000_000;
const SECONDS_2001_TO_1970 = 978_307_200;

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

describe('matchesMatroska', () => {
  it('matches the EBML signature', () => {
    expect(matchesMatroska(header())).toBe(true);
  });

  it('does not match a blob too short to hold the signature', () => {
    expect(matchesMatroska(Buffer.from(MATROSKA_SIGNATURE.subarray(0, 2)))).toBe(false);
  });

  it('does not match another container', () => {
    expect(matchesMatroska(Buffer.from('fLaC', 'latin1'))).toBe(false);
  });
});

describe('parseMatroska', () => {
  it('reports no region for a segment carrying only clusters', () => {
    expect(parseMatroska(file(element(ID_CLUSTER, Buffer.alloc(64))))).toEqual([]);
  });

  it('reports the muxing application as an identity carrier', () => {
    const bytes = file(
      element(ID_INFO, element(ID_MUXING_APP, Buffer.from('SomeMuxer 1.2', 'latin1')))
    );
    const [region] = parseMatroska(bytes);
    expect(region?.kind).toBe('matroska:MuxingApp');
    expect(region?.carriesIdentity).toBe(true);
    expect(region?.text).toBe('SomeMuxer 1.2');
  });

  it('reports the writing application', () => {
    const bytes = file(
      element(ID_INFO, element(ID_WRITING_APP, Buffer.from('SomeWriter', 'latin1')))
    );
    expect(parseMatroska(bytes)[0]?.kind).toBe('matroska:WritingApp');
  });

  it('names the structural path of an info child', () => {
    const bytes = file(element(ID_INFO, element(ID_MUXING_APP, Buffer.from('m', 'latin1'))));
    expect(parseMatroska(bytes)[0]?.location).toBe('Segment/Info/MuxingApp');
  });

  it('decodes the segment date into a UTC instant', () => {
    const payload = Buffer.alloc(8);
    payload.writeBigInt64BE(90_000n * BigInt(NANOS_PER_SECOND));
    const bytes = file(element(ID_INFO, element(ID_DATE_UTC, payload)));
    const [region] = parseMatroska(bytes);
    expect(region?.kind).toBe('matroska:DateUTC');
    expect(region?.instants[0]?.secondsUtc).toBe(SECONDS_2001_TO_1970 + 90_000);
  });

  it('ignores a segment date that is not eight bytes wide', () => {
    const bytes = file(element(ID_INFO, element(ID_DATE_UTC, Buffer.alloc(4))));
    expect(parseMatroska(bytes)).toEqual([]);
  });

  it('reports the tags element as one opaque region', () => {
    const bytes = file(
      element(ID_TAGS, Buffer.concat([Buffer.alloc(4), Buffer.from('ENCODER', 'latin1')]))
    );
    const [region] = parseMatroska(bytes);
    expect(region?.kind).toBe('matroska:Tags');
    expect(region?.text).toContain('ENCODER');
  });

  it('reports nothing for a tags element carrying no printable payload', () => {
    expect(parseMatroska(file(element(ID_TAGS, Buffer.alloc(8))))).toEqual([]);
  });

  it('reads a one-byte size vint', () => {
    const payload = Buffer.from('SomeMuxer', 'latin1');
    const short = Buffer.concat([
      idBytes(ID_MUXING_APP),
      Buffer.from([0x80 | payload.length]),
      payload,
    ]);
    const bytes = file(element(ID_INFO, short));
    expect(parseMatroska(bytes)[0]?.text).toBe('SomeMuxer');
  });

  it('stops at an element whose declared size overruns the buffer', () => {
    const bytes = Buffer.concat([header(), idBytes(ID_SEGMENT), sizeBytes(9999)]);
    expect(refusals(parseMatroska(bytes))).toBe(1);
  });

  it('stops at an unreadable identifier', () => {
    const bytes = Buffer.concat([header(), Buffer.from([0x00, 0x00])]);
    expect(refusals(parseMatroska(bytes))).toBe(1);
  });

  it('treats an unknown-size segment as running to the end of the file', () => {
    const child = element(ID_INFO, element(ID_MUXING_APP, Buffer.from('m', 'latin1')));
    const bytes = Buffer.concat([header(), idBytes(ID_SEGMENT), Buffer.from([0xff]), child]);
    expect(parseMatroska(bytes)[0]?.kind).toBe('matroska:MuxingApp');
  });

  it('stops where an identifier runs past the end of the buffer', () => {
    const bytes = Buffer.concat([header(), Buffer.from([0x10, 0x00])]);
    expect(refusals(parseMatroska(bytes))).toBe(1);
  });

  it('stops where a size vint is missing entirely', () => {
    const bytes = Buffer.concat([header(), idBytes(ID_SEGMENT)]);
    expect(refusals(parseMatroska(bytes))).toBe(1);
  });

  it('reports a residue appended past the declared elements', () => {
    const bytes = Buffer.concat([
      file(element(ID_INFO, element(ID_MUXING_APP, Buffer.from('SomeMuxer', 'latin1')))),
      Buffer.from([0x00]),
    ]);
    expect(refusals(parseMatroska(bytes))).toBe(1);
  });

  it('reports damage inside a segment, not only at the top level', () => {
    const bytes = Buffer.concat([header(), element(ID_SEGMENT, Buffer.from([0x00, 0x00, 0x00]))]);
    expect(refusals(parseMatroska(bytes))).toBe(1);
  });

  it('reports damage inside an info element, not only at its parent', () => {
    const overrun = Buffer.concat([idBytes(ID_MUXING_APP), sizeBytes(9999)]);
    const bytes = file(element(ID_INFO, overrun));
    expect(refusals(parseMatroska(bytes))).toBe(1);
  });

  it('reports damage inside a streaming segment, whose size absorbs to end of file', () => {
    const overrun = Buffer.concat([idBytes(ID_MUXING_APP), sizeBytes(9999)]);
    const bytes = Buffer.concat([
      header(),
      idBytes(ID_SEGMENT),
      Buffer.from([0xff]),
      element(ID_INFO, overrun),
    ]);
    expect(refusals(parseMatroska(bytes))).toBe(1);
  });
});

/**
 * A segment child the framing declares but this gate's enumeration does not name
 * was read by nothing. Clusters stay out: they are the coded frames, stepped
 * over by size, which is what keeps a walk of a large capture to a few reads.
 */
describe('parseMatroska — a declared element no rule names is still read', () => {
  const disclosure = ['', 'home', 'someone', 'capture'].join('/');
  const ID_ATTACHMENTS = 0x19_41_a4_69;

  it('reads an unregistered segment child for values', () => {
    const bytes = Buffer.concat([
      header(),
      element(ID_SEGMENT, element(ID_ATTACHMENTS, Buffer.from(disclosure, 'latin1'))),
    ]);
    expect(
      parseMatroska(bytes)
        .map((region) => region.text)
        .join('\n')
    ).toContain(disclosure);
  });

  it('leaves the coded clusters alone', () => {
    const bytes = Buffer.concat([
      header(),
      element(ID_SEGMENT, element(ID_CLUSTER, Buffer.from(disclosure, 'latin1'))),
    ]);
    expect(parseMatroska(bytes)).toEqual([]);
  });
});
