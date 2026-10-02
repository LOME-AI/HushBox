/**
 * The single description of every binary container this repo tracks: how to
 * recognize one from its leading bytes, how to walk its metadata, and which
 * extensions it legitimately wears.
 *
 * Detector and stripper both read this registry. A second parser written on the
 * stripper's side would be a sync contract between two views of the same bytes,
 * which is exactly the drift this arrangement exists to prevent.
 */
import { flacScanRanges, matchesFlac, parseFlac } from './flac.js';
import { matchesGif, parseGif } from './gif.js';
import { matchesIco, parseIco } from './ico.js';
import { isoBmffScanRanges, matchesIsoBmff, parseIsoBmff } from './isobmff.js';
import { matchesMatroska, parseMatroska } from './matroska.js';
import { matchesMp3, mp3ScanRanges, parseMp3 } from './mp3.js';
import { matchesPng, parsePng } from './png.js';
import { matchesRiff, parseRiff } from './riff.js';
import { matchesWoff2, parseWoff2 } from './woff2.js';
import { matchesZip, parseZip } from './zip.js';
import type { MetadataRegion, ScanRange } from './region.js';

export type { ScanRange } from './region.js';

export type BinaryFormatId =
  | 'png'
  | 'isobmff'
  | 'matroska'
  | 'flac'
  | 'mp3'
  | 'woff2'
  | 'zip'
  | 'gif'
  | 'riff'
  | 'ico';

export interface BinaryFormat {
  readonly id: BinaryFormatId;
  readonly label: string;
  /** Extensions this container legitimately wears, lower-case and dotted. */
  readonly extensions: readonly string[];
  readonly matches: (bytes: Uint8Array) => boolean;
  readonly parse: (bytes: Uint8Array) => MetadataRegion[];
  /** Opaque payload ranges worth a bounded literal scan, where the format has any. */
  readonly scanRanges?: (bytes: Uint8Array) => ScanRange[];
}

/**
 * Order is load-bearing at one point only: an ID3v2 prefix hides the real
 * container, so FLAC is offered the blob before MP3.
 */
export const BINARY_FORMATS: readonly BinaryFormat[] = [
  {
    id: 'png',
    label: 'PNG image',
    extensions: ['.png'],
    matches: matchesPng,
    parse: parsePng,
  },
  {
    id: 'isobmff',
    label: 'ISO base-media file',
    extensions: ['.mp4', '.m4a', '.m4v', '.mov'],
    matches: matchesIsoBmff,
    parse: parseIsoBmff,
    scanRanges: isoBmffScanRanges,
  },
  {
    id: 'matroska',
    label: 'Matroska container',
    extensions: ['.webm', '.mkv', '.mka'],
    matches: matchesMatroska,
    parse: parseMatroska,
  },
  {
    id: 'flac',
    label: 'FLAC stream',
    extensions: ['.flac'],
    matches: matchesFlac,
    parse: parseFlac,
    scanRanges: flacScanRanges,
  },
  {
    id: 'mp3',
    label: 'MPEG audio',
    extensions: ['.mp3'],
    matches: matchesMp3,
    parse: parseMp3,
    scanRanges: mp3ScanRanges,
  },
  {
    id: 'woff2',
    label: 'WOFF2 font',
    extensions: ['.woff2'],
    matches: matchesWoff2,
    parse: parseWoff2,
  },
  {
    id: 'zip',
    label: 'ZIP archive',
    extensions: ['.zip', '.jar', '.whl', '.apk', '.aab', '.epub'],
    matches: matchesZip,
    parse: parseZip,
  },
  {
    id: 'gif',
    label: 'GIF image',
    extensions: ['.gif'],
    matches: matchesGif,
    parse: parseGif,
  },
  {
    id: 'riff',
    label: 'RIFF container',
    extensions: ['.wav', '.webp', '.avi'],
    matches: matchesRiff,
    parse: parseRiff,
  },
  {
    id: 'ico',
    label: 'Icon directory',
    extensions: ['.ico'],
    matches: matchesIco,
    parse: parseIco,
  },
];

/** The registered format whose magic bytes the blob carries, if any. */
export function detectBinaryFormat(bytes: Uint8Array): BinaryFormat | undefined {
  return BINARY_FORMATS.find((format) => format.matches(bytes));
}
