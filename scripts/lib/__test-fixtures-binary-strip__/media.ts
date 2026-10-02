/**
 * Container fixtures assembled byte by byte.
 *
 * The binary gate refuses to commit binary fixtures, and the stripper is held to
 * the same bar: every specimen here is built from field values a test names, so
 * a reader can see exactly which byte a remedy is supposed to move.
 */
import { crc32 } from 'node:zlib';

const encoder = new TextEncoder();

export function ascii(value: string): Uint8Array {
  return encoder.encode(value);
}

/** Latin-1 so a byte value above 0x7f survives as one byte (the `©` atom prefix). */
export function latin1(value: string): Uint8Array {
  return Uint8Array.from([...value].map((character) => character.codePointAt(0) ?? 0));
}

export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

export function u16be(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

export function u32le(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

export function u64be(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, value);
  return out;
}

export function filled(length: number, byte: number): Uint8Array {
  return new Uint8Array(length).fill(byte);
}

// ---------------------------------------------------------------- PNG

export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A real CRC, so a fixture stays a decodable PNG after a chunk is dropped. */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat(ascii(type), data);
  return concat(u32be(data.length), typed, u32be(crc32(Buffer.from(typed))));
}

export const PNG_IHDR = pngChunk(
  'IHDR',
  concat(u32be(1), u32be(1), Uint8Array.from([8, 0, 0, 0, 0]))
);

export interface PngOptions {
  /** Ancillary chunks placed between the header and the image data. */
  readonly ancillary?: readonly Uint8Array[];
  readonly imageData?: Uint8Array;
  readonly trailing?: Uint8Array;
}

export function png(options: PngOptions = {}): Uint8Array {
  return concat(
    PNG_SIGNATURE,
    PNG_IHDR,
    ...(options.ancillary ?? []),
    pngChunk('IDAT', options.imageData ?? filled(64, 0x5a)),
    pngChunk('IEND', new Uint8Array(0)),
    options.trailing ?? new Uint8Array(0)
  );
}

/** A `tEXt` chunk in its `keyword\0value` form. */
export function pngTextChunk(keyword: string, value: string): Uint8Array {
  return pngChunk('tEXt', concat(ascii(keyword), Uint8Array.from([0]), ascii(value)));
}

/** A `tIME` chunk: a big-endian year, then five single-byte UTC fields. */
export function pngTimeChunk(instantMs: number): Uint8Array {
  const at = new Date(instantMs);
  return pngChunk(
    'tIME',
    Uint8Array.from([
      at.getUTCFullYear() >> 8,
      at.getUTCFullYear() & 0xff,
      at.getUTCMonth() + 1,
      at.getUTCDate(),
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
    ])
  );
}

// ------------------------------------------------------------ ISO-BMFF

export function isoBox(type: string, body: Uint8Array): Uint8Array {
  return concat(u32be(body.length + 8), latin1(type), body);
}

/** A box declaring size zero, which the format reads as "to the end of the file". */
export function isoZeroSizedBox(type: string, body: Uint8Array): Uint8Array {
  return concat(u32be(0), latin1(type), body);
}

/** A box declaring the 64-bit size form, which puts the extent behind the type. */
export function isoLargeBox(type: string, body: Uint8Array): Uint8Array {
  return concat(u32be(1), latin1(type), u64be(BigInt(body.length + 16)), body);
}

export const ISO_FTYP = isoBox('ftyp', concat(ascii('isom'), u32be(512), ascii('isomavc1')));

/** A `meta` box carries a version/flags word before its children. */
export function isoMetaBox(body: Uint8Array): Uint8Array {
  return isoBox('meta', concat(u32be(0), body));
}

export function isoHeaderBox(type: string, creation: number, modification: number): Uint8Array {
  return isoBox(type, concat(u32be(0), u32be(creation), u32be(modification), filled(12, 0x11)));
}

/** The version-1 form, whose time fields are 64 bits wide rather than 32. */
export function isoWideHeaderBox(type: string, creation: bigint, modification: bigint): Uint8Array {
  return isoBox(
    type,
    concat(u32be(0x01_00_00_00), u64be(creation), u64be(modification), filled(12, 0x11))
  );
}

/**
 * A visual sample entry: the fixed field block the format specifies, the
 * compressor name a muxer writes its own banner into, and the codec
 * configuration child a decoder cannot start a stream without.
 *
 * The field widths are the specification's, so a fixture whose compressor name
 * moves is a fixture that stopped being a sample entry.
 */
export function isoVisualSampleEntry(compressorName: string, config: Uint8Array): Uint8Array {
  const name = latin1(compressorName);
  const field = new Uint8Array(32);
  field[0] = name.length;
  field.set(name, 1);
  return isoBox(
    'avc1',
    concat(
      filled(6, 0x00),
      u16be(1),
      filled(16, 0x00),
      u16be(320),
      u16be(240),
      u32be(0x0048_0000),
      u32be(0x0048_0000),
      u32be(0),
      u16be(1),
      field,
      u16be(24),
      Uint8Array.from([0xff, 0xff]),
      isoBox('avcC', config)
    )
  );
}

/**
 * A track's media handler, at the bottom of the box chain a container reads it
 * through. The format makes the box mandatory and gives its trailing name field
 * to free text, which is where a muxer writes its own banner.
 */
export function isoTrackHandler(name: string): Uint8Array {
  const handler = isoBox(
    'hdlr',
    concat(u32be(0), u32be(0), ascii('vide'), filled(12, 0x00), ascii(name), filled(1, 0x00))
  );
  return isoBox('moov', isoBox('trak', isoBox('mdia', handler)));
}

/** The box chain a sample entry has to sit at the bottom of to be read as one. */
export function isoSampleDescription(entry: Uint8Array): Uint8Array {
  const stsd = isoBox('stsd', concat(u32be(0), u32be(1), entry));
  return isoBox('moov', isoBox('trak', isoBox('mdia', isoBox('minf', isoBox('stbl', stsd)))));
}

// -------------------------------------------------------------- GIF

export function gif(extensions: readonly Uint8Array[]): Uint8Array {
  return concat(
    ascii('GIF89a'),
    Uint8Array.from([1, 0, 1, 0, 0, 0, 0]),
    ...extensions,
    Uint8Array.from([0x3b])
  );
}

/** A comment extension: introducer, label, then a chain of length-led sub-blocks. */
export function gifComment(text: string): Uint8Array {
  const body = ascii(text);
  return concat(Uint8Array.from([0x21, 0xfe, body.length]), body, Uint8Array.from([0]));
}

/** ISO-BMFF counts seconds from 1904, so a 1970-based instant is offset here. */
export const ISO_EPOCH_OFFSET_SECONDS = 2_082_844_800;

export interface SeiOptions {
  /** Bytes rather than text where a specimen needs a non-printable byte inside. */
  readonly banner: string | Uint8Array;
  /** Coded bytes placed after the SEI unit, which a strip must not touch. */
  readonly coded?: Uint8Array;
}

/**
 * A length-prefixed H.264 SEI unit carrying an unregistered user-data payload —
 * the framing an encoder writes its build banner into.
 */
export function seiUnit(options: SeiOptions): Uint8Array {
  const banner = typeof options.banner === 'string' ? ascii(options.banner) : options.banner;
  const payloadSize = 16 + banner.length;
  const sizeBytes: number[] = [];
  for (let left = payloadSize; left >= 255; left -= 255) sizeBytes.push(0xff);
  sizeBytes.push(payloadSize % 255);
  const nal = concat(
    Uint8Array.from([0x06, 0x05]),
    Uint8Array.from(sizeBytes),
    filled(16, 0x2b),
    banner,
    Uint8Array.from([0x80])
  );
  return concat(u32be(nal.length), nal, options.coded ?? filled(32, 0x37));
}

// ------------------------------------------------------------ Matroska

export const MATROSKA_ID_SEGMENT = Uint8Array.from([0x18, 0x53, 0x80, 0x67]);
export const MATROSKA_ID_INFO = Uint8Array.from([0x15, 0x49, 0xa9, 0x66]);
export const MATROSKA_ID_TAGS = Uint8Array.from([0x12, 0x54, 0xc3, 0x67]);
export const MATROSKA_ID_CLUSTER = Uint8Array.from([0x1f, 0x43, 0xb6, 0x75]);
export const MATROSKA_ID_EBML = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]);
export const MATROSKA_ID_MUXING_APP = Uint8Array.from([0x4d, 0x80]);
export const MATROSKA_ID_WRITING_APP = Uint8Array.from([0x57, 0x41]);
export const MATROSKA_ID_DATE_UTC = Uint8Array.from([0x44, 0x61]);
const MATROSKA_ID_TRACKS = Uint8Array.from([0x16, 0x54, 0xae, 0x6b]);
const MATROSKA_ID_TRACK_ENTRY = Uint8Array.from([0xae]);
const MATROSKA_ID_CODEC_ID = Uint8Array.from([0x86]);
const MATROSKA_ID_CODEC_PRIVATE = Uint8Array.from([0x63, 0xa2]);

/** Sizes below 127 fit the one-byte form, which every fixture here stays under. */
export function ebmlElement(id: Uint8Array, body: Uint8Array): Uint8Array {
  if (body.length < 0x7f) return concat(id, Uint8Array.from([0x80 | body.length]), body);
  return concat(id, Uint8Array.from([0x40 | (body.length >> 8), body.length & 0xff]), body);
}

/**
 * The segment's track list: one entry naming its codec and carrying the codec
 * configuration a decoder reads before it can decode a single frame.
 *
 * The element ids are the format's, so a fixture whose codec configuration moves
 * is a fixture that stopped being a track list.
 */
export function matroskaTracks(codecId: string, codecPrivate: Uint8Array): Uint8Array {
  return ebmlElement(
    MATROSKA_ID_TRACKS,
    ebmlElement(
      MATROSKA_ID_TRACK_ENTRY,
      concat(
        ebmlElement(MATROSKA_ID_CODEC_ID, ascii(codecId)),
        ebmlElement(MATROSKA_ID_CODEC_PRIVATE, codecPrivate)
      )
    )
  );
}

/** Matroska counts its segment date in nanoseconds from 2001-01-01. */
export const MATROSKA_EPOCH_OFFSET_SECONDS = 978_307_200;

export function matroskaDateNanos(secondsUtc: number): bigint {
  return BigInt(secondsUtc - MATROSKA_EPOCH_OFFSET_SECONDS) * 1_000_000_000n;
}

// ---------------------------------------------------------------- FLAC

export const FLAC_SIGNATURE = ascii('fLaC');
export const FLAC_TYPE_STREAMINFO = 0;
export const FLAC_TYPE_PADDING = 1;
export const FLAC_TYPE_APPLICATION = 2;
export const FLAC_TYPE_SEEKTABLE = 3;
export const FLAC_TYPE_VORBIS_COMMENT = 4;
export const FLAC_TYPE_CUESHEET = 5;
export const FLAC_TYPE_PICTURE = 6;

export function flacBlock(type: number, body: Uint8Array, last = false): Uint8Array {
  const header = Uint8Array.from([
    (last ? 0x80 : 0) | type,
    (body.length >> 16) & 0xff,
    (body.length >> 8) & 0xff,
    body.length & 0xff,
  ]);
  return concat(header, body);
}

/** The block widths are the format's; the signature closes the block. */
const FLAC_STREAMINFO_BYTES = 34;
const FLAC_SIGNATURE_OFFSET = 18;
const FLAC_SIGNATURE_BYTES = 16;
const FLAC_BLOCK_SAMPLES = 4096;
const FLAC_FRAME_BYTES = 1024;
const FLAC_SAMPLE_RATE = 44_100;
const FLAC_CHANNELS = 2;
const FLAC_SAMPLE_DEPTH = 16;
const FLAC_TOTAL_SAMPLES = 44_100;

function u24be(value: number): Uint8Array {
  return Uint8Array.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

/**
 * The stream-description block, in the shape the format mandates: the first
 * metadata block of every FLAC stream, and the one a decoder reads before it can
 * read anything else.
 *
 * The signature — the digest of the unencoded audio — is the block's only field
 * holding bytes the format does not constrain, so it is the only place inside
 * this block a disclosure can sit.
 */
export function flacStreamInfo(signature: Uint8Array): Uint8Array {
  const body = new Uint8Array(FLAC_STREAMINFO_BYTES);
  const view = new DataView(body.buffer);
  view.setUint16(0, FLAC_BLOCK_SAMPLES);
  view.setUint16(2, FLAC_BLOCK_SAMPLES);
  body.set(u24be(FLAC_FRAME_BYTES), 4);
  body.set(u24be(FLAC_FRAME_BYTES), 7);
  // Twenty bits of sample rate, three of channel count, five of sample depth and
  // thirty-six of sample total, packed into one 64-bit word.
  view.setBigUint64(
    10,
    (BigInt(FLAC_SAMPLE_RATE) << 44n) |
      (BigInt(FLAC_CHANNELS - 1) << 41n) |
      (BigInt(FLAC_SAMPLE_DEPTH - 1) << 36n) |
      BigInt(FLAC_TOTAL_SAMPLES)
  );
  body.set(signature.subarray(0, FLAC_SIGNATURE_BYTES), FLAC_SIGNATURE_OFFSET);
  return body;
}

export function vorbisComment(vendor: string, comments: readonly string[]): Uint8Array {
  const vendorBytes = ascii(vendor);
  return concat(
    u32le(vendorBytes.length),
    vendorBytes,
    u32le(comments.length),
    ...comments.map((comment) => concat(u32le(ascii(comment).length), ascii(comment)))
  );
}

/** Fourteen set bits open a FLAC frame; the parser checks for them. */
export function flacAudio(length = 64): Uint8Array {
  return concat(Uint8Array.from([0xff, 0xf8]), filled(length, 0x4d));
}

// ----------------------------------------------------------------- ID3

export function syncsafe(value: number): Uint8Array {
  return Uint8Array.from([
    (value >> 21) & 0x7f,
    (value >> 14) & 0x7f,
    (value >> 7) & 0x7f,
    value & 0x7f,
  ]);
}

/** An ID3v2.3 frame: four-character id, plain 32-bit size, two flag bytes. */
export function id3Frame(id: string, body: Uint8Array): Uint8Array {
  return concat(ascii(id), u32be(body.length), Uint8Array.from([0, 0]), body);
}

export function id3Tag(frames: readonly Uint8Array[], padding = 0): Uint8Array {
  const body = concat(...frames, filled(padding, 0));
  return concat(ascii('ID3'), Uint8Array.from([3, 0, 0]), syncsafe(body.length), body);
}

/** The footer form: the same header repeated at the tag's end, flagged in the header. */
export function id3TagWithFooter(frames: readonly Uint8Array[]): Uint8Array {
  const body = concat(...frames);
  const size = syncsafe(body.length);
  return concat(
    ascii('ID3'),
    Uint8Array.from([4, 0, 0x10]),
    size,
    body,
    ascii('3DI'),
    Uint8Array.from([4, 0, 0x10]),
    size
  );
}

// ----------------------------------------------------------------- MP3

/**
 * One MPEG-1 Layer III frame at 128 kbit/s and 44.1 kHz, whose declared length
 * the matcher recomputes from these very fields.
 */
export const MP3_FRAME_BYTES = 417;

export function mp3Frame(): Uint8Array {
  return concat(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]), filled(MP3_FRAME_BYTES - 4, 0x69));
}

export function mp3Audio(frames = 2): Uint8Array {
  return concat(...Array.from({ length: frames }, () => mp3Frame()));
}
