import { describe, it, expect, vi, beforeEach } from 'vitest';

type EpochRotationInput = Parameters<typeof performEpochRotation>[0];
type EpochRotationResult = ReturnType<typeof performEpochRotation>;

const mockPerformEpochRotation = vi.fn<typeof performEpochRotation>();
const mockEncryptMessageForStorage = vi.fn<typeof encryptTextForEpoch>();
const derivedPublicKey = (privateKey: Uint8Array): Uint8Array => privateKey.map((b) => b ^ 0xff);

vi.mock('@hushbox/crypto', () => ({
  performEpochRotation: (input: EpochRotationInput): EpochRotationResult =>
    mockPerformEpochRotation(input),
  encryptTextForEpoch: (...args: Parameters<typeof encryptTextForEpoch>): Uint8Array =>
    mockEncryptMessageForStorage(...args),
  getPublicKeyFromPrivate: (privateKey: Uint8Array) => derivedPublicKey(privateKey),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    toBase64: vi.fn((bytes: Uint8Array) => Buffer.from(bytes).toString('base64')),
    fromBase64: vi.fn((s: string) => new Uint8Array(Buffer.from(s, 'base64'))),
  };
});

const mockFetchJson = vi.fn();
vi.mock('../api-client', () => ({
  client: {
    conversations: {
      ':conversationId': {
        'member-keys': {
          $get: vi.fn(() => 'member-keys-promise'),
        },
      },
    },
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

const mockSetEpochKey = vi.fn();
const mockSetCurrentEpoch = vi.fn();
const mockGetEpochKey = vi.fn();
const mockGetCurrentEpoch = vi.fn<(conversationId: string) => number | undefined>();
const mockGetEpochVerdict = vi.fn<(conversationId: string) => EpochVerdict | undefined>();
vi.mock('./epoch-key-cache', () => ({
  setEpochKey: (...args: unknown[]) => mockSetEpochKey(...args),
  setCurrentEpoch: (...args: unknown[]) => mockSetCurrentEpoch(...args),
  getEpochKey: (...args: unknown[]) => mockGetEpochKey(...args),
  getCurrentEpoch: (conversationId: string) => mockGetCurrentEpoch(conversationId),
  getEpochVerdict: (conversationId: string) => mockGetEpochVerdict(conversationId),
}));

import { ApiError } from '../api/api';
import {
  buildRotation,
  executeRecoveryRotation,
  executeWithRotation,
  UnverifiedKeyChainError,
} from './rotation';
import type { encryptTextForEpoch, performEpochRotation } from '@hushbox/crypto';
import type { EpochVerdict } from './epoch-key-cache';

function verdict(rotation: EpochVerdict['rotation'], currentEpoch = 3): EpochVerdict {
  return {
    currentEpoch,
    rotationPending: false,
    rotation,
    lastGoodEpoch: rotation === 'ok' ? currentEpoch : 1,
    badEpochs: new Set(),
  };
}

describe('buildRotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when the predecessor key is all zeros', () => {
    expect(() =>
      buildRotation({
        conversationId: 'conv-1',
        currentEpochNumber: 3,
        predecessor: { epochNumber: 3, privateKey: new Uint8Array(32).fill(0) },
        members: [{ publicKey: new Uint8Array(32).fill(2) }],
        plaintextTitle: 'Test Title',
      })
    ).toThrow('Cannot rotate: epoch key unavailable');
  });

  it('chains the new epoch to the predecessor it is given, after the current epoch', () => {
    const privateKey = new Uint8Array(32).fill(1);
    const pubKey1 = new Uint8Array(32).fill(2);
    const pubKey2 = new Uint8Array(32).fill(3);
    const rotationResult = {
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [
        { memberPublicKey: pubKey1, wrap: new Uint8Array(48).fill(20) },
        { memberPublicKey: pubKey2, wrap: new Uint8Array(48).fill(21) },
      ],
      chainLink: new Uint8Array(64).fill(13),
    };
    mockPerformEpochRotation.mockReturnValue(rotationResult);
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(64).fill(99));

    buildRotation({
      conversationId: 'conv-1',
      currentEpochNumber: 3,
      predecessor: { epochNumber: 3, privateKey },
      members: [{ publicKey: pubKey1 }, { publicKey: pubKey2 }],
      plaintextTitle: 'Test Title',
    });

    expect(mockPerformEpochRotation).toHaveBeenCalledWith({
      predecessor: { epochNumber: 3, privateKey, publicKey: derivedPublicKey(privateKey) },
      memberPublicKeys: [pubKey1, pubKey2],
      conversationId: 'conv-1',
      epochNumber: 4,
    });
  });

  it('chains a recovery to an earlier predecessor while expecting the current epoch', () => {
    const predecessorKey = new Uint8Array(32).fill(5);
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const result = buildRotation({
      conversationId: 'conv-1',
      currentEpochNumber: 5,
      predecessor: { epochNumber: 2, privateKey: predecessorKey },
      members: [],
      plaintextTitle: 'Title',
    });

    expect(mockPerformEpochRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        predecessor: {
          epochNumber: 2,
          privateKey: predecessorKey,
          publicKey: derivedPublicKey(predecessorKey),
        },
        epochNumber: 6,
      })
    );
    expect(result.params.expectedEpoch).toBe(5);
    expect(result.newEpochNumber).toBe(6);
  });

  it('encrypts the title with the new epoch public key', () => {
    const rotationResult = {
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    };
    mockPerformEpochRotation.mockReturnValue(rotationResult);
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    buildRotation({
      conversationId: 'conv-1',
      currentEpochNumber: 1,
      predecessor: { epochNumber: 1, privateKey: new Uint8Array(32).fill(1) },
      members: [],
      plaintextTitle: 'My Chat',
    });

    expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(
      rotationResult.epochPublicKey,
      'My Chat',
      expect.anything()
    );
  });

  it('binds the title to the new epoch number, not the one being rotated away from', () => {
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    buildRotation({
      conversationId: 'conv-1',
      currentEpochNumber: 4,
      predecessor: { epochNumber: 4, privateKey: new Uint8Array(32).fill(1) },
      members: [],
      plaintextTitle: 'My Chat',
    });

    expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(expect.anything(), 'My Chat', {
      conversationId: 'conv-1',
      epochNumber: 5,
    });
  });

  it('returns StreamChatRotation params with base64-encoded fields and correct metadata', () => {
    const pubKey1 = new Uint8Array(32).fill(2);
    const rotationResult = {
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [{ memberPublicKey: pubKey1, wrap: new Uint8Array(48).fill(20) }],
      chainLink: new Uint8Array(64).fill(13),
    };
    mockPerformEpochRotation.mockReturnValue(rotationResult);
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const result = buildRotation({
      conversationId: 'conv-1',
      currentEpochNumber: 5,
      predecessor: { epochNumber: 5, privateKey: new Uint8Array(32).fill(1) },
      members: [{ publicKey: pubKey1 }],
      plaintextTitle: 'Title',
    });

    expect(result.params.expectedEpoch).toBe(5);
    expect(typeof result.params.epochPublicKey).toBe('string');
    expect(typeof result.params.confirmationHash).toBe('string');
    expect(typeof result.params.chainLink).toBe('string');
    expect(typeof result.params.encryptedTitle).toBe('string');
    expect(result.params.memberWraps).toHaveLength(1);
    expect(typeof result.params.memberWraps[0]!.memberPublicKey).toBe('string');
    expect(typeof result.params.memberWraps[0]!.wrap).toBe('string');
    // Verify memberWraps shape: only memberPublicKey + wrap (no metadata)
    expect(Object.keys(result.params.memberWraps[0]!)).toEqual(['memberPublicKey', 'wrap']);
  });

  it('returns new epoch private key and incremented epoch number', () => {
    const newPrivateKey = new Uint8Array(32).fill(11);
    const rotationResult = {
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: newPrivateKey,
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    };
    mockPerformEpochRotation.mockReturnValue(rotationResult);
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const result = buildRotation({
      conversationId: 'conv-1',
      currentEpochNumber: 3,
      predecessor: { epochNumber: 3, privateKey: new Uint8Array(32).fill(1) },
      members: [],
      plaintextTitle: 'Title',
    });

    expect(result.newEpochPrivateKey).toBe(newPrivateKey);
    expect(result.newEpochNumber).toBe(4);
  });
});

const MEMBER_KEYS = [
  {
    memberId: 'm1',
    userId: 'u1',
    linkId: null,
    publicKey: 'cHViMQ==',
    privilege: 'owner',
    visibleFromEpoch: 1,
  },
];

/**
 * `details` is omitted entirely when no argument is passed, which is the bare
 * 409 an ordinary conflict produces; `currentEpoch` is typed `unknown` so a
 * malformed wire value can be handed in as easily as a well-formed one.
 */
function staleEpochError(currentEpoch?: unknown): ApiError {
  const data =
    currentEpoch === undefined
      ? { code: 'STALE_EPOCH' }
      : { code: 'STALE_EPOCH', details: { currentEpoch } };
  return new ApiError('Epoch rotation conflict', 409, data);
}

function passThroughMembers(keys: { publicKey: string }[]): { publicKey: Uint8Array }[] {
  return keys.map((k) => ({ publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64')) }));
}

describe('executeWithRotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentEpoch.mockImplementation(() => undefined);
    mockGetEpochKey.mockImplementation(() => undefined);
    // The real cache writes the verdict and the current epoch from one keychain.
    mockGetEpochVerdict.mockImplementation((conversationId: string) =>
      verdict('ok', mockGetCurrentEpoch(conversationId) ?? 3)
    );
  });

  it('refuses to build when this client holds no verdict for the conversation', async () => {
    mockGetEpochVerdict.mockReset();
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    const mockExecute = vi.fn().mockResolvedValue({});

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toBeInstanceOf(UnverifiedKeyChainError);
    expect(mockPerformEpochRotation).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('consults the verdict of the conversation it rotates', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: vi.fn().mockResolvedValue({}),
    });

    expect(mockGetEpochVerdict).toHaveBeenCalledWith('conv-1');
  });

  it('refuses the stale-epoch retry once the keychain it would retry against is bad', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 4 ? new Uint8Array(32).fill(44) : undefined
    );

    // The refetch that follows the refusal lands a keychain whose newest link is bad.
    const mockExecute = vi.fn().mockImplementationOnce(() => {
      cachedEpoch = 4;
      mockGetEpochVerdict.mockReturnValue(verdict('bad', 4));
      return Promise.reject(staleEpochError());
    });

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toBeInstanceOf(UnverifiedKeyChainError);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPerformEpochRotation).toHaveBeenCalledTimes(1);
  });

  it('fetches member keys, builds rotation, and executes mutation', async () => {
    const memberKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'cHViMQ==',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
      {
        memberId: 'm2',
        userId: 'u2',
        linkId: null,
        publicKey: 'cHViMg==',
        privilege: 'write',
        visibleFromEpoch: 1,
      },
    ];
    mockFetchJson.mockResolvedValue({ members: memberKeys });

    // echo input keys back in memberWraps (like the real function)
    const newPrivateKey = new Uint8Array(32).fill(77);
    mockPerformEpochRotation.mockImplementation(
      ({ memberPublicKeys }: { memberPublicKeys: Uint8Array[] }) => ({
        epochPublicKey: new Uint8Array(32).fill(10),
        epochPrivateKey: newPrivateKey,
        confirmationHash: new Uint8Array(32).fill(12),
        memberWraps: memberPublicKeys.map((key) => ({
          memberPublicKey: key,
          wrap: new Uint8Array(48).fill(20),
        })),
        chainLink: new Uint8Array(64).fill(13),
      })
    );
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const mockExecute = vi.fn().mockResolvedValue({});
    const mockFilterMembers = vi.fn((keys: { publicKey: string }[]) =>
      keys.map((k) => ({
        publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64')),
      }))
    );

    const result = await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: mockFilterMembers,
      execute: mockExecute,
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);

    expect(mockFilterMembers).toHaveBeenCalledWith(memberKeys);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(result.params);
    expect(result.newEpochPrivateKey).toBe(newPrivateKey);
  });

  it('caches nothing: the new key reaches the cache only through a verified keychain', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: vi.fn().mockResolvedValue({}),
    });

    expect(mockSetEpochKey).not.toHaveBeenCalled();
    expect(mockSetCurrentEpoch).not.toHaveBeenCalled();
  });

  it('retries on 409 once the key chain has advanced past the rejected epoch', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 4 ? new Uint8Array(32).fill(44) : undefined
    );

    const mockExecute = vi
      .fn()
      .mockImplementationOnce(() => {
        cachedEpoch = 4;
        return Promise.reject(staleEpochError());
      })
      .mockResolvedValueOnce({});

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: mockExecute,
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    // member keys re-fetched after 409
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it('rotates the retry against the epoch the key chain advanced to', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const refreshedKey = new Uint8Array(32).fill(44);
    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 4 ? refreshedKey : undefined
    );

    const mockExecute = vi
      .fn()
      .mockImplementationOnce(() => {
        cachedEpoch = 4;
        return Promise.reject(staleEpochError());
      })
      .mockResolvedValueOnce({});

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: mockExecute,
    });

    expect(mockPerformEpochRotation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        predecessor: expect.objectContaining({ epochNumber: 4, privateKey: refreshedKey }),
        epochNumber: 5,
      })
    );
    expect(mockExecute.mock.calls[1]![0]).toMatchObject({ expectedEpoch: 4 });
  });

  it('rotates against the newest cached epoch when the caller passes an older one', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const cachedKey = new Uint8Array(32).fill(55);
    mockGetCurrentEpoch.mockImplementation(() => 5);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 5 ? cachedKey : undefined
    );

    const mockExecute = vi.fn().mockResolvedValue({});

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: mockExecute,
    });

    expect(mockPerformEpochRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        predecessor: expect.objectContaining({ epochNumber: 5, privateKey: cachedKey }),
        epochNumber: 6,
      })
    );
    expect(mockExecute.mock.calls[0]![0]).toMatchObject({ expectedEpoch: 5 });
  });

  it('does not retry when the key chain has not advanced past the rejected epoch', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    mockGetCurrentEpoch.mockImplementation(() => 3);
    mockGetEpochKey.mockImplementation(() => new Uint8Array(32).fill(1));

    const mockExecute = vi.fn().mockRejectedValue(staleEpochError());

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toThrow('Epoch rotation conflict');

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPerformEpochRotation).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the advanced epoch has no key in the key chain', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation(() => undefined);

    const mockExecute = vi.fn().mockImplementation(() => {
      cachedEpoch = 4;
      return Promise.reject(staleEpochError());
    });

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toThrow('Epoch rotation conflict');

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the key chain sits behind the epoch the refusal names', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 4 ? new Uint8Array(32).fill(44) : undefined
    );

    // Two rotations landed while this one was in flight: the server is at 5,
    // the cache has caught up to only the first of them.
    const mockExecute = vi.fn().mockImplementation(() => {
      cachedEpoch = 4;
      return Promise.reject(staleEpochError(5));
    });

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toThrow('Epoch rotation conflict');

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPerformEpochRotation).toHaveBeenCalledTimes(1);
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('retries when the key chain holds exactly the epoch the refusal names', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const refreshedKey = new Uint8Array(32).fill(55);
    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 5 ? refreshedKey : undefined
    );

    const mockExecute = vi
      .fn()
      .mockImplementationOnce(() => {
        cachedEpoch = 5;
        return Promise.reject(staleEpochError(5));
      })
      .mockResolvedValueOnce({});

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: mockExecute,
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockPerformEpochRotation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        predecessor: expect.objectContaining({ epochNumber: 5, privateKey: refreshedKey }),
        epochNumber: 6,
      })
    );
    expect(mockExecute.mock.calls[1]![0]).toMatchObject({ expectedEpoch: 5 });
  });

  it('retries when the key chain has advanced past the epoch the refusal names', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const refreshedKey = new Uint8Array(32).fill(55);
    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 5 ? refreshedKey : undefined
    );

    // The server minted the refusal while at 4 and has since committed a second
    // rotation; the peer's completion broadcast and key-chain refetch land before
    // the refusal resolves, so the cache is at 5 while the refusal names 4.
    const mockExecute = vi
      .fn()
      .mockImplementationOnce(() => {
        cachedEpoch = 5;
        return Promise.reject(staleEpochError(4));
      })
      .mockResolvedValueOnce({});

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: mockExecute,
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockPerformEpochRotation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        predecessor: expect.objectContaining({ epochNumber: 5, privateKey: refreshedKey }),
        epochNumber: 6,
      })
    );
    expect(mockExecute.mock.calls[1]![0]).toMatchObject({ expectedEpoch: 5 });
  });

  it('retries on a refusal whose named epoch is unreadable, as if it named none', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 4 ? new Uint8Array(32).fill(44) : undefined
    );

    const mockExecute = vi
      .fn()
      .mockImplementationOnce(() => {
        cachedEpoch = 4;
        return Promise.reject(staleEpochError('4'));
      })
      .mockResolvedValueOnce({});

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: mockExecute,
    });

    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockExecute.mock.calls[1]![0]).toMatchObject({ expectedEpoch: 4 });
  });

  it('gives up after max retries on repeated 409', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation(() => new Uint8Array(32).fill(44));

    const mockExecute = vi.fn().mockImplementation(() => {
      cachedEpoch = cachedEpoch === undefined ? 4 : cachedEpoch + 1;
      return Promise.reject(staleEpochError());
    });

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toThrow('Epoch rotation conflict');

    // initial + 1 retry
    expect(mockExecute).toHaveBeenCalledTimes(2);
  });

  it('does not rebuild against the epoch a stale refusal names as current', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));
    mockGetCurrentEpoch.mockImplementation(() => 3);
    mockGetEpochKey.mockImplementation(() => new Uint8Array(32).fill(1));

    const refusal = staleEpochError(3);
    const mockExecute = vi.fn().mockRejectedValue(refusal);

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toBe(refusal);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPerformEpochRotation).toHaveBeenCalledTimes(1);
  });

  it('does not rebuild when a stale refusal names an epoch below the one it refused', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));
    mockGetCurrentEpoch.mockImplementation(() => 3);
    mockGetEpochKey.mockImplementation(() => new Uint8Array(32).fill(1));

    const refusal = staleEpochError(2);
    const mockExecute = vi.fn().mockRejectedValue(refusal);

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toBe(refusal);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('makes a single attempt when the caller limits it to one', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    let cachedEpoch: number | undefined;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 4 ? new Uint8Array(32).fill(44) : undefined
    );

    // A refusal the default limit would rebuild after: the key chain advanced to 4.
    const refusal = staleEpochError(4);
    const mockExecute = vi.fn().mockImplementation(() => {
      cachedEpoch = 4;
      return Promise.reject(refusal);
    });

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
        maxAttempts: 1,
      })
    ).rejects.toBe(refusal);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('does not build when the verdict turns ok for an epoch it holds no key for mid-fetch', async () => {
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    // Epoch 2's key verified but its chain link did not; a keychain landing
    // during the member-keys read moves the conversation to an epoch 3 that
    // verifies, whose key this client has not unwrapped.
    let cachedEpoch = 2;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 2 ? new Uint8Array(32).fill(22) : undefined
    );
    mockGetEpochVerdict.mockReturnValue(verdict('bad', 2));
    mockFetchJson.mockImplementation(() => {
      cachedEpoch = 3;
      mockGetEpochVerdict.mockReturnValue(verdict('ok', 3));
      return Promise.resolve({ members: MEMBER_KEYS });
    });
    const mockExecute = vi.fn().mockResolvedValue({});

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(22),
        currentEpochNumber: 2,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toBeInstanceOf(UnverifiedKeyChainError);
    expect(mockPerformEpochRotation).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('does not build on an epoch newer than the one the verdict judged', async () => {
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockGetEpochVerdict.mockReturnValue(verdict('ok', 3));
    const mockExecute = vi.fn().mockResolvedValue({});

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(5),
        currentEpochNumber: 5,
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toBeInstanceOf(UnverifiedKeyChainError);
    expect(mockPerformEpochRotation).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('builds on the epoch the key chain reached during the member-keys fetch', async () => {
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const advancedKey = new Uint8Array(32).fill(44);
    let cachedEpoch = 3;
    mockGetCurrentEpoch.mockImplementation(() => cachedEpoch);
    mockGetEpochKey.mockImplementation((_conversationId: string, epochNumber: number) =>
      epochNumber === 4 ? advancedKey : undefined
    );
    mockFetchJson.mockImplementation(() => {
      cachedEpoch = 4;
      return Promise.resolve({ members: MEMBER_KEYS });
    });
    const mockExecute = vi.fn().mockResolvedValue({});

    await executeWithRotation({
      conversationId: 'conv-1',
      currentEpochPrivateKey: new Uint8Array(32).fill(1),
      currentEpochNumber: 3,
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: mockExecute,
    });

    expect(mockPerformEpochRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        predecessor: expect.objectContaining({ epochNumber: 4, privateKey: advancedKey }),
      })
    );
    expect(mockExecute.mock.calls[0]![0]).toMatchObject({ expectedEpoch: 4 });
  });

  it('throws non-409 errors immediately without retry', async () => {
    const memberKeys = [
      {
        memberId: 'm1',
        userId: 'u1',
        linkId: null,
        publicKey: 'cHViMQ==',
        privilege: 'owner',
        visibleFromEpoch: 1,
      },
    ];
    mockFetchJson.mockResolvedValue({ members: memberKeys });

    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));

    const networkError = new Error('Network error');
    const mockExecute = vi.fn().mockRejectedValue(networkError);

    await expect(
      executeWithRotation({
        conversationId: 'conv-1',
        currentEpochPrivateKey: new Uint8Array(32).fill(1),
        currentEpochNumber: 3,
        plaintextTitle: 'Test',
        filterMembers: (keys) =>
          keys.map((k) => ({
            publicKey: new Uint8Array(Buffer.from(k.publicKey, 'base64')),
          })),
        execute: mockExecute,
      })
    ).rejects.toThrow('Network error');

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });
});

describe('executeRecoveryRotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCurrentEpoch.mockImplementation(() => undefined);
    mockGetEpochKey.mockImplementation(() => undefined);
    mockGetEpochVerdict.mockReturnValue(verdict('bad', 4));
    mockFetchJson.mockResolvedValue({ members: MEMBER_KEYS });
    mockPerformEpochRotation.mockReturnValue({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(77),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
      chainLink: new Uint8Array(64).fill(13),
    });
    mockEncryptMessageForStorage.mockReturnValue(new Uint8Array(16).fill(99));
  });

  it('builds the rotation from the predecessor it names and executes it once', async () => {
    const predecessorKey = new Uint8Array(32).fill(6);
    const mockExecute = vi.fn().mockResolvedValue({});

    const result = await executeRecoveryRotation({
      conversationId: 'conv-1',
      currentEpochNumber: 4,
      predecessor: { epochNumber: 2, privateKey: predecessorKey },
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: mockExecute,
    });

    expect(mockPerformEpochRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        predecessor: expect.objectContaining({ epochNumber: 2, privateKey: predecessorKey }),
        epochNumber: 5,
      })
    );
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith(result.params);
    expect(result.params.expectedEpoch).toBe(4);
  });

  it('builds while the conversation’s rotation is bad, the one path that may', async () => {
    const mockExecute = vi.fn().mockResolvedValue({});

    await executeRecoveryRotation({
      conversationId: 'conv-1',
      currentEpochNumber: 4,
      predecessor: { epochNumber: 1, privateKey: new Uint8Array(32).fill(6) },
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: mockExecute,
    });

    expect(mockGetEpochVerdict('conv-1')?.rotation).toBe('bad');
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it('does not retry a refused recovery', async () => {
    mockGetCurrentEpoch.mockImplementation(() => 5);
    mockGetEpochKey.mockImplementation(() => new Uint8Array(32).fill(55));
    const refusal = staleEpochError(5);
    const mockExecute = vi.fn().mockRejectedValue(refusal);

    await expect(
      executeRecoveryRotation({
        conversationId: 'conv-1',
        currentEpochNumber: 4,
        predecessor: { epochNumber: 2, privateKey: new Uint8Array(32).fill(6) },
        plaintextTitle: 'Test',
        filterMembers: passThroughMembers,
        execute: mockExecute,
      })
    ).rejects.toBe(refusal);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('caches nothing', async () => {
    await executeRecoveryRotation({
      conversationId: 'conv-1',
      currentEpochNumber: 4,
      predecessor: { epochNumber: 2, privateKey: new Uint8Array(32).fill(6) },
      plaintextTitle: 'Test',
      filterMembers: passThroughMembers,
      execute: vi.fn().mockResolvedValue({}),
    });

    expect(mockSetEpochKey).not.toHaveBeenCalled();
    expect(mockSetCurrentEpoch).not.toHaveBeenCalled();
  });
});
