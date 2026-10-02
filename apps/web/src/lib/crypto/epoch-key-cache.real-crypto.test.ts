/**
 * The epoch-key cache over REAL cryptography: every keychain here is built by
 * `@hushbox/crypto`'s own encoder and judged by its one verifier, so what the
 * cache stores and reports is what a browser would store and report.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createFirstEpoch, generateKeyPair } from '@hushbox/crypto';
import {
  firstEpoch as firstEpochIn,
  keyChainOf,
  rotateFrom as rotateFromIn,
  withForeignPublicKey,
} from '@/test-utils/key-chain-builders';
import {
  processKeyChain,
  getEpochKey,
  getCurrentEpoch,
  getEpochVerdict,
  clearEpochKeyCache,
  subscribe,
  getSnapshot,
} from './epoch-key-cache';
import type { KeyPair } from '@hushbox/crypto';
import type { BuiltEpoch } from '@/test-utils/key-chain-builders';

const CONVERSATION_ID = 'conv-1';

function firstEpoch(principal: KeyPair): BuiltEpoch {
  return firstEpochIn(CONVERSATION_ID, [principal]);
}

function rotateFrom(principal: KeyPair, predecessor: BuiltEpoch, epochNumber: number): BuiltEpoch {
  return rotateFromIn(CONVERSATION_ID, principal, predecessor, epochNumber);
}

async function flushNotifications(): Promise<void> {
  await Promise.resolve();
}

describe('processKeyChain over real cryptography', () => {
  beforeEach(() => {
    clearEpochKeyCache();
  });

  it('caches an older epoch key reached through a chain link', () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);
    const epoch2 = rotateFrom(principal, epoch1, 2);

    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1, epoch2], { wrapsAt: [2] }),
      principal.privateKey
    );

    expect(getEpochKey(CONVERSATION_ID, 2)).toEqual(epoch2.epochPrivateKey);
    expect(getEpochKey(CONVERSATION_ID, 1)).toEqual(epoch1.epochPrivateKey);
    expect(getCurrentEpoch(CONVERSATION_ID)).toBe(2);
  });

  it('never caches a key whose epoch published a different public key', () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);
    const hostile = withForeignPublicKey(rotateFrom(principal, epoch1, 2));

    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, hostile]), principal.privateKey);

    expect(getEpochKey(CONVERSATION_ID, 2)).toBeUndefined();
    expect(getEpochKey(CONVERSATION_ID, 1)).toEqual(epoch1.epochPrivateKey);
  });

  it('never caches a key whose wrap was built for another conversation', () => {
    const principal = generateKeyPair();
    const foreign = createFirstEpoch([principal.publicKey], 'conv-other', 1);
    const epoch1: BuiltEpoch = {
      epochNumber: 1,
      epochPrivateKey: foreign.epochPrivateKey,
      publishedPublicKey: foreign.epochPublicKey,
      confirmationHash: foreign.confirmationHash,
      wrap: foreign.memberWraps[0]!.wrap,
      previousEpochNumber: null,
      chainLink: null,
    };

    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1]), principal.privateKey);

    expect(getEpochKey(CONVERSATION_ID, 1)).toBeUndefined();
  });

  it('follows a skip link to the epoch it names rather than the one below', () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);
    const hostile = withForeignPublicKey(rotateFrom(principal, epoch1, 2));
    const recovery = rotateFrom(principal, epoch1, 3);

    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1, hostile, recovery], { wrapsAt: [2, 3] }),
      principal.privateKey
    );

    expect(getEpochKey(CONVERSATION_ID, 3)).toEqual(recovery.epochPrivateKey);
    expect(getEpochKey(CONVERSATION_ID, 1)).toEqual(epoch1.epochPrivateKey);
    expect(getEpochKey(CONVERSATION_ID, 2)).toBeUndefined();
  });
});

describe('getEpochVerdict over real cryptography', () => {
  beforeEach(() => {
    clearEpochKeyCache();
  });

  it('is undefined for a conversation whose keychain was never processed', () => {
    expect(getEpochVerdict(CONVERSATION_ID)).toBeUndefined();
  });

  it('reports an honest chain as ok, with the current epoch last good', () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);
    const epoch2 = rotateFrom(principal, epoch1, 2);

    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, epoch2]), principal.privateKey);

    expect(getEpochVerdict(CONVERSATION_ID)).toEqual({
      currentEpoch: 2,
      rotationPending: false,
      rotation: 'ok',
      lastGoodEpoch: 2,
      badEpochs: new Set(),
    });
  });

  it('carries the keychain’s pending flag', () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);

    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1], { rotationPending: true }),
      principal.privateKey
    );

    expect(getEpochVerdict(CONVERSATION_ID)?.rotationPending).toBe(true);
  });

  it('reports a bad current rotation with the epoch to recover from', () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);
    const hostile = withForeignPublicKey(rotateFrom(principal, epoch1, 2));

    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, hostile]), principal.privateKey);

    expect(getEpochVerdict(CONVERSATION_ID)).toEqual({
      currentEpoch: 2,
      rotationPending: false,
      rotation: 'bad',
      lastGoodEpoch: 1,
      badEpochs: new Set([2]),
    });
  });

  it('reports a recovered chain as ok while naming the superseded epoch as bad', () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);
    const hostile = withForeignPublicKey(rotateFrom(principal, epoch1, 2));
    const recovery = rotateFrom(principal, epoch1, 3);

    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, hostile, recovery]), principal.privateKey);

    expect(getEpochVerdict(CONVERSATION_ID)).toEqual({
      currentEpoch: 3,
      rotationPending: false,
      rotation: 'ok',
      lastGoodEpoch: 3,
      badEpochs: new Set([2]),
    });
  });

  it('notifies subscribers when a verdict lands', async () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);
    const before = getSnapshot();
    let notified = 0;
    const unsubscribe = subscribe(() => {
      notified++;
    });

    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1], { rotationPending: true }),
      principal.privateKey
    );
    await flushNotifications();
    unsubscribe();

    expect(notified).toBe(1);
    expect(getSnapshot()).toBeGreaterThan(before);
  });

  it('keeps the newer verdict when a keychain for an older epoch arrives after it', () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);
    const epoch2 = rotateFrom(principal, epoch1, 2);

    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, epoch2]), principal.privateKey);
    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1], { rotationPending: true }),
      principal.privateKey
    );

    expect(getEpochVerdict(CONVERSATION_ID)).toMatchObject({
      currentEpoch: 2,
      rotationPending: false,
    });
  });

  it('replaces the verdict when a keychain for the same epoch arrives', () => {
    const principal = generateKeyPair();
    const epoch1 = firstEpoch(principal);

    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1]), principal.privateKey);
    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1], { rotationPending: true }),
      principal.privateKey
    );

    expect(getEpochVerdict(CONVERSATION_ID)?.rotationPending).toBe(true);
  });

  it('forgets every verdict when the cache is cleared', () => {
    const principal = generateKeyPair();
    processKeyChain(CONVERSATION_ID, keyChainOf([firstEpoch(principal)]), principal.privateKey);

    clearEpochKeyCache();

    expect(getEpochVerdict(CONVERSATION_ID)).toBeUndefined();
  });
});
