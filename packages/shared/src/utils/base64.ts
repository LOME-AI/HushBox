// URL-safe Base64 encoding/decoding

export function toBase64(data: Uint8Array): string {
  const binary = String.fromCodePoint(...data);
  const base64 = btoa(binary);
  // Convert to URL-safe base64
  return base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64(string_: string): Uint8Array {
  // Convert from URL-safe base64
  let base64 = string_.replaceAll('-', '+').replaceAll('_', '/');
  // Add padding if needed
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
}

// Standard Base64 encoding/decoding (with +/= characters, no URL-safe replacement)
// Used for protocols that require standard base64 (e.g., Helcim webhook HMAC signatures)

export function toStandardBase64(data: Uint8Array): string {
  const binary = String.fromCodePoint(...data);
  return btoa(binary);
}

export function fromStandardBase64(string_: string): Uint8Array {
  const binary = atob(string_);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
}
