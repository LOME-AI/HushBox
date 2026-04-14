// URL-safe and standard Base64 encoding/decoding.
// Hand-rolled to stay isomorphic (browser + Workers + Node) without relying on
// btoa/atob (deprecated in Node typings) or Buffer (not in browsers).

// Canonical RFC 4648 base64 alphabet (A-Z, a-z, 0-9, +, /). High Shannon entropy
// flags a false positive for the no-secrets rule; this is a well-known public constant.
// eslint-disable-next-line no-secrets/no-secrets -- RFC 4648 alphabet, not a secret
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_LOOKUP: Readonly<Record<string, number>> = (() => {
  const lookup: Record<string, number> = {};
  for (let index = 0; index < BASE64_ALPHABET.length; index++) {
    lookup[BASE64_ALPHABET.charAt(index)] = index;
  }
  return Object.freeze(lookup);
})();

function lookupChar(input: string, index: number): number {
  const char = input.charAt(index);
  const value = BASE64_LOOKUP[char];
  if (value === undefined) {
    throw new Error(`Invalid base64 character at index ${String(index)}`);
  }
  return value;
}

function encodeStandardBase64(data: Uint8Array): string {
  let result = '';
  for (let index = 0; index < data.length; index += 3) {
    const b1 = data[index] ?? 0;
    const b2 = data[index + 1];
    const b3 = data[index + 2];
    result += BASE64_ALPHABET.charAt(b1 >> 2);
    if (b2 === undefined) {
      result += BASE64_ALPHABET.charAt((b1 & 0x03) << 4) + '==';
      break;
    }
    result += BASE64_ALPHABET.charAt(((b1 & 0x03) << 4) | (b2 >> 4));
    if (b3 === undefined) {
      result += BASE64_ALPHABET.charAt((b2 & 0x0f) << 2) + '=';
      break;
    }
    result +=
      BASE64_ALPHABET.charAt(((b2 & 0x0f) << 2) | (b3 >> 6)) + BASE64_ALPHABET.charAt(b3 & 0x3f);
  }
  return result;
}

function decodeStandardBase64(input: string): Uint8Array {
  const stripped = input.replace(/=+$/, '');
  const length = stripped.length;
  if (length === 0) return new Uint8Array(0);
  const fullGroups = Math.floor(length / 4);
  const remainder = length % 4;
  if (remainder === 1) {
    throw new Error('Invalid base64 string: orphan character');
  }
  const byteLength = fullGroups * 3 + (remainder === 0 ? 0 : remainder - 1);
  const bytes = new Uint8Array(byteLength);
  let byteIndex = 0;
  let charIndex = 0;
  for (let group = 0; group < fullGroups; group++) {
    const c1 = lookupChar(stripped, charIndex);
    const c2 = lookupChar(stripped, charIndex + 1);
    const c3 = lookupChar(stripped, charIndex + 2);
    const c4 = lookupChar(stripped, charIndex + 3);
    bytes[byteIndex] = (c1 << 2) | (c2 >> 4);
    bytes[byteIndex + 1] = ((c2 & 0x0f) << 4) | (c3 >> 2);
    bytes[byteIndex + 2] = ((c3 & 0x03) << 6) | c4;
    byteIndex += 3;
    charIndex += 4;
  }
  if (remainder === 2) {
    const c1 = lookupChar(stripped, charIndex);
    const c2 = lookupChar(stripped, charIndex + 1);
    bytes[byteIndex] = (c1 << 2) | (c2 >> 4);
  } else if (remainder === 3) {
    const c1 = lookupChar(stripped, charIndex);
    const c2 = lookupChar(stripped, charIndex + 1);
    const c3 = lookupChar(stripped, charIndex + 2);
    bytes[byteIndex] = (c1 << 2) | (c2 >> 4);
    bytes[byteIndex + 1] = ((c2 & 0x0f) << 4) | (c3 >> 2);
  }
  return bytes;
}

export function toBase64(data: Uint8Array): string {
  return encodeStandardBase64(data).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64(string_: string): Uint8Array {
  const standard = string_.replaceAll('-', '+').replaceAll('_', '/');
  return decodeStandardBase64(standard);
}

export function toStandardBase64(data: Uint8Array): string {
  return encodeStandardBase64(data);
}

export function fromStandardBase64(string_: string): Uint8Array {
  return decodeStandardBase64(string_);
}
