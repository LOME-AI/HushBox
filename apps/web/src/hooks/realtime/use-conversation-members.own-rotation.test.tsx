import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { generateKeyPair } from '@hushbox/crypto';
import { ERROR_CODES, toBase64 } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { useDecryptedMessages } from '@/hooks/crypto/use-decrypted-messages';
import { keyKeys } from '@/hooks/crypto/keys';
import { useGroupChat } from '@/hooks/realtime/use-group-chat';
import { clearEpochKeyCache, getCurrentEpoch } from '@/lib/crypto/epoch-key-cache';
import { firstEpoch, keyChainOf } from '@/test-utils/key-chain-builders';
import { urlFromFetchInput } from '@/test-utils/fetch-mock';
import type { ReactNode } from 'react';
import type { InferResponseType } from 'hono/client';
import type { KeyPair } from '@hushbox/crypto';
import type { ErrorResponse, KeyChainResponse, StreamChatRotation } from '@hushbox/shared';
import type { client } from '@/lib/api-client';

/**
 * A client that submits a rotation builds its next one on the epoch it just
 * created, with no socket open to deliver `rotation:complete`: the owner of a
 * conversation nobody else has open adds a member, then removes another. The
 * epoch-key cache, the key-chain verifier, the rotation builder and the api
 * client are all real; the server is a stub on `fetch` that serves a keychain
 * built from the rotations it accepts and refuses a stale one as the API does.
 */

vi.mock(import('@tanstack/react-router'), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));

// No socket: the broadcast that would otherwise announce the new epoch never arrives.
vi.mock(import('@/hooks/realtime/use-conversation-websocket'), () => ({
  useConversationWebSocket: () => null,
}));

type Conversations = (typeof client.conversations)[':conversationId'];
type MembersBody = InferResponseType<Conversations['members']['$get'], 200>;
type LinksBody = InferResponseType<Conversations['links']['$get'], 200>;
type MemberKeysBody = InferResponseType<Conversations['member-keys']['$get'], 200>;
type AddMemberBody = InferResponseType<Conversations['members']['$post'], 200>;
type RemoveMemberBody = InferResponseType<
  Conversations['members'][':memberId']['remove']['$post'],
  200
>;

const CONVERSATION_ID = 'conv-own-rotation';
const OWNER_ID = 'user-owner';
const TITLE = 'Trip plans';

interface StubServer {
  /** The `expectedEpoch` of every remove submitted, accepted or refused. */
  removeSubmissions: number[];
}

type MemberKeyRow = MemberKeysBody['members'][number];

function memberKey(memberId: string, userId: string, seat: KeyPair): MemberKeyRow {
  return {
    memberId,
    userId,
    linkId: null,
    publicKey: toBase64(seat.publicKey),
    privilege: 'write',
    visibleFromEpoch: 1,
  };
}

type MemberRow = MembersBody['members'][number];

function memberRow(
  id: string,
  userId: string,
  username: string,
  privilege: MemberRow['privilege']
): MemberRow {
  return {
    id,
    userId,
    linkId: null,
    username,
    privilege,
    visibleFromEpoch: 1,
    joinedAt: isoAt(TEST_DAY_START),
    accepted: true,
  };
}

function rotationOf(body: unknown): StreamChatRotation {
  return (body as { rotation: StreamChatRotation }).rotation;
}

/** A handler the group props must carry for this test to act through it. */
function required<T>(handler: T | undefined): T {
  if (handler === undefined) throw new Error('the group props carry no such handler');
  return handler;
}

/**
 * Serves one conversation owned by `owner` with `bob` seated. An accepted
 * rotation becomes the next epoch of the keychain, carrying the owner's wrap
 * from that rotation, exactly as the API stores it.
 */
function stubServer(owner: KeyPair, bob: KeyPair): StubServer {
  const server: StubServer = { removeSubmissions: [] };
  let keyChain: KeyChainResponse = keyChainOf([firstEpoch(CONVERSATION_ID, [owner, bob])]);
  const memberKeys: MemberKeysBody = {
    members: [memberKey('mem-owner', OWNER_ID, owner), memberKey('mem-bob', 'user-bob', bob)],
  };
  const members: MembersBody = {
    members: [
      memberRow('mem-owner', OWNER_ID, 'owner', 'owner'),
      memberRow('mem-bob', 'user-bob', 'bob', 'write'),
    ],
  };
  const links: LinksBody = { links: [] };

  function accept(rotation: StreamChatRotation): Response | undefined {
    if (rotation.expectedEpoch !== keyChain.currentEpoch) {
      return Response.json(
        {
          code: ERROR_CODES.STALE_EPOCH,
          details: { currentEpoch: keyChain.currentEpoch },
        } satisfies ErrorResponse,
        { status: 409 }
      );
    }
    const ownerWrap = rotation.memberWraps.find(
      (w) => w.memberPublicKey === toBase64(owner.publicKey)
    );
    if (ownerWrap === undefined) throw new Error('the rotation seats no wrap for the owner');
    const epochNumber = keyChain.currentEpoch + 1;
    keyChain = {
      epochs: [
        ...keyChain.epochs,
        {
          epochNumber,
          epochPublicKey: rotation.epochPublicKey,
          confirmationHash: rotation.confirmationHash,
          previousEpochNumber: keyChain.currentEpoch,
          chainLink: rotation.chainLink,
        },
      ],
      wraps: [...keyChain.wraps, { epochNumber, wrap: ownerWrap.wrap }],
      currentEpoch: epochNumber,
      rotationPending: false,
    };
    return undefined;
  }

  const routes: Partial<Record<string, (body: unknown) => Response>> = {
    'GET /keychain': () => Response.json(keyChain),
    'GET /member-keys': () => Response.json(memberKeys),
    'GET /members': () => Response.json(members),
    'GET /links': () => Response.json(links),
    'POST /members': (body) => {
      const added = (): AddMemberBody => ({
        member: memberRow('mem-carol', 'user-carol', 'carol', 'write'),
        newEpochNumber: keyChain.currentEpoch,
      });
      return accept(rotationOf(body)) ?? Response.json(added());
    },
    'POST /members/mem-bob/remove': (body) => {
      const rotation = rotationOf(body);
      server.removeSubmissions.push(rotation.expectedEpoch);
      const removed = (): RemoveMemberBody => ({
        removed: true,
        newEpochNumber: keyChain.currentEpoch,
      });
      return accept(rotation) ?? Response.json(removed());
    },
  };

  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const path = new URL(urlFromFetchInput(input)).pathname;
    const base = `/conversations/${CONVERSATION_ID}`;
    const route = `${init?.method ?? 'GET'} ${path.slice(path.indexOf(base) + base.length)}`;
    const handler = path.includes(base) ? routes[route] : undefined;
    if (handler === undefined) return Promise.reject(new Error(`unexpected ${route}`));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    return Promise.resolve(handler(body));
  });
  return server;
}

function renderOwnerView(owner: KeyPair): {
  result: { current: { group: ReturnType<typeof useGroupChat> } };
  queryClient: QueryClient;
  unmount: () => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  // The chat page mounts both: the message decryptor is what feeds each
  // fetched keychain through the verifier into the epoch-key cache.
  const { result, unmount } = renderHook(
    () => {
      useDecryptedMessages(CONVERSATION_ID, [], owner.privateKey);
      return { group: useGroupChat(CONVERSATION_ID, OWNER_ID, TITLE) };
    },
    { wrapper: Wrapper }
  );
  return { result, queryClient, unmount };
}

describe('a rotation this client submits', () => {
  beforeEach(() => {
    clearEpochKeyCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    clearEpochKeyCache();
  });

  it('is built on by the next rotation once its own keychain refetch lands', async () => {
    const owner = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();
    const server = stubServer(owner, bob);
    const { result, queryClient, unmount } = renderOwnerView(owner);
    await waitFor(() => {
      expect(getCurrentEpoch(CONVERSATION_ID)).toBe(1);
      expect(result.current.group).toBeDefined();
    });

    const addMember = required(result.current.group?.onAddMember);
    await act(async () => {
      await addMember({
        userId: 'user-carol',
        username: 'carol',
        publicKey: toBase64(carol.publicKey),
        privilege: 'write',
        giveFullHistory: false,
      });
    });
    // Lands: every keychain this client has fetched has reached the cache.
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
      expect(getCurrentEpoch(CONVERSATION_ID)).toBe(
        queryClient.getQueryData<KeyChainResponse>(keyKeys.chain(CONVERSATION_ID))?.currentEpoch
      );
    });

    const removeMember = required(result.current.group?.onRemoveMember);
    let removal: unknown = 'removed';
    await act(async () => {
      try {
        await removeMember('mem-bob');
      } catch (error: unknown) {
        removal = error;
      }
    });
    unmount();

    expect(server.removeSubmissions).toEqual([2]);
    expect(removal).toBe('removed');
  });
});
