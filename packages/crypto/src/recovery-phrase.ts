import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

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
