import { id3TagLength, parseId3 } from './id3.js';
import { RegionCollector } from './region.js';
import type { MetadataRegion, ScanRange } from './region.js';

const FRAME_HEADER_BYTES = 4;
const RESERVED_VERSION = 0x08;
const RESERVED_LAYER = 0x00;

/** Version bits, as stored. */
const MPEG_2_5 = 0x00;
const MPEG_1 = 0x18;
/** Layer bits, as stored: 3 = Layer I, 2 = Layer II, 1 = Layer III. */
const LAYER_I = 0x06;
const LAYER_II = 0x04;

/**
 * Sample rates by version, index 3 reserved and therefore zero.
 *
 * The version check admits three MPEG generations, so the tables must cover
 * three: reading MPEG-1 rates for every version left ordinary 22.05 kHz speech
 * recordings unclaimed, which is fail-closed but costs the file's real metadata
 * findings and leaves a stripper nothing to act on.
 */
const SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
  [MPEG_1]: [44_100, 48_000, 32_000, 0],
  0x10: [22_050, 24_000, 16_000, 0],
  [MPEG_2_5]: [11_025, 12_000, 8000, 0],
};

/** Bitrates in kbit/s by index; zero marks the free-form and invalid entries. */
const BITRATES_V1_L1: readonly number[] = [
  0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0,
];
const BITRATES_V1_L2: readonly number[] = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0,
];
const BITRATES_V1_L3: readonly number[] = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];
const BITRATES_V2_L1: readonly number[] = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0,
];
/** MPEG 2 and 2.5 share one table across Layers II and III. */
const BITRATES_V2_L23: readonly number[] = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0,
];

function bitrateTable(versionBits: number, layerBits: number): readonly number[] {
  if (versionBits === MPEG_1) {
    if (layerBits === LAYER_I) return BITRATES_V1_L1;
    return layerBits === LAYER_II ? BITRATES_V1_L2 : BITRATES_V1_L3;
  }
  return layerBits === LAYER_I ? BITRATES_V2_L1 : BITRATES_V2_L23;
}

/** Layer I frames are measured in four-byte slots; the rest in bytes. */
function samplesPerFrame(versionBits: number, layerBits: number): number {
  if (layerBits === LAYER_I) return 384;
  if (layerBits === LAYER_II) return 1152;
  return versionBits === MPEG_1 ? 1152 : 576;
}

interface FrameHeader {
  readonly lengthBytes: number;
}

interface FrameFields {
  readonly versionBits: number;
  readonly layerBits: number;
  readonly bitrate: number;
  readonly sampleRate: number;
  readonly padding: number;
}

/**
 * The header's declared fields, or `undefined` when any of them is reserved.
 *
 * The bitrate and sample-rate tables carry zero at every index the format
 * reserves — free-form, invalid, and the reserved rate — so one lookup is the
 * whole check rather than a check plus a lookup that can never disagree.
 */
/** The eleven sync bits, plus the version and layer fields being non-reserved. */
function isFrameSync(first: number, second: number): boolean {
  return (
    first === 0xff &&
    (second & 0xe0) === 0xe0 &&
    (second & 0x18) !== RESERVED_VERSION &&
    (second & 0x06) !== RESERVED_LAYER
  );
}

function readFrameFields(view: Buffer, offset: number): FrameFields | undefined {
  const first = view.readUInt8(offset);
  const second = view.readUInt8(offset + 1);
  const third = view.readUInt8(offset + 2);
  const versionBits = second & 0x18;
  const layerBits = second & 0x06;
  if (!isFrameSync(first, second)) return undefined;
  /* v8 ignore start -- every table is sized to the full range of its index field, and the version check leaves only keys the rate table holds, so both fallbacks are unreachable */
  const bitrate = bitrateTable(versionBits, layerBits)[(third & 0xf0) >> 4] ?? 0;
  const sampleRate = SAMPLE_RATES[versionBits]?.[(third & 0x0c) >> 2] ?? 0;
  /* v8 ignore stop */
  if (bitrate === 0 || sampleRate === 0) return undefined;
  return {
    versionBits,
    layerBits,
    bitrate,
    sampleRate,
    padding: (third & 0x02) === 0 ? 0 : 1,
  };
}

/**
 * A validated MPEG frame header, or `undefined`.
 *
 * The sync word alone is not evidence: `FF FE` is a valid sync *and* is the
 * UTF-16LE byte-order mark, so testing two bytes claimed every UTF-16 text file
 * as audio. A claim of format suppresses the text gate, which defers to this
 * registry — so a weak claim is not a false positive, it is a file nothing
 * looks at.
 */
function readFrameHeader(view: Buffer, offset: number): FrameHeader | undefined {
  if (offset + FRAME_HEADER_BYTES > view.length) return undefined;
  const fields = readFrameFields(view, offset);
  if (fields === undefined) return undefined;
  const samples = samplesPerFrame(fields.versionBits, fields.layerBits);
  // Layer I is measured in four-byte slots, so its divisor is 32 bits per slot
  // rather than 8 bits per byte; the padding unit follows the same measure.
  const isLayerI = fields.layerBits === LAYER_I;
  const units = Math.floor(
    ((samples / (isLayerI ? 32 : 8)) * fields.bitrate * 1000) / fields.sampleRate
  );
  const lengthBytes = isLayerI ? (units + fields.padding) * 4 : units + fields.padding;
  /* v8 ignore next -- the smallest frame any valid field combination declares is longer than its own header */
  return lengthBytes > FRAME_HEADER_BYTES ? { lengthBytes } : undefined;
}

/**
 * MPEG audio, with or without an ID3v2 prefix.
 *
 * Two consecutive frames are required, always. One frame is not evidence: a
 * byte-order mark parses as a valid header, and a text file whose length happens
 * to match the frame length that header declares would otherwise be claimed as
 * audio — which is how a UTF-16 document came to be examined by neither gate.
 * No real recording is a single frame, and a blob that is one is reported as an
 * unrecognized container rather than passed to an audio parser.
 */
export function matchesMp3(bytes: Uint8Array): boolean {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = id3TagLength(bytes);
  const header = readFrameHeader(view, offset);
  if (header === undefined) return false;
  return readFrameHeader(view, offset + header.lengthBytes) !== undefined;
}

/**
 * MP3 carries its author-supplied metadata in the ID3 tag and nowhere else.
 *
 * Through the collector, as the two sibling formats that read the same tag do:
 * the budget is per blob, and a tag of tens of thousands of frames is otherwise
 * a blob with no ceiling on what it can make the gate hold.
 */
export function parseMp3(bytes: Uint8Array): MetadataRegion[] {
  const collector = new RegionCollector();
  collector.pushAll(parseId3(bytes));
  return collector.collect(bytes.length);
}

/**
 * The coded frames, which the tag walk never reaches.
 *
 * They are not opaque to the encoder that wrote them: LAME drains its version
 * string into each frame's unused ancillary bits, so an untagged recording can
 * carry dozens of copies of an encoder identity that survives every metadata
 * remedy. Measured on this repository's own recordings — thirty-four and twelve
 * occurrences in two files, against zero for ten control strings of the same
 * length in the same bytes, which is what separates a written banner from a
 * coincidence of compressed data.
 */
export function mp3ScanRanges(bytes: Uint8Array): ScanRange[] {
  const start = id3TagLength(bytes);
  if (start >= bytes.length) return [];
  return [{ location: 'frames', start, end: bytes.length }];
}
