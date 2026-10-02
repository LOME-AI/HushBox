import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { BINARY_FORMATS, detectBinaryFormat } from './format-registry.js';
import { classifyBinaryBlob, scanBinaryBlob } from './scan.js';
import type { BinaryFormatId } from './format-registry.js';

/**
 * The registry's declared contract has six members; the obligations on a parser
 * have grown to roughly eight, none of them expressible in the type. Satisfying
 * each of them ten times by hand is what produced every parser gap this run
 * found — including one that was invisible to coverage, because the code path
 * executed on undamaged input and every damage fixture sat at depth zero.
 *
 * This is that arrangement replaced by one mechanism. For every registered
 * format: a well-formed specimen, the same specimen truncated, and the same
 * specimen with a residue appended — each of the damaged pair must produce a
 * refusal. A format whose structure cannot express one of those cases declares
 * the exemption here, with its reason, rather than being left out of the table.
 */

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};

const png = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk('tEXt', Buffer.concat([Buffer.from('Software'), Buffer.alloc(1), Buffer.from('Tool')])),
    chunk('IDAT', Buffer.alloc(8)),
    chunk('IEND', Buffer.alloc(0)),
  ]);

const box = (type: string, ...bodies: readonly Buffer[]): Buffer => {
  const body = Buffer.concat([...bodies]);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};

const isoBmff = (): Buffer =>
  Buffer.concat([box('ftyp', Buffer.from('isom0000', 'latin1')), box('mdat', Buffer.alloc(32))]);

const ebmlId = (id: number): Buffer => {
  const bytes: number[] = [];
  let value = id;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from(bytes);
};

const ebmlSize = (length: number): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes[0] = 0x01;
  bytes.writeUIntBE(length, 2, 6);
  return bytes;
};

const ebml = (id: number, payload: Buffer): Buffer =>
  Buffer.concat([ebmlId(id), ebmlSize(payload.length), payload]);

const matroska = (): Buffer =>
  Buffer.concat([
    ebml(0x1a_45_df_a3, Buffer.from('webm', 'latin1')),
    ebml(0x18_53_80_67, ebml(0x15_49_a9_66, ebml(0x4d_80, Buffer.from('SomeMuxer', 'latin1')))),
  ]);

const flacBlock = (type: number, body: Buffer, last = false): Buffer => {
  const header = Buffer.alloc(4);
  header[0] = (last ? 0x80 : 0) | type;
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
};

const flac = (): Buffer =>
  Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    flacBlock(0, Buffer.alloc(34)),
    flacBlock(1, Buffer.alloc(16), true),
    Buffer.from([0xff, 0xf8, 0x00, 0x00]),
  ]);

/** MPEG 1 Layer III, 128 kbit/s at 44.1 kHz: a 417-byte frame, header included. */
const mpegFrame = (): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)]);

const mp3 = (): Buffer => Buffer.concat([mpegFrame(), mpegFrame()]);

const base128 = (value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    bytes.unshift(remaining & 0x7f);
    remaining >>>= 7;
  } while (remaining > 0);
  for (let index = 0; index < bytes.length - 1; index++) bytes[index] = (bytes[index] ?? 0) | 0x80;
  return Buffer.from(bytes);
};

const woff2 = (): Buffer => {
  const stream = brotliCompressSync(Buffer.alloc(54));
  const directory = Buffer.concat([Buffer.from([1]), base128(54)]);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00_01_00_00, 4);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(stream.length, 20);
  const total = header.length + directory.length + stream.length;
  header.writeUInt32BE(total, 8);
  return Buffer.concat([header, directory, stream]);
};

const zip = (): Buffer => {
  const name = Buffer.from('a', 'latin1');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04_03_4b_50, 0);
  local.writeUInt16LE(name.length, 26);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02_01_4b_50, 0);
  record.writeUInt16LE(name.length, 28);
  const entry = Buffer.concat([local, name]);
  const directory = Buffer.concat([record, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(entry.length, 16);
  return Buffer.concat([entry, directory, eocd]);
};

const subBlocks = (payload: string): Buffer => {
  const bytes = Buffer.from(payload, 'latin1');
  return Buffer.concat([Buffer.from([bytes.length]), bytes, Buffer.from([0])]);
};

const gif = (): Buffer =>
  Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.alloc(7),
    Buffer.from([0x21, 0xfe]),
    subBlocks('a comment'),
    Buffer.from([0x3b]),
  ]);

const riffChunk = (id: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, body.length % 2 === 0 ? Buffer.alloc(0) : Buffer.alloc(1)]);
};

const riff = (): Buffer => {
  const body = Buffer.concat([
    Buffer.from('WAVE', 'latin1'),
    riffChunk('fmt ', Buffer.alloc(16)),
    riffChunk('data', Buffer.alloc(16)),
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

const ico = (): Buffer => {
  const image = png();
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, image]);
};

/**
 * A specimen whose *inner* structure is damaged behind intact outer framing.
 *
 * Every other operation in this table damages the outermost structure, so the
 * table could not see a parser that reports damage at depth zero and swallows it
 * deeper — and that gap is real rather than theoretical: one such parser was
 * found by hand, and the table it was supposed to be covered by could not have
 * constructed the case.
 */
type NestedDamage = () => Buffer;

interface FormatContract {
  readonly id: BinaryFormatId;
  readonly name: string;
  readonly specimen: () => Buffer;
  /**
   * Set where the container declares no extent for the span the case damages, so
   * the damaged blob is a legal instance of the same container rather than a
   * damaged one — a bare frame stream declares neither its length nor its end.
   *
   * Declared as a property the format rests on rather than as prose. A prose
   * exemption checked only for its own length says whatever its author wanted it
   * to say; this one is asserted, by requiring the parser to read the damaged
   * specimen exactly as it reads the well-formed one.
   */
  readonly residueIsMoreStream?: true;
  readonly truncationIsLessStream?: true;
  readonly nested?: NestedDamage;
  /**
   * Set where the parser walks no structure inside the structure it walks, so
   * there is no inner framing to damage. Asserted only in that every row
   * declares one of the two.
   */
  readonly walksNothingNested?: true;
  /**
   * Set where the well-formed specimen carries at least one metadata finding, so
   * the damage operations can assert that a refusal is *added* to the findings
   * rather than substituted for them. The rows without it damage specimens that
   * carry nothing, which is why this class had to be found one format at a time.
   */
  readonly specimenCarriesFindings?: true;
}

/** PNG: a compressed text chunk that will not inflate, behind intact chunk framing. */
const pngNested = (): Buffer =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.alloc(13)),
    chunk(
      'zTXt',
      Buffer.concat([Buffer.from('Comment'), Buffer.alloc(2), Buffer.from('not a deflate stream')])
    ),
    chunk('IEND', Buffer.alloc(0)),
  ]);

/** ISO-BMFF: a user-data box whose children will not parse, behind intact top-level boxes. */
const isoBmffNested = (): Buffer =>
  Buffer.concat([
    box('ftyp', Buffer.from('isom0000', 'latin1')),
    box('moov', box('udta', Buffer.alloc(8))),
  ]);

/** Matroska: an Info element whose children will not parse, behind an intact Segment. */
const matroskaNested = (): Buffer =>
  Buffer.concat([
    ebml(0x1a_45_df_a3, Buffer.from('webm', 'latin1')),
    ebml(0x18_53_80_67, ebml(0x15_49_a9_66, Buffer.alloc(1))),
  ]);

/** An ID3v2.4 tag whose extended header overruns the tag body. */
const damagedTag = (): Buffer =>
  Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([4, 0, 0x40]),
    Buffer.from([0, 0, 0, 2]),
    Buffer.alloc(2),
  ]);

/** FLAC and MP3: a damaged tag in front of an intact stream. */
const flacNested = (): Buffer => Buffer.concat([damagedTag(), flac()]);
const mp3Nested = (): Buffer => Buffer.concat([damagedTag(), mp3()]);

/** RIFF: a damaged tag inside an intact chunk. */
const riffNested = (): Buffer => {
  const body = Buffer.concat([
    Buffer.from('WAVE', 'latin1'),
    riffChunk('id3 ', damagedTag()),
    riffChunk('data', Buffer.alloc(16)),
  ]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

/** WOFF2: a table stream that will not decompress, behind an intact header and directory. */
const woff2Nested = (): Buffer => {
  const stream = Buffer.from('not a brotli stream', 'latin1');
  const directory = Buffer.concat([Buffer.from([1]), base128(54)]);
  const header = Buffer.alloc(48);
  header.write('wOF2', 0, 'latin1');
  header.writeUInt32BE(0x00_01_00_00, 4);
  header.writeUInt16BE(1, 12);
  header.writeUInt32BE(stream.length, 20);
  header.writeUInt32BE(header.length + directory.length + stream.length, 8);
  return Buffer.concat([header, directory, stream]);
};

/** ZIP: a central record that overruns the directory, behind an intact end record. */
const zipNested = (): Buffer => {
  const bytes = Buffer.from(zip());
  const eocd = bytes.length - 22;
  const directoryStart = bytes.readUInt32LE(eocd + 16);
  bytes.writeUInt16LE(0xff_ff, directoryStart + 28);
  return bytes;
};

/** ICO: an image extent that will not parse, behind an intact directory. */
const icoNested = (): Buffer => {
  const image = png().subarray(0, -5);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt32LE(image.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, image]);
};

const CONTRACTS: readonly FormatContract[] = [
  { id: 'png', name: 'image.png', specimen: png, nested: pngNested, specimenCarriesFindings: true },
  { id: 'isobmff', name: 'clip.mp4', specimen: isoBmff, nested: isoBmffNested },
  {
    id: 'matroska',
    name: 'clip.webm',
    specimen: matroska,
    nested: matroskaNested,
    specimenCarriesFindings: true,
  },
  { id: 'flac', name: 'audio.flac', specimen: flac, residueIsMoreStream: true, nested: flacNested },
  {
    id: 'mp3',
    name: 'audio.mp3',
    specimen: mp3,
    residueIsMoreStream: true,
    truncationIsLessStream: true,
    nested: mp3Nested,
  },
  { id: 'woff2', name: 'font.woff2', specimen: woff2, nested: woff2Nested },
  { id: 'zip', name: 'archive.zip', specimen: zip, nested: zipNested },
  {
    id: 'gif',
    name: 'image.gif',
    specimen: gif,
    walksNothingNested: true,
    specimenCarriesFindings: true,
  },
  { id: 'riff', name: 'audio.wav', specimen: riff, nested: riffNested },
  { id: 'ico', name: 'icon.ico', specimen: ico, nested: icoNested, specimenCarriesFindings: true },
];

const REFUSAL_RULES = new Set(['unparseable-structure', 'unrecognized-format']);

/**
 * Every prefix of a well-formed specimen, and the verdict the gate reaches on
 * it, recorded at the lengths where that verdict changes.
 *
 * The guards deciding "are there enough bytes left to read this" are the
 * densest bound class in the component, and a specimen truncated by an
 * arbitrary amount lands nowhere near their edges: measured, moving one of them
 * a single byte left every one of them alive, while removing one killed it.
 * Walking every prefix length puts a case on both sides of each edge by
 * construction. Recording only the transitions keeps the record to the edges
 * themselves rather than one row per byte, so a bound that moves moves a row
 * and a bound that appears adds one.
 */
function truncationTransitions(contract: FormatContract): string[] {
  const bytes = contract.specimen();
  const rows: string[] = [];
  let previous = '';
  for (let length = 0; length <= bytes.length; length++) {
    const prefix = bytes.subarray(0, length);
    const format = detectBinaryFormat(prefix)?.id ?? 'none';
    const seen = scanBinaryBlob(contract.name, prefix).map(
      (finding) => `${finding.kind === '' ? '-' : finding.kind}/${finding.rule}`
    );
    const state = `${format} ${[...new Set(seen)].toSorted((a, b) => a.localeCompare(b)).join(' ')}`;
    if (state === previous) continue;
    rows.push(`${String(length)} ${state}`);
    previous = state;
  }
  return rows;
}

/** What the gate reports, without the offsets that a residue or a truncation moves. */
const findingShapes = (name: string, bytes: Uint8Array): string[] =>
  scanBinaryBlob(name, bytes).map((finding) => `${finding.kind}/${finding.rule}/${finding.shape}`);

const refuses = (name: string, bytes: Buffer): boolean =>
  scanBinaryBlob(name, bytes).some((finding) => REFUSAL_RULES.has(finding.rule));

describe('the format registry contract', () => {
  it('covers every registered format', () => {
    expect(CONTRACTS.map((contract) => contract.id).toSorted((a, b) => a.localeCompare(b))).toEqual(
      BINARY_FORMATS.map((format) => format.id).toSorted((a, b) => a.localeCompare(b))
    );
  });

  it.each(CONTRACTS)('recognises the $id specimen as well formed', (contract) => {
    const bytes = contract.specimen();
    expect(detectBinaryFormat(bytes)?.id).toBe(contract.id);
    expect(refuses(contract.name, bytes)).toBe(false);
  });

  it.each(CONTRACTS.filter((contract) => contract.truncationIsLessStream === undefined))(
    'refuses a truncated $id specimen',
    (contract) => {
      const bytes = contract.specimen();
      expect(refuses(contract.name, bytes.subarray(0, -5))).toBe(true);
    }
  );

  it.each(CONTRACTS.filter((contract) => contract.residueIsMoreStream === undefined))(
    'refuses a $id specimen carrying an appended residue',
    (contract) => {
      const bytes = Buffer.concat([contract.specimen(), Buffer.alloc(5, 0x41)]);
      expect(refuses(contract.name, bytes)).toBe(true);
    }
  );

  it.each(CONTRACTS.filter((contract) => contract.residueIsMoreStream === undefined))(
    'refuses a $id specimen padded with NUL bytes rather than absorbing them',
    (contract) => {
      const bytes = Buffer.concat([contract.specimen(), Buffer.alloc(16)]);
      expect(refuses(contract.name, bytes)).toBe(true);
    }
  );

  it.each(CONTRACTS.filter((contract) => contract.residueIsMoreStream !== undefined))(
    'reads a $id specimen with a residue exactly as it reads the specimen',
    (contract) => {
      const bytes = contract.specimen();
      expect(findingShapes(contract.name, Buffer.concat([bytes, Buffer.alloc(5, 0x41)]))).toEqual(
        findingShapes(contract.name, bytes)
      );
    }
  );

  it.each(CONTRACTS.filter((contract) => contract.truncationIsLessStream !== undefined))(
    'reads a truncated $id specimen exactly as it reads the specimen',
    (contract) => {
      const bytes = contract.specimen();
      expect(findingShapes(contract.name, bytes.subarray(0, -5))).toEqual(
        findingShapes(contract.name, bytes)
      );
    }
  );

  it.each(CONTRACTS.filter((contract) => contract.specimenCarriesFindings))(
    'has a $id specimen that carries findings for the damage cases to preserve',
    (contract) => {
      expect(findingShapes(contract.name, contract.specimen())).not.toEqual([]);
    }
  );

  it.each(
    CONTRACTS.filter(
      (contract) => contract.specimenCarriesFindings && contract.residueIsMoreStream === undefined
    )
  )('keeps the findings of a $id specimen when a residue is appended', (contract) => {
    const bytes = contract.specimen();
    const damaged = findingShapes(contract.name, Buffer.concat([bytes, Buffer.alloc(5, 0x41)]));
    for (const shape of findingShapes(contract.name, bytes)) expect(damaged).toContain(shape);
  });

  it.each(CONTRACTS)('declares whether $id has inner framing to damage', (contract) => {
    expect([contract.nested, contract.walksNothingNested].filter(Boolean)).toHaveLength(1);
  });

  it.each(CONTRACTS.filter((contract) => contract.nested !== undefined))(
    'refuses a $id specimen damaged inside intact outer framing',
    (contract) => {
      expect(refuses(contract.name, contract.nested?.() ?? Buffer.alloc(0))).toBe(true);
    }
  );

  it.each(CONTRACTS.filter((contract) => contract.truncationIsLessStream === undefined))(
    'never returns a clean verdict for a damaged $id specimen',
    (contract) => {
      const bytes = contract.specimen();
      expect(classifyBinaryBlob(contract.name, bytes.subarray(0, -5), []).verdict).toBe('dirty');
    }
  );
  it.each(CONTRACTS)(
    'records every length at which truncating $id changes the verdict',
    (contract) => {
      expect(truncationTransitions(contract)).toMatchSnapshot();
    }
  );
});

/**
 * What a finding's extent means, across every region class.
 *
 * `region.ts` states the contract: the offset is the whole unit's and the length
 * is that unit's, header included. Every remedy in the stripper is unit-shaped
 * and reads those fields that way, so a class reporting a *body* extent has a
 * remedy write a padding header over the first bytes of real content and call
 * the file stripped. A contract that holds for nine classes and not the tenth is
 * not a contract, so it is asserted over all of them at once: the byte at a
 * finding's offset must be the first byte of the enclosing unit, which for every
 * container here means the unit's own header rather than its payload.
 */
describe('the extent every region class reports', () => {
  const disclosure = ['', 'home', 'someone', 'unit'].join('/');

  const carried = (): Buffer => Buffer.from(disclosure, 'latin1');

  const syncsafe = (value: number): Buffer => {
    const bytes = Buffer.alloc(4);
    for (let index = 0; index < 4; index++) bytes[3 - index] = (value >> (index * 7)) & 0x7f;
    return bytes;
  };

  /** One ID3v2.3 frame: a ten-byte header then its body. */
  const frame = (id: string, body: Buffer): Buffer => {
    const header = Buffer.alloc(10);
    header.write(id, 0, 'latin1');
    header.writeUInt32BE(body.length, 4);
    return Buffer.concat([header, body]);
  };

  const id3Header = (frames: Buffer): Buffer =>
    Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(frames.length)]);

  const dib = (): Buffer => Buffer.concat([Buffer.from([0x28, 0, 0, 0]), carried()]);

  const iconDirectory = (imageLength: number): Buffer => {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    const entry = Buffer.alloc(16);
    entry.writeUInt32LE(imageLength, 8);
    entry.writeUInt32LE(22, 12);
    return Buffer.concat([header, entry]);
  };

  /** A specimen, and the offset the framing wrote its unnamed unit at. */
  interface Laid {
    readonly bytes: Buffer;
    readonly unit: number;
  }

  const laid = (head: readonly Buffer[], unit: Buffer, tail: readonly Buffer[] = []): Laid => {
    const before = Buffer.concat([...head]);
    return { bytes: Buffer.concat([before, unit, ...tail]), unit: before.length };
  };

  const riffHeader = (bodyLength: number): Buffer => {
    const header = Buffer.alloc(8);
    header.write('RIFF', 0, 'latin1');
    header.writeUInt32LE(bodyLength, 4);
    return header;
  };

  const ebmlHeader = (): Buffer => ebml(0x1a_45_df_a3, Buffer.from('webm', 'latin1'));

  const SEGMENT = 0x18_53_80_67;
  const INFO = 0x15_49_a9_66;
  /** The lossless-audio format reserves 7 through 126 and forbids 127. */
  const FLAC_RESERVED_TYPE = 10;

  const carriers: readonly [BinaryFormatId, string, string, () => Laid][] = [
    [
      'isobmff',
      'clip.mp4',
      'isobmff:unnamed',
      () => laid([box('ftyp', Buffer.from('isom0000', 'latin1'))], box('free', carried())),
    ],
    [
      'png',
      'image.png',
      'png:unnamed',
      () =>
        laid(
          [
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', Buffer.alloc(13)),
          ],
          chunk('prVt', carried()),
          [chunk('IEND', Buffer.alloc(0))]
        ),
    ],
    [
      'png',
      'image.png',
      'png:unnamed-critical',
      () =>
        laid(
          [
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            chunk('IHDR', Buffer.alloc(13)),
          ],
          // The same private chunk with its type cased the other way, which is
          // how the format says a decoder may not skip it.
          chunk('PrVt', carried()),
          [chunk('IEND', Buffer.alloc(0))]
        ),
    ],
    [
      'flac',
      'audio.flac',
      'flac:unnamed',
      () =>
        laid(
          [Buffer.from('fLaC', 'latin1'), flacBlock(0, Buffer.alloc(34))],
          // A block of a type the specification reserves. Every type it defines
          // is named by this gate but the stream description, which cannot stand
          // in here: the walk requires the first block to be that one.
          flacBlock(FLAC_RESERVED_TYPE, carried(), true),
          [Buffer.from([0xff, 0xf8, 0x00, 0x00])]
        ),
    ],
    [
      'riff',
      'take.wav',
      'riff:unnamed',
      () => {
        const junk = riffChunk('JUNK', carried());
        const preamble = Buffer.concat([
          Buffer.from('WAVE', 'latin1'),
          riffChunk('fmt ', Buffer.alloc(16)),
        ]);
        return laid([riffHeader(preamble.length + junk.length), preamble], junk);
      },
    ],
    [
      'gif',
      'loop.gif',
      'gif:unnamed',
      () =>
        laid(
          [Buffer.from('GIF89a', 'latin1'), Buffer.alloc(7)],
          // A graphic-control label, which this gate names no rule for.
          Buffer.concat([Buffer.from([0x21, 0xf9]), subBlocks(disclosure)]),
          [Buffer.from([0x3b])]
        ),
    ],
    [
      'matroska',
      'clip.mkv',
      'matroska:unnamed',
      () => {
        // An Attachments element: a Segment child this gate has no rule for.
        const unit = ebml(0x19_41_a4_69, carried());
        return laid([ebmlHeader(), ebmlId(SEGMENT), ebmlSize(unit.length)], unit);
      },
    ],
    [
      'matroska',
      'clip.mkv',
      'matroska:unnamed',
      () => {
        // A Duration element: an Info child this gate has no rule for.
        const unit = ebml(0x44_89, carried());
        const info = ebml(INFO, unit);
        return laid(
          [
            ebmlHeader(),
            ebmlId(SEGMENT),
            ebmlSize(info.length),
            ebmlId(INFO),
            ebmlSize(unit.length),
          ],
          unit
        );
      },
    ],
    [
      'mp3',
      'bed.mp3',
      'id3:unnamed',
      () =>
        laid([id3Header(frame('TIT2', carried()))], frame('TIT2', carried()), [
          mpegFrame(),
          mpegFrame(),
        ]),
    ],
    ['ico', 'app.ico', 'ico:image', () => laid([iconDirectory(dib().length)], dib())],
  ];

  it.each(carriers)(
    'points a %s %s finding at the head of its unit, not at its body',
    (_id, name, kind, build) => {
      const { bytes, unit } = build();
      const at = Buffer.from(bytes).indexOf(Buffer.from(disclosure, 'latin1'));
      const findings = scanBinaryBlob(name, bytes).filter((finding) => finding.kind === kind);

      expect(findings.length).toBeGreaterThan(0);
      for (const finding of findings) {
        // The unit's own header, never the first byte of its body: the header is
        // what a body extent skips, and a unit-shaped remedy would then write
        // padding framing over real content.
        expect(finding.offset).toBe(unit);
        expect(finding.offset + finding.length).toBeGreaterThanOrEqual(at + disclosure.length);
      }
    }
  );
});
