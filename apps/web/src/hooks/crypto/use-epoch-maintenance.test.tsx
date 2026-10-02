import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { render, renderHook, waitFor, act } from '@testing-library/react';
import {
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
  dehydrate,
  useQuery,
} from '@tanstack/react-query';
import {
  decryptTextFromEpoch,
  encryptTextForEpoch,
  generateKeyPair,
  openEpochWrap,
} from '@hushbox/crypto';
import { fromBase64, toBase64 } from '@hushbox/shared';
import { TEST_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import { chatKeys } from '@/hooks/chat/chat';
import { keyChainQueryOptions, keyKeys } from '@/hooks/crypto/keys';
import { ApiError } from '@/lib/api/api';
import { apiErrorFromResponse } from '@/lib/api/api-error-from-response';
import { IDEMPOTENCY_KEY_HEADER, markRequestKeyed } from '@/lib/api/idempotent-mutation';
import { MAX_RETRIES, computeRetryDelay, shouldRetryMutation } from '@/lib/api/retry';
import { clearLinkGuestAuth, setLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { ChatRequestError } from '@/lib/chat/request-error';
import {
  firstEpoch as firstEpochIn,
  keyChainOf,
  rotateFrom as rotateFromIn,
  withForeignPublicKey,
} from '@/test-utils/key-chain-builders';
import { clearEpochKeyCache, processKeyChain, setEpochKey } from '@/lib/crypto/epoch-key-cache';
import {
  recoveryPredecessor,
  requestEpochMaintenanceOnRefusal,
  useEpochMaintenance,
} from '@/hooks/crypto/use-epoch-maintenance';
import type { DefaultOptions } from '@tanstack/react-query';
import type { KeyPair } from '@hushbox/crypto';
import type {
  GetConversationResponse,
  KeyChainResponse,
  RotateEpochBody,
  RotateEpochOutcome,
} from '@hushbox/shared';
import type { EpochVerdict } from '@/lib/crypto/epoch-key-cache';
import type { MemberKeyResponse } from '@/lib/crypto/rotation';
import type { BuiltEpoch } from '@/test-utils/key-chain-builders';

const CONVERSATION_ID = 'conv-maintained';
const TITLE = 'Trip plans';

interface EpochsPostArgument {
  param: { conversationId: string };
  json: RotateEpochBody;
}

interface EpochsPostInit {
  headers?: Record<string, string>;
}

const mockEpochsPost = vi.fn(
  (_argument: EpochsPostArgument, _init?: EpochsPostInit): Promise<RotateEpochOutcome> =>
    Promise.resolve({ rotated: true, newEpochNumber: 2 })
);
const mockMemberKeysGet = vi.fn(
  (): Promise<{ members: MemberKeyResponse[] }> => Promise.resolve({ members: [] })
);
const mockConversationGet = vi.fn(
  (): Promise<GetConversationResponse> => Promise.reject(new Error('no conversation served'))
);
const mockKeyChainGet = vi.fn(
  (): Promise<KeyChainResponse> => Promise.reject(new Error('no keychain served'))
);

// The API is the one external seam: every call returns its body directly, and
// `fetchJson` passes it through.
vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      ':conversationId': {
        $get: () => mockConversationGet(),
        keychain: { $get: () => mockKeyChainGet() },
        'member-keys': { $get: () => mockMemberKeysGet() },
        epochs: {
          $post: (argument: EpochsPostArgument, init?: EpochsPostInit) =>
            mockEpochsPost(argument, init),
        },
      },
    },
  },
  fetchJson: (response: Promise<unknown>) => response,
}));

function firstEpoch(seats: readonly KeyPair[]): BuiltEpoch {
  return firstEpochIn(CONVERSATION_ID, seats);
}

function rotateFrom(seat: KeyPair, predecessor: BuiltEpoch, epochNumber: number): BuiltEpoch {
  return rotateFromIn(CONVERSATION_ID, seat, predecessor, epochNumber);
}

function memberKey(memberId: string, seat: KeyPair): MemberKeyResponse {
  return {
    memberId,
    userId: memberId,
    linkId: null,
    publicKey: toBase64(seat.publicKey),
    privilege: 'write',
    visibleFromEpoch: 1,
  };
}

function conversationDetail(titleEpoch: BuiltEpoch, currentEpoch: number): GetConversationResponse {
  return {
    conversation: {
      id: CONVERSATION_ID,
      title: toBase64(
        encryptTextForEpoch(titleEpoch.publishedPublicKey, TITLE, {
          conversationId: CONVERSATION_ID,
          epochNumber: titleEpoch.epochNumber,
        })
      ),
      currentEpoch,
      titleEpochNumber: titleEpoch.epochNumber,
      nextSequence: 1,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
    },
    membership: {
      privilege: 'owner',
      muted: false,
      pinned: false,
      accepted: true,
      visibleFromEpoch: 1,
      lastReadSeq: 0,
      linkId: null,
    },
    forks: [],
  };
}

let servedDetail: GetConversationResponse | undefined;

/**
 * Serves the conversation read, and seeds it into the query cache at render so
 * the hook judges the conversation on its first effect rather than after a
 * fetch lands on some later tick.
 */
function serveConversation(detail: GetConversationResponse): void {
  servedDetail = detail;
  mockConversationGet.mockResolvedValue(detail);
}

/**
 * What the chat page does beside maintenance: `useDecryptedMessages` reads the
 * keychain query and hands each fetched keychain to the cache in an effect.
 * Declared after maintenance, so a refetch reaches maintenance's effect before
 * the cache has judged it — the order that makes a stale verdict observable.
 */
function useServedKeyChain(conversationId: string, principal: KeyPair): void {
  const { data } = useQuery(keyChainQueryOptions(conversationId));
  React.useEffect(() => {
    if (data) processKeyChain(conversationId, data, principal.privateKey);
  }, [conversationId, data, principal]);
}

/** Serves the keychain every fetch of the keychain query returns. */
function serveKeyChain(keyChain: KeyChainResponse): void {
  mockKeyChainGet.mockResolvedValue(keyChain);
}

function renderMaintenance(
  conversationId: string | null = CONVERSATION_ID,
  keyChainServedTo?: KeyPair,
  mutations?: DefaultOptions['mutations']
): {
  rerender: () => void;
  unmount: () => void;
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: mutations ?? { retry: false } },
  });
  if (servedDetail !== undefined) {
    queryClient.setQueryData(chatKeys.conversation(CONVERSATION_ID), servedDetail);
  }
  const wrapper = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { rerender, unmount } = renderHook(
    () => {
      useEpochMaintenance(conversationId);
      if (keyChainServedTo !== undefined) useServedKeyChain(CONVERSATION_ID, keyChainServedTo);
    },
    { wrapper }
  );
  return { rerender, unmount, queryClient };
}

/** A keychain fetch completing, as `member:removed` or a refused send asks for one. */
async function refetchKeyChain(queryClient: QueryClient): Promise<void> {
  await act(async () => {
    await queryClient.invalidateQueries({ queryKey: keyKeys.chain(CONVERSATION_ID) });
  });
}

/** Lets every pending effect, query and mutation run to rest. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** The title a posted rotation carries, opened with the owner's wrap of the minted epoch. */
function postedTitle(body: RotateEpochBody, owner: KeyPair): string {
  const epochNumber = body.expectedEpoch + 1;
  const ownerWrap = body.memberWraps.find((w) => w.memberPublicKey === toBase64(owner.publicKey));
  const opened = openEpochWrap(owner.privateKey, fromBase64(ownerWrap!.wrap), {
    conversationId: CONVERSATION_ID,
    epochNumber,
    epochPublicKey: fromBase64(body.epochPublicKey),
    confirmationHash: fromBase64(body.confirmationHash),
  });
  if (!opened.ok) throw new Error(`minted epoch did not open: ${opened.reason}`);
  return decryptTextFromEpoch(opened.key, fromBase64(body.encryptedTitle), {
    conversationId: CONVERSATION_ID,
    epochNumber,
  });
}

function postedBodies(): RotateEpochBody[] {
  return mockEpochsPost.mock.calls.map(([argument]) => argument.json);
}

describe('useEpochMaintenance', () => {
  let owner: KeyPair;
  let peer: KeyPair;

  beforeEach(() => {
    vi.clearAllMocks();
    servedDetail = undefined;
    clearEpochKeyCache();
    clearLinkGuestAuth();
    owner = generateKeyPair();
    peer = generateKeyPair();
    mockMemberKeysGet.mockResolvedValue({
      members: [memberKey('owner', owner), memberKey('peer', peer)],
    });
    mockEpochsPost.mockResolvedValue({ rotated: true, newEpochNumber: 2 });
  });

  afterEach(() => {
    clearLinkGuestAuth();
  });

  it('rotates once when the keychain says a departure is pending', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1], { rotationPending: true }),
      owner.privateKey
    );

    const { rerender } = renderMaintenance();
    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(1);
    });
    rerender();
    await settle();

    expect(mockEpochsPost).toHaveBeenCalledTimes(1);
    const [body] = postedBodies();
    expect(body!.expectedEpoch).toBe(1);
    expect(body!.predecessorEpoch).toBeUndefined();
    expect(body!.memberWraps.map((w) => w.memberPublicKey)).toEqual([
      toBase64(owner.publicKey),
      toBase64(peer.publicKey),
    ]);
  });

  it('re-encrypts the title it can read under the epoch it mints', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1], { rotationPending: true }),
      owner.privateKey
    );

    renderMaintenance();
    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(1);
    });

    const [body] = postedBodies();
    expect(postedTitle(body!, owner)).toBe(TITLE);
  });

  it('carries an empty title when the title sits under a key that did not verify', async () => {
    const epoch1 = firstEpoch([owner]);
    const hostile = withForeignPublicKey(rotateFrom(owner, epoch1, 2));
    serveConversation(conversationDetail(hostile, 2));
    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, hostile]), owner.privateKey);

    renderMaintenance();
    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(1);
    });

    const [body] = postedBodies();
    expect(postedTitle(body!, owner)).toBe('');
  });

  it('carries an empty title when the stored title does not decrypt', async () => {
    const epoch1 = firstEpoch([owner]);
    const detail = conversationDetail(epoch1, 1);
    serveConversation({
      ...detail,
      conversation: { ...detail.conversation, title: toBase64(new Uint8Array(64).fill(3)) },
    });
    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1], { rotationPending: true }),
      owner.privateKey
    );

    renderMaintenance();
    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(1);
    });

    const [body] = postedBodies();
    expect(postedTitle(body!, owner)).toBe('');
  });

  it('recovers once from the last good epoch when the current rotation is bad', async () => {
    const epoch1 = firstEpoch([owner]);
    const hostile = withForeignPublicKey(rotateFrom(owner, epoch1, 2));
    serveConversation(conversationDetail(epoch1, 2));
    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1, hostile]), owner.privateKey);

    const { rerender } = renderMaintenance();
    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(1);
    });
    rerender();
    await settle();

    expect(mockEpochsPost).toHaveBeenCalledTimes(1);
    const [body] = postedBodies();
    expect(body!.expectedEpoch).toBe(2);
    expect(body!.predecessorEpoch).toBe(1);
  });

  it('stops after the server answers that the rotation is no longer needed', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    mockEpochsPost.mockResolvedValue({ rotated: false, currentEpoch: 1 });

    const { queryClient } = renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(1);
    });
    await refetchKeyChain(queryClient);
    await settle();

    expect(mockKeyChainGet.mock.calls.length).toBeGreaterThan(2);
    expect(mockEpochsPost).toHaveBeenCalledTimes(1);
  });

  it('does nothing for a link guest', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    setLinkGuestAuth(toBase64(owner.publicKey));
    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1], { rotationPending: true }),
      owner.privateKey
    );

    const { unmount } = renderMaintenance();
    await settle();
    unmount();

    expect(mockMemberKeysGet).not.toHaveBeenCalled();
    expect(mockEpochsPost).not.toHaveBeenCalled();
  });

  it('does nothing when the client holds no verified key for the pending epoch', async () => {
    const epoch1 = firstEpoch([peer]);
    const unwrapped: BuiltEpoch = { ...epoch1, wrap: null };
    serveConversation(conversationDetail(epoch1, 1));
    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([unwrapped], { rotationPending: true }),
      owner.privateKey
    );

    renderMaintenance();
    await settle();

    expect(mockMemberKeysGet).not.toHaveBeenCalled();
    expect(mockEpochsPost).not.toHaveBeenCalled();
  });

  it('does nothing when no epoch below a bad rotation verified', async () => {
    const epoch1 = withForeignPublicKey(firstEpoch([owner]));
    serveConversation(conversationDetail(epoch1, 1));
    processKeyChain(
      CONVERSATION_ID,
      keyChainOf([epoch1], { rotationPending: true }),
      owner.privateKey
    );

    renderMaintenance();
    await settle();

    expect(mockMemberKeysGet).not.toHaveBeenCalled();
    expect(mockEpochsPost).not.toHaveBeenCalled();
  });

  it('does nothing while nothing is pending and every key verified', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    processKeyChain(CONVERSATION_ID, keyChainOf([epoch1]), owner.privateKey);

    renderMaintenance();
    await settle();

    expect(mockMemberKeysGet).not.toHaveBeenCalled();
    expect(mockEpochsPost).not.toHaveBeenCalled();
  });

  it('does nothing without a conversation', async () => {
    renderMaintenance(null);
    await settle();

    expect(mockConversationGet).not.toHaveBeenCalled();
    expect(mockEpochsPost).not.toHaveBeenCalled();
  });

  it('retries a failed attempt once a refetched keychain shows the same situation', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    const failure = new Error('network down');
    mockEpochsPost.mockRejectedValueOnce(failure);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(2);
    });

    expect(consoleError).toHaveBeenCalledWith('Epoch maintenance failed:', failure);
    expect(postedBodies().map((b) => b.expectedEpoch)).toEqual([1, 1]);
    consoleError.mockRestore();
  });

  it('stops after three failed attempts at the same situation', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    mockEpochsPost.mockRejectedValue(new Error('server error'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { queryClient } = renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledTimes(3);
    });
    await refetchKeyChain(queryClient);
    await refetchKeyChain(queryClient);
    await settle();

    expect(mockKeyChainGet.mock.calls.length).toBeGreaterThan(4);
    expect(mockEpochsPost).toHaveBeenCalledTimes(3);
    consoleError.mockRestore();
  });

  it('builds three rotations when the app retry resends each under its own key against a server that always answers 503', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    const keysSent: string[] = [];
    // The transport as the typed client runs it: the key rides the request
    // headers, and the 503 becomes the error the app's retry predicate reads.
    mockEpochsPost.mockImplementation(async (_argument, init) => {
      const key = init?.headers?.[IDEMPOTENCY_KEY_HEADER];
      if (key !== undefined) keysSent.push(key);
      const response = Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
      throw await apiErrorFromResponse(markRequestKeyed(response, key !== undefined));
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    freezeClock(TEST_DAY_START);
    try {
      const { queryClient } = renderMaintenance(CONVERSATION_ID, owner, {
        retry: shouldRetryMutation,
        retryDelay: computeRetryDelay,
      });
      // Each pass outlasts the longest backoff the policy can draw, so the passes
      // run every resend and every refetch-driven attempt to rest.
      for (let pass = 0; pass < 12; pass++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
      }
      await refetchKeyChain(queryClient);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
    } finally {
      vi.useRealTimers();
    }

    const builds = new Map<string, Set<string>>();
    for (const [index, body] of postedBodies().entries()) {
      const keys = builds.get(body.epochPublicKey) ?? new Set<string>();
      keys.add(keysSent[index]!);
      builds.set(body.epochPublicKey, keys);
    }
    const sendsPerSubmission = 1 + MAX_RETRIES;
    expect(mockMemberKeysGet).toHaveBeenCalledTimes(3);
    expect(builds.size).toBe(3);
    expect(keysSent).toHaveLength(mockEpochsPost.mock.calls.length);
    expect(mockEpochsPost).toHaveBeenCalledTimes(3 * sendsPerSubmission);
    expect([...builds.values()].map((keys) => keys.size)).toEqual([1, 1, 1]);
    expect(new Set(keysSent).size).toBe(3);
    consoleError.mockRestore();
  });

  it('posts once per attempt when every rotation is refused as stale at the epoch it tried', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    mockEpochsPost.mockRejectedValue(
      new ApiError('Epoch rotation conflict', 409, {
        code: 'STALE_EPOCH',
        details: { currentEpoch: 1 },
      })
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { queryClient } = renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledTimes(3);
    });
    await refetchKeyChain(queryClient);
    await refetchKeyChain(queryClient);
    await settle();

    expect(mockEpochsPost).toHaveBeenCalledTimes(3);
    expect(postedBodies().map((b) => b.expectedEpoch)).toEqual([1, 1, 1]);
    consoleError.mockRestore();
  });

  it('ends an attempt at a stale refusal instead of rebuilding within it', async () => {
    const epoch1 = firstEpoch([owner]);
    const epoch2 = rotateFrom(owner, epoch1, 2);
    const advanced = keyChainOf([epoch1, epoch2], { rotationPending: true });
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    const refusal = new ApiError('Epoch rotation conflict', 409, {
      code: 'STALE_EPOCH',
      details: { currentEpoch: 2 },
    });
    // Another member's rotation lands in the cache before this one is refused.
    mockEpochsPost.mockImplementationOnce(() => {
      serveKeyChain(advanced);
      processKeyChain(CONVERSATION_ID, advanced, owner.privateKey);
      return Promise.reject(refusal);
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(2);
    });
    await settle();

    expect(consoleError).toHaveBeenCalledWith('Epoch maintenance failed:', refusal);
    expect(postedBodies().map((b) => b.expectedEpoch)).toEqual([1, 2]);
    consoleError.mockRestore();
  });

  it('starts a fresh count of attempts when the current epoch changes', async () => {
    const epoch1 = firstEpoch([owner]);
    const epoch2 = rotateFrom(owner, epoch1, 2);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    mockEpochsPost.mockRejectedValue(new Error('server error'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { queryClient } = renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledTimes(3);
    });
    serveKeyChain(keyChainOf([epoch1, epoch2], { rotationPending: true }));
    mockEpochsPost.mockResolvedValue({ rotated: true, newEpochNumber: 3 });
    await refetchKeyChain(queryClient);
    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(4);
    });

    expect(postedBodies()[3]!.expectedEpoch).toBe(2);
    consoleError.mockRestore();
  });

  it('does not retry against a verdict the refetched keychain has not yet replaced', async () => {
    const epoch1 = firstEpoch([owner]);
    const epoch2 = rotateFrom(owner, epoch1, 2);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    // Fails before any POST, so no refetch follows the failure by itself.
    mockMemberKeysGet.mockRejectedValueOnce(new Error('network down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { queryClient } = renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledTimes(1);
    });
    // Another member rotated: the refetch shows nothing left to do.
    serveKeyChain(keyChainOf([epoch1, epoch2]));
    await refetchKeyChain(queryClient);
    await settle();

    expect(mockEpochsPost).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not retry once a same-epoch refetch no longer shows the departure', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    mockMemberKeysGet.mockRejectedValueOnce(new Error('network down'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { queryClient } = renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledTimes(1);
    });
    // The departed seat is live again: same epoch, nothing pending.
    serveKeyChain(keyChainOf([epoch1]));
    await refetchKeyChain(queryClient);
    await settle();

    expect(mockEpochsPost).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('rotates when a pending refusal reveals a departure its keychain had not shown', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1]));

    renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(mockKeyChainGet).toHaveBeenCalledTimes(1);
    });
    serveKeyChain(keyChainOf([epoch1], { rotationPending: true }));
    await act(async () => {
      requestEpochMaintenanceOnRefusal(
        CONVERSATION_ID,
        new ChatRequestError('ROTATION_PENDING', undefined, 409)
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockEpochsPost).toHaveBeenCalledTimes(1);
    });
  });

  it('refetches the keychain when the API refuses this client’s send as pending', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1]));

    renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(mockKeyChainGet).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      requestEpochMaintenanceOnRefusal(
        CONVERSATION_ID,
        new ApiError('ROTATION_PENDING', 409, { code: 'ROTATION_PENDING' })
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockKeyChainGet).toHaveBeenCalledTimes(2);
    });
  });

  it('ignores a pending refusal for another conversation', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1]));

    renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(mockKeyChainGet).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      requestEpochMaintenanceOnRefusal(
        'conv-elsewhere',
        new ChatRequestError('ROTATION_PENDING', undefined, 409)
      );
      await Promise.resolve();
    });
    await settle();

    expect(mockKeyChainGet).toHaveBeenCalledTimes(1);
  });

  it('ignores a refusal that is not a pending rotation', async () => {
    const epoch1 = firstEpoch([owner]);
    serveConversation(conversationDetail(epoch1, 1));
    serveKeyChain(keyChainOf([epoch1]));

    renderMaintenance(CONVERSATION_ID, owner);
    await waitFor(() => {
      expect(mockKeyChainGet).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      requestEpochMaintenanceOnRefusal(
        CONVERSATION_ID,
        new ChatRequestError('INSUFFICIENT_ADMISSION', undefined, 402)
      );
      await Promise.resolve();
    });
    await settle();

    expect(mockKeyChainGet).toHaveBeenCalledTimes(1);
  });

  it('counts a keychain another component creates during its render only after that render', async () => {
    const consoleError = vi.spyOn(console, 'error');
    onTestFinished(() => {
      consoleError.mockRestore();
    });
    const epoch1 = firstEpoch([owner]);
    const source = new QueryClient();
    source.setQueryData(keyKeys.chain(CONVERSATION_ID), keyChainOf([epoch1]));
    const served = dehydrate(source);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Maintained(): null {
      useEpochMaintenance(CONVERSATION_ID);
      return null;
    }
    function Page({ showKeyChain }: Readonly<{ showKeyChain: boolean }>): React.JSX.Element {
      return (
        <QueryClientProvider client={queryClient}>
          <Maintained />
          {showKeyChain && <HydrationBoundary state={served} />}
        </QueryClientProvider>
      );
    }
    const { rerender } = render(<Page showKeyChain={false} />);
    await settle();

    rerender(<Page showKeyChain />);
    await settle();

    expect(queryClient.getQueryState(keyKeys.chain(CONVERSATION_ID))?.dataUpdateCount).toBe(1);
    const logged = consoleError.mock.calls.map(([message]) => String(message));
    expect(logged.filter((message) => message.includes('Cannot update a component'))).toEqual([]);
  });
});

describe('recoveryPredecessor', () => {
  const CONVERSATION = 'conv-recovery';
  const LAST_GOOD_KEY = new Uint8Array(32).fill(7);

  function verdictOf(overrides: Partial<EpochVerdict>): EpochVerdict {
    return {
      currentEpoch: 3,
      rotationPending: false,
      rotation: 'bad',
      lastGoodEpoch: 2,
      badEpochs: new Set([3]),
      ...overrides,
    };
  }

  beforeEach(() => {
    clearEpochKeyCache();
  });

  it('names the last good epoch and its key when this client holds that key', () => {
    setEpochKey(CONVERSATION, 2, LAST_GOOD_KEY);

    expect(recoveryPredecessor(CONVERSATION, verdictOf({}))).toEqual({
      epochNumber: 2,
      privateKey: LAST_GOOD_KEY,
    });
  });

  it('names none when this client lacks the last good key', () => {
    expect(recoveryPredecessor(CONVERSATION, verdictOf({}))).toBeUndefined();
  });

  it('names none when no epoch verified below the bad one', () => {
    setEpochKey(CONVERSATION, 2, LAST_GOOD_KEY);

    expect(recoveryPredecessor(CONVERSATION, verdictOf({ lastGoodEpoch: null }))).toBeUndefined();
  });

  it('names none for a rotation that verified', () => {
    setEpochKey(CONVERSATION, 2, LAST_GOOD_KEY);

    expect(
      recoveryPredecessor(CONVERSATION, verdictOf({ rotation: 'ok', rotationPending: true }))
    ).toBeUndefined();
  });
});
