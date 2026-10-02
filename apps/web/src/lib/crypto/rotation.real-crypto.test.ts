/**
 * `executeWithRotation` over REAL cryptography: the verdict it consults is the
 * one `processKeyChain` records from `@hushbox/crypto`'s own verifier, so a
 * refusal here is a refusal a browser would make. Only the API is faked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPair } from '@hushbox/crypto';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import {
  firstEpoch,
  keyChainOf,
  rotateFrom,
  withForeignPublicKey,
} from '@/test-utils/key-chain-builders';
import {
  clearEpochKeyCache,
  getEpochKey,
  getEpochVerdict,
  processKeyChain,
} from './epoch-key-cache';
import { executeWithRotation, UnverifiedKeyChainError } from './rotation';
import type { KeyPair } from '@hushbox/crypto';
import type { StreamChatRotation } from '@hushbox/shared';
import type { BuiltEpoch } from '@/test-utils/key-chain-builders';
import type { MemberKeyResponse, RotationMember } from './rotation';

const CONVERSATION_ID = 'conv-rotating';

const mockMemberKeysGet = vi.fn(
  (): Promise<{ members: MemberKeyResponse[] }> => Promise.resolve({ members: [] })
);

// The API is the one external seam: the call returns its body directly, and
// `fetchJson` passes it through.
vi.mock('../api-client', () => ({
  client: {
    conversations: {
      ':conversationId': { 'member-keys': { $get: () => mockMemberKeysGet() } },
    },
  },
  fetchJson: (response: Promise<unknown>) => response,
}));

/** A rotation whose own key verifies but whose chain link opens to nothing. */
function withBrokenChainLink(epoch: BuiltEpoch): BuiltEpoch {
  return { ...epoch, chainLink: new Uint8Array(epoch.chainLink!.length).fill(7) };
}

function everySeat(keys: MemberKeyResponse[]): RotationMember[] {
  return keys.map((k) => ({ publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64')) }));
}

describe('executeWithRotation over a verified keychain', () => {
  let owner: KeyPair;

  beforeEach(() => {
    vi.clearAllMocks();
    clearEpochKeyCache();
    owner = generateKeyPair();
    mockMemberKeysGet.mockResolvedValue({
      members: [
        {
          memberId: 'owner',
          userId: 'owner',
          linkId: null,
          publicKey: toBase64(owner.publicKey),
          privilege: 'owner',
          visibleFromEpoch: 1,
        },
      ],
    });
  });

  function rotateOn(
    epoch: BuiltEpoch,
    execute: (rotation: StreamChatRotation) => Promise<unknown>
  ): ReturnType<typeof executeWithRotation> {
    return executeWithRotation({
      conversationId: CONVERSATION_ID,
      currentEpochPrivateKey: epoch.epochPrivateKey,
      currentEpochNumber: epoch.epochNumber,
      plaintextTitle: 'Title',
      filterMembers: everySeat,
      execute,
    });
  }

  it('builds on a current epoch whose key and chain verified', async () => {
    const epoch1 = firstEpoch(CONVERSATION_ID, [owner]);
    const epoch2 = rotateFrom(CONVERSATION_ID, owner, epoch1, 2);
    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, epoch2]), owner.privateKey);
    const execute = vi.fn((_rotation: StreamChatRotation): Promise<unknown> => Promise.resolve({}));

    await rotateOn(epoch2, execute);

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![0].expectedEpoch).toBe(2);
  });

  it('refuses to build on a verified current key whose chain link is bad', async () => {
    const epoch1 = firstEpoch(CONVERSATION_ID, [owner]);
    const epoch2 = withBrokenChainLink(rotateFrom(CONVERSATION_ID, owner, epoch1, 2));
    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, epoch2]), owner.privateKey);
    const execute = vi.fn((_rotation: StreamChatRotation): Promise<unknown> => Promise.resolve({}));

    expect(getEpochKey(CONVERSATION_ID, 2)).toEqual(epoch2.epochPrivateKey);
    expect(getEpochVerdict(CONVERSATION_ID)?.rotation).toBe('bad');
    await expect(rotateOn(epoch2, execute)).rejects.toBeInstanceOf(UnverifiedKeyChainError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses to build on a current epoch whose key is bad', async () => {
    const epoch1 = firstEpoch(CONVERSATION_ID, [owner]);
    const epoch2 = withForeignPublicKey(rotateFrom(CONVERSATION_ID, owner, epoch1, 2));
    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, epoch2]), owner.privateKey);
    const execute = vi.fn((_rotation: StreamChatRotation): Promise<unknown> => Promise.resolve({}));

    await expect(rotateOn(epoch2, execute)).rejects.toBeInstanceOf(UnverifiedKeyChainError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses with the code the caller’s error surface maps to copy', async () => {
    const epoch1 = withForeignPublicKey(firstEpoch(CONVERSATION_ID, [owner]));
    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1]), owner.privateKey);

    await expect(rotateOn(epoch1, () => Promise.resolve({}))).rejects.toThrow(
      ERROR_CODES.EPOCH_KEYS_RESTORING
    );
  });
});
