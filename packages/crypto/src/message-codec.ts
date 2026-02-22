import { compressIfSmaller, decompress } from './compression.js';

const FLAG_UNCOMPRESSED = 0x00;
const FLAG_COMPRESSED = 0x01;

export function encodeForEncryption(plaintext: string): Uint8Array {
  const messageBytes = new TextEncoder().encode(plaintext);
  const { result, compressed } = compressIfSmaller(messageBytes);
  const flag = compressed ? FLAG_COMPRESSED : FLAG_UNCOMPRESSED;

  const payload = new Uint8Array(1 + result.length);
  payload[0] = flag;
  payload.set(result, 1);
  return payload;
}

export function decodeFromDecryption(payload: Uint8Array): string {
  const flag = payload[0];
  let data = payload.subarray(1);

  if (flag === FLAG_COMPRESSED) {
    data = decompress(data);
  }

  return new TextDecoder().decode(data);
}
