import { describe, it, expect } from 'vitest';
import { Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import { messageChain } from '../cli/run-main.js';
import { ESCROW_RECIPIENTS, createEscrowEncrypter } from './recipients.js';

/** A throwaway identity and its recipient, minted per test and never stored. */
async function testKeyPair(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

describe('ESCROW_RECIPIENTS', () => {
  it('holds the two recipients whose identities are held apart', () => {
    expect(ESCROW_RECIPIENTS).toHaveLength(2);
    expect(new Set(ESCROW_RECIPIENTS).size).toBe(2);
  });

  it('holds public recipients alone', () => {
    for (const recipient of ESCROW_RECIPIENTS) {
      expect(recipient.startsWith('age1')).toBe(true);
      expect(recipient).not.toContain('SECRET');
    }
  });

  it('holds recipients the encrypter accepts', () => {
    expect(() => createEscrowEncrypter(ESCROW_RECIPIENTS)).not.toThrow();
  });
});

describe('createEscrowEncrypter', () => {
  it('encrypts to every recipient, so either identity alone opens the file', async () => {
    const first = await testKeyPair();
    const second = await testKeyPair();
    const encrypter = createEscrowEncrypter([first.recipient, second.recipient]);

    const file = await encrypter.encrypt('the escrowed document');

    for (const { identity } of [first, second]) {
      const decrypter = new Decrypter();
      decrypter.addIdentity(identity);
      expect(await decrypter.decrypt(file, 'text')).toBe('the escrowed document');
    }
  });

  it('refuses a malformed recipient', () => {
    expect(() => createEscrowEncrypter([...ESCROW_RECIPIENTS, 'not-a-recipient'])).toThrow(
      /recipient 3 of 3/
    );
  });

  it('names the position of a malformed recipient and never its value', () => {
    const malformed = 'age1qqqqqqqqqq';
    let thrown: unknown;
    try {
      createEscrowEncrypter([malformed]);
    } catch (error: unknown) {
      thrown = error;
    }

    // `messageChain` is the function `runMain` prints with, not a copy of it, so
    // this measures every message that reaches stderr.
    const printed = messageChain(thrown);
    expect(printed).toContain('recipient 1 of 1');
    expect(printed).not.toContain(malformed);
  });

  it('refuses an empty recipient list', () => {
    expect(() => createEscrowEncrypter([])).toThrow(/no recipients/);
  });
});
