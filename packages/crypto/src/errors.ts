import { bytesToHex } from '@noble/hashes/utils.js';

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

export class InvalidKeyError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidKeyError';
  }
}

export class InvalidParameterError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParameterError';
  }
}

export class MalformedBlobError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedBlobError';
  }
}

export class UnknownBlobVersionError extends CryptoError {
  readonly version: number;

  constructor(version: number) {
    super(`Unknown blob format version: ${String(version)}`);
    this.name = 'UnknownBlobVersionError';
    this.version = version;
  }
}

/**
 * The key fingerprint at the head of an at-rest blob names a key this build
 * does not hold. Distinct from `UnknownBlobVersionError`: a blob carries both a
 * key fingerprint and a format version, and a single class would send a reader
 * to the wrong bytes. The fingerprint is non-secret by construction, so the
 * message may carry it.
 */
export class UnknownKeyVersionError extends CryptoError {
  readonly fingerprint: Uint8Array;

  constructor(fingerprint: Uint8Array) {
    super(`Unknown key fingerprint: ${bytesToHex(fingerprint)}`);
    this.name = 'UnknownKeyVersionError';
    this.fingerprint = fingerprint;
  }
}

export class DecryptionFailedError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionFailedError';
  }
}

export class DecompressionCapError extends CryptoError {
  readonly capBytes: number;
  readonly bytesInflated: number;

  constructor(capBytes: number, bytesInflated: number) {
    super(
      `Decompression aborted: output exceeded cap of ${String(capBytes)} bytes ` +
        `(${String(bytesInflated)} bytes inflated at abort)`
    );
    this.name = 'DecompressionCapError';
    this.capBytes = capBytes;
    this.bytesInflated = bytesInflated;
  }
}

export class DecompressionInvalidError extends CryptoError {
  constructor(message: string) {
    super(message);
    this.name = 'DecompressionInvalidError';
  }
}
