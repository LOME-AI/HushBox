/**
 * Where a container keeps the bytes a privacy strip must never alter: the image
 * data, the coded samples, the audio frames.
 *
 * A metadata remedy that silently re-encoded its carrier would be a quality loss
 * disguised as a privacy fix, and nothing else in the pipeline would notice. So
 * the stripper hashes this content before and after, and refuses to write when
 * the two differ. The spans are located here rather than read out of the
 * detector's regions because the detector describes metadata — the complement is
 * a different question, asked of the same bytes.
 */
import { createHash } from 'node:crypto';

import { flacAudioStart } from './binary/flac.js';
import { detectBinaryFormat } from './binary/format-registry.js';
import { id3TagLength } from './binary/id3.js';
import { isoBmffScanRanges } from './binary/isobmff.js';
import { pngChunkExtents } from './binary/png.js';
import type { BinaryFormatId } from './binary/format-registry.js';

export interface ByteSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * The `IDAT` payloads, in file order — a PNG's entire compressed image.
 *
 * The chunk walk is the detector's, imported rather than repeated: two walks of
 * one format would be a sync contract between two views of the same bytes, and
 * if they ever disagreed about a boundary the content proof would protect the
 * wrong ones.
 */
function pngContent(bytes: Uint8Array): ByteSpan[] {
  return pngChunkExtents(bytes)
    .chunks.filter((chunk) => chunk.type === 'IDAT')
    .map((chunk) => ({ start: chunk.dataStart, end: chunk.dataEnd }));
}

/**
 * Everything after the last metadata block: a FLAC stream's coded audio, from
 * the detector's own block walk for the same reason.
 */
function flacContent(bytes: Uint8Array): ByteSpan[] | undefined {
  const start = flacAudioStart(bytes);
  return start === undefined ? undefined : [{ start, end: bytes.length }];
}

/** Everything after any ID3 tag: an MPEG stream's coded frames. */
function mp3Content(bytes: Uint8Array): ByteSpan[] {
  return [{ start: id3TagLength(bytes), end: bytes.length }];
}

/**
 * Every byte of the blob.
 *
 * Matroska's remedy rewrites elements in place at their original lengths, so the
 * strongest available statement is not "the clusters are unchanged" but "nothing
 * outside the rewritten elements moved at all" — and that needs no EBML walk to
 * express, only the excluded spans the caller already holds.
 */
function wholeBlob(bytes: Uint8Array): ByteSpan[] {
  return [{ start: 0, end: bytes.length }];
}

/** The bytes a span list covers. The measure, everywhere, is bytes — never spans. */
export function totalSpanBytes(spans: readonly ByteSpan[]): number {
  return spans.reduce((sum, span) => sum + (span.end - span.start), 0);
}

/**
 * The content spans of a registered container, or `undefined` when this module
 * has no answer for the format — which is a reason to refuse a strip, never a
 * reason to skip the check.
 */
export function contentSpans(bytes: Uint8Array): readonly ByteSpan[] | undefined {
  const format = detectBinaryFormat(bytes);
  if (format === undefined) return undefined;
  const located: Partial<Record<BinaryFormatId, () => ByteSpan[] | undefined>> = {
    png: () => pngContent(bytes),
    isobmff: () =>
      isoBmffScanRanges(bytes).map((range) => ({ start: range.start, end: range.end })),
    matroska: () => wholeBlob(bytes),
    flac: () => flacContent(bytes),
    mp3: () => mp3Content(bytes),
  };
  const spans = located[format.id]?.();
  // Measured in bytes, never in spans. "No content located" and "content located
  // that holds nothing" are the same fact, and a span count cannot tell them
  // apart: a file cut back to its metadata yields one span of zero length, whose
  // hash is the empty digest and compares equal to itself every time. A
  // size-zero box swallowing the coded payload lands here too, and a vacuous
  // pass would let a remedy zero the whole file and call it lossless.
  return spans === undefined || totalSpanBytes(spans) === 0 ? undefined : spans;
}

/** Overlapping or touching spans folded into one, in position order. */
export function mergeSpans(spans: readonly ByteSpan[]): ByteSpan[] {
  const ordered = spans.toSorted((left, right) => left.start - right.start);
  const merged: ByteSpan[] = [];
  for (const span of ordered) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
      continue;
    }
    merged.push(span);
  }
  return merged;
}

/** One span minus the merged holes from `from` onward, and where the walk stopped. */
function punch(span: ByteSpan, holes: readonly ByteSpan[], from: number): [ByteSpan[], number] {
  const pieces: ByteSpan[] = [];
  let cursor = span.start;
  let index = from;
  while (index < holes.length) {
    const hole = holes[index];
    if (hole === undefined || hole.start >= span.end) break;
    if (hole.start > cursor) pieces.push({ start: cursor, end: hole.start });
    cursor = Math.max(cursor, hole.end);
    if (hole.end > span.end) break;
    index += 1;
  }
  if (cursor < span.end) pieces.push({ start: cursor, end: span.end });
  return [pieces, index];
}

/**
 * `spans` minus `excluded`, in position order.
 *
 * A merge walk rather than a scan of the holes per span. Both operands are
 * shaped by the file — the located count is the container's box count and the
 * excluded count is the planned span count — so a nested scan is quadratic in
 * two numbers the file chooses, which is a bound on nothing.
 */
function subtract(spans: readonly ByteSpan[], excluded: readonly ByteSpan[]): ByteSpan[] {
  const holes = mergeSpans(excluded);
  const out: ByteSpan[] = [];
  let index = 0;
  for (const span of spans.toSorted((left, right) => left.start - right.start)) {
    // A hole that outran the previous span is stepped over here rather than
    // re-read, which is what keeps the walk linear in the two counts.
    for (
      let hole = holes[index];
      hole !== undefined && hole.end <= span.start;
      hole = holes[index]
    ) {
      index += 1;
    }
    const [pieces, next] = punch(span, holes, index);
    out.push(...pieces);
    index = next;
  }
  return out;
}

/** The bytes of `spans` that `excluded` covers — the share carved out of a proof. */
export function overlappingBytes(
  spans: readonly ByteSpan[],
  excluded: readonly ByteSpan[]
): number {
  return totalSpanBytes(spans) - totalSpanBytes(subtract(spans, excluded));
}

/**
 * A digest over the container's content bytes with `excluded` removed, or
 * `undefined` when the format has no located content.
 *
 * `excluded` exists for the one remedy that writes inside a content stream: an
 * encoder's build banner rides in the coded payload, so the proof available
 * there is that every coded byte *except* the neutralized span is identical.
 */
export function contentHash(
  bytes: Uint8Array,
  excluded: readonly ByteSpan[] = []
): string | undefined {
  const spans = contentSpans(bytes);
  if (spans === undefined) return undefined;
  const remaining = subtract(spans, excluded);
  // The guard above is re-entered through the exclusion path: whatever the
  // locator found, subtracting what a remedy intends to overwrite can empty it,
  // and the digest of no bytes is a constant that matches itself. No remaining
  // byte means no proof, which is a refusal rather than a pass.
  if (totalSpanBytes(remaining) === 0) return undefined;
  const digest = createHash('sha256');
  for (const span of remaining) {
    digest.update(Buffer.from(bytes.subarray(span.start, span.end)));
  }
  return digest.digest('hex');
}
