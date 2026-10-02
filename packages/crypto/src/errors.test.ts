import { describe, it, expect } from 'vitest';
import {
  CryptoError,
  InvalidKeyError,
  InvalidParameterError,
  MalformedBlobError,
  UnknownBlobVersionError,
  UnknownKeyVersionError,
  DecryptionFailedError,
  DecompressionCapError,
  DecompressionInvalidError,
} from './errors.js';

describe('errors', () => {
  it('CryptoError extends Error with its own name', () => {
    const error = new CryptoError('boom');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('CryptoError');
    expect(error.message).toBe('boom');
  });

  it('InvalidKeyError extends CryptoError', () => {
    const error = new InvalidKeyError('bad key');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('InvalidKeyError');
  });

  it('InvalidParameterError extends CryptoError', () => {
    const error = new InvalidParameterError('bad parameter');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('InvalidParameterError');
  });

  it('MalformedBlobError extends CryptoError', () => {
    const error = new MalformedBlobError('too short');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('MalformedBlobError');
  });

  it('UnknownBlobVersionError carries the rejected version', () => {
    const error = new UnknownBlobVersionError(0x07);

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('UnknownBlobVersionError');
    expect(error.version).toBe(0x07);
    expect(error.message).toContain('7');
  });

  it('UnknownKeyVersionError carries the rejected key fingerprint and names that namespace', () => {
    const fingerprint = Uint8Array.of(0x07, 0x1f, 0xa0, 0x00, 0xff, 0x10, 0x2b, 0x3c);
    const error = new UnknownKeyVersionError(fingerprint);

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('UnknownKeyVersionError');
    expect(error.fingerprint).toBe(fingerprint);
    expect(error.message).toBe('Unknown key fingerprint: 071fa000ff102b3c');
  });

  it('DecryptionFailedError extends CryptoError', () => {
    const error = new DecryptionFailedError('nope');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('DecryptionFailedError');
  });

  it('DecompressionCapError carries cap and observed byte counts', () => {
    const error = new DecompressionCapError(1024, 2048);

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('DecompressionCapError');
    expect(error.capBytes).toBe(1024);
    expect(error.bytesInflated).toBe(2048);
    expect(error.message).toContain('1024');
  });

  it('DecompressionInvalidError extends CryptoError', () => {
    const error = new DecompressionInvalidError('corrupt stream');

    expect(error).toBeInstanceOf(CryptoError);
    expect(error.name).toBe('DecompressionInvalidError');
  });
});
