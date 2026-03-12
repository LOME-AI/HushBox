import * as bip39 from '@scure/bip39';
// eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- wordlist is string[] but TS can't resolve types through .js subpath export
import { wordlist } from '@scure/bip39/wordlists/english.js';

export const MNEMONIC_STRENGTH = 128; // 12 words

export function generateRecoveryPhrase(): string {
  return bip39.generateMnemonic(wordlist, MNEMONIC_STRENGTH);
}

export function validatePhrase(phrase: string): boolean {
  return bip39.validateMnemonic(phrase, wordlist);
}

export async function phraseToSeed(phrase: string): Promise<Uint8Array> {
  return bip39.mnemonicToSeed(phrase);
}
