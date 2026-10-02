import { deflateSync } from 'fflate';
import { boundedInflate } from './bounded-inflate.js';
import { MalformedBlobError } from '../errors.js';

/**
 * Absolute output cap for decompressing one text-message payload. A hostile
 * conversation member can ship a deflate bomb that decrypts legitimately, so
 * inflation must abort mid-stream — on every member's client — the moment
 * output exceeds this bound. No per-message plaintext limit exists elsewhere
 * to derive from; 4 MiB is roughly an order of magnitude above the largest
 * plausible legitimate text message (a ~128K-token model output is ~0.5 MB
 * of UTF-8) while the per-flow media cap (20 MiB) is sized for media blobs,
 * not text.
 */
export const MAX_DECOMPRESSED_MESSAGE_BYTES = 4 * 1024 * 1024;

export function compress(data: Uint8Array): Uint8Array {
  return deflateSync(data);
}

export function decompress(data: Uint8Array): Uint8Array {
  return boundedInflate(data, MAX_DECOMPRESSED_MESSAGE_BYTES);
}

export function compressIfSmaller(data: Uint8Array): { result: Uint8Array; compressed: boolean } {
  const compressed = compress(data);
  if (compressed.length < data.length) {
    return { result: compressed, compressed: true };
  }
  return { result: data, compressed: false };
}

const CODEC_RAW = 0x00;
const CODEC_DEFLATE = 0x01;

/**
 * Writer policy for the codec byte, never a format difference: `auto` deflates
 * whenever deflate is strictly smaller, `raw` never deflates. Large-binary
 * writers (media) take `raw` because deflating already-compressed bytes only to
 * discard the result is wasted CPU — the payload framing is identical either way.
 */
export type CompressionPolicy = 'auto' | 'raw';

/**
 * `auto` stops at the inflate cap: past it a deflated payload would decrypt
 * fine and then abort on every reader, so the write must stay inside what the
 * read side accepts. Over-cap content stores raw and reads back.
 */
function shouldDeflate(data: Uint8Array, policy: CompressionPolicy): boolean {
  return policy === 'auto' && data.length <= MAX_DECOMPRESSED_MESSAGE_BYTES;
}

/**
 * Frames bytes as `[codec flag][data]` — the plaintext an envelope encrypts, so
 * the flag is covered by the AEAD tag rather than stored beside the blob where a
 * reader would have to be handed a second copy that must agree.
 */
export function encodeCodecPayload(data: Uint8Array, policy: CompressionPolicy): Uint8Array {
  const { result, compressed } = shouldDeflate(data, policy)
    ? compressIfSmaller(data)
    : { result: data, compressed: false };
  const payload = new Uint8Array(1 + result.length);
  payload[0] = compressed ? CODEC_DEFLATE : CODEC_RAW;
  payload.set(result, 1);
  return payload;
}

/** Unframes a codec payload. An unrecognized flag fails fast, never falls through to raw. */
export function decodeCodecPayload(payload: Uint8Array): Uint8Array {
  const flag = payload.at(0);
  if (flag === CODEC_RAW) {
    return payload.subarray(1);
  }
  if (flag === CODEC_DEFLATE) {
    return decompress(payload.subarray(1));
  }
  if (flag === undefined) {
    throw new MalformedBlobError('Empty codec payload: missing codec flag byte');
  }
  throw new MalformedBlobError(`Unknown codec flag: ${String(flag)}`);
}
