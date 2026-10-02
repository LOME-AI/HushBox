import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { matchesWoff2, parseWoff2 } from './woff2.js';

const HEADER_BYTES = 48;
const HEAD_TABLE_BYTES = 54;
const SECONDS_1904_TO_1970 = 2_082_844_800;
/** `head` is index 1 of the WOFF2 known-tag table. */
const HEAD_TAG_INDEX = 1;

const headTable = (created: number, modified: number): Buffer => {
  const table = Buffer.alloc(HEAD_TABLE_BYTES);
  table.writeBigInt64BE(BigInt(created), 20);
  table.writeBigInt64BE(BigInt(modified), 28);
  return table;
};

const base128 = (value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0x7f);
    remaining >>>= 7;
  } while (remaining > 0);
  for (let index = 0; index < bytes.length - 1; index++) {
    bytes[index] = (bytes[index] ?? 0) | 0x80;
  }
  return Buffer.from(bytes);
};

interface Woff2Spec {
  readonly tables: readonly { readonly tagIndex: number; readonly body: Buffer }[];
  readonly metadata?: Buffer;
}

const woff2 = (spec: Woff2Spec): Buffer => {
  const directory = Buffer.concat(
    spec.tables.map((table) =>
      Buffer.concat([Buffer.from([table.tagIndex]), base128(table.body.length)])
    )
  );
  const stream = brotliCompressSync(Buffer.concat(spec.tables.map((table) => table.body)));
  const metadata =
    spec.metadata === undefined ? Buffer.alloc(0) : brotliCompressSync(spec.metadata);
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00_01_00_00, 4);
  header.writeUInt16BE(spec.tables.length, 12);
  header.writeUInt32BE(stream.length, 20);
  if (spec.metadata !== undefined) {
    header.writeUInt32BE(HEADER_BYTES + directory.length + stream.length, 28);
    header.writeUInt32BE(metadata.length, 32);
    header.writeUInt32BE(spec.metadata.length, 36);
  }
  const bytes = Buffer.concat([header, directory, stream, metadata]);
  bytes.writeUInt32BE(bytes.length, 8);
  return bytes;
};

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

describe('matchesWoff2', () => {
  it('matches a WOFF2 header wrapping a known sfnt version', () => {
    expect(matchesWoff2(woff2({ tables: [] }))).toBe(true);
  });

  it('does not match a header wrapping an unknown sfnt version', () => {
    const bytes = woff2({ tables: [] });
    bytes.writeUInt32BE(0x00_00_00_00, 4);
    expect(matchesWoff2(bytes)).toBe(false);
  });

  it('does not match the earlier WOFF signature', () => {
    const bytes = woff2({ tables: [] });
    bytes.write('wOFF', 0, 'latin1');
    expect(matchesWoff2(bytes)).toBe(false);
  });

  it('does not match a blob shorter than the header', () => {
    expect(matchesWoff2(Buffer.from('wO', 'latin1'))).toBe(false);
  });
});

describe('parseWoff2', () => {
  it('decodes a non-zero font creation date into a UTC instant', () => {
    const bytes = woff2({
      tables: [{ tagIndex: HEAD_TAG_INDEX, body: headTable(SECONDS_1904_TO_1970 + 90_000, 0) }],
    });
    const [region] = parseWoff2(bytes);
    expect(region?.kind).toBe('woff2:head');
    expect(region?.instants).toEqual([{ field: 'created', secondsUtc: 90_000 }]);
  });

  it('decodes both font dates when each is set', () => {
    const bytes = woff2({
      tables: [
        {
          tagIndex: HEAD_TAG_INDEX,
          body: headTable(SECONDS_1904_TO_1970 + 1, SECONDS_1904_TO_1970 + 2),
        },
      ],
    });
    expect(parseWoff2(bytes)[0]?.instants).toHaveLength(2);
  });

  it('reports nothing when the font dates are zeroed', () => {
    const bytes = woff2({ tables: [{ tagIndex: HEAD_TAG_INDEX, body: headTable(0, 0) }] });
    expect(parseWoff2(bytes)).toEqual([]);
  });

  it('reports nothing for a font carrying no head table', () => {
    const bytes = woff2({ tables: [{ tagIndex: 0, body: Buffer.alloc(32) }] });
    expect(parseWoff2(bytes)).toEqual([]);
  });

  it('reports a font longer than the length its header declares', () => {
    const bytes = Buffer.concat([
      woff2({ tables: [{ tagIndex: HEAD_TAG_INDEX, body: headTable(0, 0) }] }),
      Buffer.alloc(5, 0x41),
    ]);
    expect(refusals(parseWoff2(bytes))).toBe(1);
  });

  it('decodes the extended metadata block', () => {
    const bytes = woff2({
      tables: [{ tagIndex: HEAD_TAG_INDEX, body: headTable(0, 0) }],
      metadata: Buffer.from('<metadata><vendor name="Someone"/></metadata>', 'utf8'),
    });
    const [region] = parseWoff2(bytes);
    expect(region?.kind).toBe('woff2:metadata');
    expect(region?.text).toContain('Someone');
  });

  it('reports nothing when the table stream will not decompress', () => {
    const bytes = woff2({ tables: [{ tagIndex: HEAD_TAG_INDEX, body: headTable(1, 0) }] });
    const damaged = Buffer.from(bytes);
    damaged.fill(0xff, HEADER_BYTES + 3);
    expect(refusals(parseWoff2(damaged))).toBeGreaterThan(0);
  });

  it('reports nothing for a truncated table directory', () => {
    const bytes = woff2({ tables: [{ tagIndex: HEAD_TAG_INDEX, body: headTable(1, 0) }] });
    expect(refusals(parseWoff2(bytes.subarray(0, HEADER_BYTES)))).toBeGreaterThan(0);
  });

  it('reads a four-byte custom table tag', () => {
    const bytes = woff2({ tables: [{ tagIndex: 0x3f, body: Buffer.alloc(16) }] });
    const withTag = Buffer.concat([
      bytes.subarray(0, HEADER_BYTES + 1),
      Buffer.from('TEST', 'latin1'),
      bytes.subarray(HEADER_BYTES + 1),
    ]);
    withTag.writeUInt32BE(withTag.length, 8);
    expect(parseWoff2(withTag)).toEqual([]);
  });

  it('reports nothing when a transformed table entry is truncated', () => {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write('wOF2', 0, 'latin1');
    header.writeUInt32BE(0x00_01_00_00, 4);
    header.writeUInt16BE(1, 12);
    const entry = Buffer.from([(1 << 6) | 10, 0x10]);
    const bytes = Buffer.concat([header, entry]);
    bytes.writeUInt32BE(bytes.length, 8);
    expect(refusals(parseWoff2(bytes))).toBe(1);
  });

  it('reports nothing for a table length whose continuation never ends', () => {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write('wOF2', 0, 'latin1');
    header.writeUInt32BE(0x00_01_00_00, 4);
    header.writeUInt16BE(1, 12);
    const entry = Buffer.from([HEAD_TAG_INDEX, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    const bytes = Buffer.concat([header, entry]);
    bytes.writeUInt32BE(bytes.length, 8);
    expect(refusals(parseWoff2(bytes))).toBe(1);
  });

  it('reports nothing when the head table is shorter than its date fields', () => {
    const bytes = woff2({ tables: [{ tagIndex: HEAD_TAG_INDEX, body: Buffer.alloc(10) }] });
    expect(parseWoff2(bytes)).toEqual([]);
  });

  it('refuses a table stream that will not expand inside the cap', () => {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write('wOF2', 0, 'latin1');
    header.writeUInt32BE(0x00_01_00_00, 4);
    header.writeUInt16BE(1, 12);
    header.writeUInt32BE(8, 20);
    const entry = Buffer.concat([Buffer.from([HEAD_TAG_INDEX]), base128(HEAD_TABLE_BYTES)]);
    const bytes = Buffer.concat([header, entry, Buffer.alloc(8, 0xff)]);
    bytes.writeUInt32BE(bytes.length, 8);
    expect(refusals(parseWoff2(bytes))).toBe(1);
  });

  it('reports an extended metadata block that will not expand inside the cap', () => {
    const header = Buffer.alloc(HEADER_BYTES);
    header.write('wOF2', 0, 'latin1');
    header.writeUInt32BE(0x00_01_00_00, 4);
    header.writeUInt16BE(1, 12);
    header.writeUInt32BE(0, 20);
    header.writeUInt32BE(HEADER_BYTES + 2, 28);
    header.writeUInt32BE(8, 32);
    const entry = Buffer.concat([Buffer.from([HEAD_TAG_INDEX]), base128(HEAD_TABLE_BYTES)]);
    const bytes = Buffer.concat([header, entry, Buffer.alloc(8, 0xff)]);
    bytes.writeUInt32BE(bytes.length, 8);
    const metadata = parseWoff2(bytes).find((region) => region.kind === 'woff2:metadata');
    expect(metadata?.malformed).toBeDefined();
    expect(metadata?.text).toBe('');
  });
});
