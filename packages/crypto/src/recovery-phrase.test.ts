import { describe, it, expect } from 'vitest';
import {
  generateRecoveryPhrase,
  validatePhrase,
  phraseToSeed,
  MNEMONIC_STRENGTH,
} from './recovery-phrase.js';

describe('recovery-phrase', () => {
  describe('generateRecoveryPhrase', () => {
    it('generates a 12-word phrase by default', () => {
      const phrase = generateRecoveryPhrase();
      const words = phrase.split(' ');
      expect(words.length).toBe(12);
    });

    it('generates unique phrases on each call', () => {
      const phrase1 = generateRecoveryPhrase();
      const phrase2 = generateRecoveryPhrase();
      expect(phrase1).not.toBe(phrase2);
    });

    it('generates valid BIP39 phrases', () => {
      const phrase = generateRecoveryPhrase();
      expect(validatePhrase(phrase)).toBe(true);
    });
  });

  describe('validatePhrase', () => {
    it('returns true for valid phrase', () => {
      const phrase = generateRecoveryPhrase();
      expect(validatePhrase(phrase)).toBe(true);
    });

    it('returns false for invalid phrase', () => {
      expect(validatePhrase('invalid mnemonic phrase')).toBe(false);
    });

    it('returns false for wrong word count', () => {
      expect(validatePhrase('abandon abandon abandon')).toBe(false);
    });

    it('returns false for invalid checksum', () => {
      const validPhrase =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
      expect(validatePhrase(validPhrase)).toBe(true);

      const invalidPhrase =
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon above';
      expect(validatePhrase(invalidPhrase)).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(validatePhrase('')).toBe(false);
    });

    it('returns false for non-BIP39 words', () => {
      expect(
        validatePhrase('hello world test invalid words that are not in bip39 wordlist at all here')
      ).toBe(false);
    });
  });

  describe('phraseToSeed', () => {
    it('derives a 64-byte seed from phrase', async () => {
      const phrase = generateRecoveryPhrase();
      const seed = await phraseToSeed(phrase);

      expect(seed).toBeInstanceOf(Uint8Array);
      expect(seed.length).toBe(64);
    });

    it('produces deterministic output for same phrase', async () => {
      const phrase = generateRecoveryPhrase();

      const seed1 = await phraseToSeed(phrase);
      const seed2 = await phraseToSeed(phrase);

      expect(seed1).toEqual(seed2);
    });

    it('produces different output for different phrases', async () => {
      const phrase1 = generateRecoveryPhrase();
      const phrase2 = generateRecoveryPhrase();

      const seed1 = await phraseToSeed(phrase1);
      const seed2 = await phraseToSeed(phrase2);

      expect(seed1).not.toEqual(seed2);
    });
  });

  describe('MNEMONIC_STRENGTH', () => {
    it('exports default strength constant of 128 bits', () => {
      expect(MNEMONIC_STRENGTH).toBe(128);
    });
  });

  it('does not export computePhraseVerifier', async () => {
    const module_ = await import('./recovery-phrase.js');
    expect('computePhraseVerifier' in module_).toBe(false);
  });

  it('does not export verifyPhraseVerifier', async () => {
    const module_ = await import('./recovery-phrase.js');
    expect('verifyPhraseVerifier' in module_).toBe(false);
  });
});
