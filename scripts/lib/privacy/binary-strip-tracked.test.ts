import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { contentHash } from './binary-content.js';
import { detectBinaryFormat } from './binary/format-registry.js';
import { id3TagLength } from './binary/id3.js';
import { scanBinaryBlob } from './binary/scan.js';
import { stripBinaryBlob } from './binary-strip.js';
import {
  ascii,
  concat,
  ebmlElement,
  flacBlock,
  FLAC_TYPE_VORBIS_COMMENT,
  id3Frame,
  id3Tag,
  isoBox,
  MATROSKA_ID_MUXING_APP,
  pngTextChunk,
  vorbisComment,
} from '../__test-fixtures-binary-strip__/media.js';
import type { BinaryFormatId } from './binary/format-registry.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The PNG chunk chain ends with a fixed-width `IEND`, so an ancillary chunk goes
 * in immediately before it wherever the encoder left off.
 */
const PNG_IEND_BYTES = 12;

/** Signature, then the `STREAMINFO` block: header and its fixed-width body. */
const FLAC_FIRST_BLOCK_END = 4 + 4 + 34;

/**
 * A `Void` element wide enough to hold the element below, addressed by the two
 * bytes that open it: the one-byte id and the one-byte size of its payload. The
 * remedy blanks in place, so a witness that has been through it carries these
 * where its muxer strings used to be, and writing one back is the exact inverse
 * of what was done to it.
 */
function voidMarker(width: number): Uint8Array {
  return Uint8Array.from([0xec, 0x80 | (width - 2)]);
}

function splice(bytes: Uint8Array, at: number, width: number, element: Uint8Array): Uint8Array {
  return concat(bytes.subarray(0, at), element, bytes.subarray(at + width));
}

/**
 * How each witness is put back into the state its encoder left it in.
 *
 * The tracked tree is clean, so a real dirty file is no longer something this
 * repository holds — which is the whole point of the backfill and would quietly
 * make this suite vacuous, since a strip of an already-clean blob satisfies both
 * assertions below without exercising a remedy. So the disclosure is put back,
 * one region per format, into the encoder's own bytes: the container, its box
 * ordering, its padding and its surprises are still the ones nobody wrote these
 * remedies for, and only the region under test is synthetic. Relaxing the
 * assertions instead would keep the file green and stop it proving anything.
 */
const REDIRTY: Partial<Record<BinaryFormatId, (clean: Buffer) => Uint8Array>> = {
  png: (clean) =>
    splice(
      clean,
      clean.length - PNG_IEND_BYTES,
      0,
      pngTextChunk('Software', 'Adobe Photoshop 26.0')
    ),
  // Past every existing box, so no `stco`/`co64` offset in the file moves.
  isobmff: (clean) => concat(clean, isoBox('uuid', ascii('Lavf60.16.100'))),
  matroska: (clean) => {
    const element = ebmlElement(MATROSKA_ID_MUXING_APP, ascii('Lavf60.16.10'));
    const at = clean.indexOf(Buffer.from(voidMarker(element.length)));
    if (at === -1) throw new Error('the witness carries no Void wide enough to write back into');
    return splice(clean, at, element.length, element);
  },
  flac: (clean) =>
    splice(
      clean,
      FLAC_FIRST_BLOCK_END,
      0,
      flacBlock(FLAC_TYPE_VORBIS_COMMENT, vorbisComment('reference libFLAC 1.4.3', []))
    ),
  // The tag this file now carries holds nothing, so it is dropped rather than
  // written into: what follows is the encoder's own frame sequence untouched.
  mp3: (clean) =>
    concat(
      id3Tag([id3Frame('TSSE', ascii('\0Lavf60.16.100'))]),
      clean.subarray(id3TagLength(clean))
    ),
};

/**
 * One real tracked file per format the stripper claims, chosen as the smallest
 * the repository holds so the suite reads a few megabytes rather than hundreds.
 *
 * Constructed fixtures prove the remedies handle the fields they were written
 * for; these prove they handle files nobody wrote them for — an encoder's real
 * output, with its own box ordering, its own padding and its own surprises.
 * Both halves are needed, and this is the half a hand-built specimen cannot give.
 */
const WITNESSES: readonly (readonly [BinaryFormatId, string])[] = [
  ['png', 'apps/web/public/assets/images/rose-hulman-logo.png'],
  ['isobmff', 'ads/2026-07-hq-tour/02-ai-shots/s5-only-room/s5-take1-seedance20.mp4'],
  ['isobmff', 'ads/2026-07-hq-tour/06-music/bed-sonilo-take1.m4a'],
  ['matroska', 'ads/2026-07-hq-tour/03-screen-capture/static-take1.webm'],
  ['flac', 'ads/2026-07-hq-tour/04-voiceover/line5-take1-FINAL.flac'],
  ['mp3', 'ads/2026-07-hq-tour/06-music/bed-lyria3pro-take1.mp3'],
];

describe.each(WITNESSES)('stripping the tracked %s witness', (formatId, file) => {
  // Stripped once for the whole block: a witness runs to a megabyte and the
  // detector's own literal sweep is the expensive half of the work.
  const tracked = readFileSync(path.join(REPO_ROOT, file));
  const redirty = REDIRTY[formatId];
  if (redirty === undefined) throw new Error(`no re-dirty for ${formatId}`);
  const bytes = redirty(tracked);
  const result = stripBinaryBlob(file, bytes);

  it('dispatches to the parser the witness was chosen for', () => {
    expect(detectBinaryFormat(tracked)?.id).toBe(formatId);
    expect(detectBinaryFormat(bytes)?.id).toBe(formatId);
  });

  it('has a disclosure to clear in the first place', () => {
    // Without this the two assertions below are trivially true of an untouched
    // blob, which is exactly the state the backfill left the tracked file in.
    expect(scanBinaryBlob(file, bytes).length).toBeGreaterThan(0);
  });

  it('clears every finding the detector reports', () => {
    // `stripped`, never merely "not dirty": admitting the clean status is what
    // would let a witness that stopped carrying anything keep passing.
    expect(result.status).toBe('stripped');
    expect(scanBinaryBlob(file, result.bytes)).toEqual([]);
  });

  it('leaves the content stream byte-identical', () => {
    const excluded = result.contentExclusions;
    expect(contentHash(bytes, excluded)).toBeDefined();
    expect(contentHash(bytes, excluded)).toBe(contentHash(result.bytes, excluded));
  });
});
