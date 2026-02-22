import { deflateSync, inflateSync } from 'fflate';

export function compress(data: Uint8Array): Uint8Array {
  return deflateSync(data);
}

export function decompress(data: Uint8Array): Uint8Array {
  return inflateSync(data);
}

export function compressIfSmaller(data: Uint8Array): { result: Uint8Array; compressed: boolean } {
  const compressed = compress(data);
  if (compressed.length < data.length) {
    return { result: compressed, compressed: true };
  }
  return { result: data, compressed: false };
}
