import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client.js';
import { idempotencyExempt, idempotentHeaders } from '@/lib/api/idempotent-mutation.js';
import { budgetKeys } from '@/hooks/billing/use-conversation-budgets.js';
import { chatKeys } from '@/hooks/chat/chat.js';
import { keyKeys } from '@/hooks/crypto/keys.js';
import type { StreamChatRotation } from '@hushbox/shared';
import type { QueryClient } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

interface MuteConversationVariables {
  conversationId: string;
  muted: boolean;
}

type MuteConversationResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['membership']['mute']['$patch'],
  200
>;

export function useMuteConversation(): UseMutationResult<
  MuteConversationResponse,
  Error,
  MuteConversationVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    meta: idempotencyExempt('naturally-idempotent'),
    mutationFn: ({ conversationId, muted }: MuteConversationVariables) =>
      fetchJson(
        client.conversations[':conversationId'].membership.mute.$patch({
          param: { conversationId },
          json: { muted },
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
    },
  });
}

interface PinConversationVariables {
  conversationId: string;
  pinned: boolean;
}

type PinConversationResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['membership']['pin']['$patch'],
  200
>;

export function usePinConversation(): UseMutationResult<
  PinConversationResponse,
  Error,
  PinConversationVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    meta: idempotencyExempt('naturally-idempotent'),
    mutationFn: ({ conversationId, pinned }: PinConversationVariables) =>
      fetchJson(
        client.conversations[':conversationId'].membership.pin.$patch({
          param: { conversationId },
          json: { pinned },
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
    },
  });
}

function invalidateMemberAndBudget(
  queryClient: QueryClient
): (_data: unknown, variables: { conversationId: string }) => Promise<void> {
  return async (_data, variables) => {
    await queryClient.invalidateQueries({
      queryKey: memberKeys.list(variables.conversationId),
    });
    void queryClient.invalidateQueries({
      queryKey: budgetKeys.conversation(variables.conversationId),
    });
  };
}

/**
 * A submitted rotation moves the conversation's epoch, and the new key reaches
 * this client only through the verified keychain, never from the rotation it
 * built. Whatever the server answered, the keychain is refetched and the
 * mutation settles only once that refetch has landed, so the next action is
 * built on the epoch the server now holds even when no socket is open to
 * deliver `rotation:complete`. A keychain nothing observes is only marked
 * stale, and its next reader fetches it.
 */
export function refetchKeyChainOnSettle(
  queryClient: QueryClient
): (_data: unknown, _error: Error | null, variables: { conversationId: string }) => Promise<void> {
  return (_data, _error, variables) =>
    queryClient.invalidateQueries({ queryKey: keyKeys.chain(variables.conversationId) });
}

export const memberKeys = {
  all: ['members'] as const,
  list: (conversationId: string) => [...memberKeys.all, conversationId] as const,
};

type ConversationMembersResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['members']['$get'],
  200
>;

export function useConversationMembers(
  conversationId: string | null
): UseQueryResult<ConversationMembersResponse> {
  return useQuery({
    queryKey: memberKeys.list(conversationId ?? ''),
    queryFn: () =>
      fetchJson(
        client.conversations[':conversationId'].members.$get({
          param: { conversationId: conversationId ?? '' },
        })
      ),
    enabled: !!conversationId,
  });
}

interface AddMemberVariables {
  conversationId: string;
  userId: string;
  privilege: string;
  giveFullHistory: boolean;
  wrap?: string;
  rotation?: StreamChatRotation;
  expectedEpoch?: number;
}

type AddMemberResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['members']['$post'],
  200
>;

export function useAddMember(): UseMutationResult<AddMemberResponse, Error, AddMemberVariables> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: AddMemberVariables) =>
      fetchJson(
        client.conversations[':conversationId'].members.$post(
          {
            param: { conversationId: input.conversationId },
            json: {
              userId: input.userId,
              privilege: input.privilege as 'read' | 'write' | 'admin',
              giveFullHistory: input.giveFullHistory,
              ...(input.wrap !== undefined && { wrap: input.wrap }),
              ...(input.rotation !== undefined && { rotation: input.rotation }),
              ...(input.expectedEpoch !== undefined && { expectedEpoch: input.expectedEpoch }),
            },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: invalidateMemberAndBudget(queryClient),
    onSettled: refetchKeyChainOnSettle(queryClient),
  });
}

interface RemoveMemberVariables {
  conversationId: string;
  memberId: string;
  rotation: StreamChatRotation;
}

type RemoveMemberResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['members'][':memberId']['remove']['$post'],
  200
>;

export function useRemoveMember(): UseMutationResult<
  RemoveMemberResponse,
  Error,
  RemoveMemberVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RemoveMemberVariables) =>
      fetchJson(
        client.conversations[':conversationId'].members[':memberId'].remove.$post(
          {
            param: { conversationId: input.conversationId, memberId: input.memberId },
            json: { rotation: input.rotation },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: invalidateMemberAndBudget(queryClient),
    onSettled: refetchKeyChainOnSettle(queryClient),
  });
}

interface ChangePrivilegeVariables {
  conversationId: string;
  memberId: string;
  privilege: string;
}

type ChangePrivilegeResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['member'][':memberId']['privilege']['$patch'],
  200
>;

export function useChangePrivilege(): UseMutationResult<
  ChangePrivilegeResponse,
  Error,
  ChangePrivilegeVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ChangePrivilegeVariables) =>
      fetchJson(
        client.conversations[':conversationId'].member[':memberId'].privilege.$patch(
          {
            param: { conversationId: input.conversationId, memberId: input.memberId },
            json: { privilege: input.privilege as 'read' | 'write' | 'admin' | 'owner' },
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: invalidateMemberAndBudget(queryClient),
  });
}

interface LeaveConversationVariables {
  conversationId: string;
}

type LeaveConversationResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['leave']['$post'],
  200
>;

export function useLeaveConversation(): UseMutationResult<
  LeaveConversationResponse,
  Error,
  LeaveConversationVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: LeaveConversationVariables) =>
      fetchJson(
        client.conversations[':conversationId'].leave.$post(
          {
            param: { conversationId: input.conversationId },
            json: {},
          },
          idempotentHeaders(input)
        )
      ),
    onSuccess: (_data, variables) => {
      // Fire-and-forget: the leave modal auto-closes only after mutateAsync
      // resolves, so awaiting this refetch would keep the modal open until the
      // list settles and, under load, past its close timeout. The modal is
      // owned by the stable LeaveConversationProvider, which stays mounted while
      // the refetch drops the left row in the background — nothing after the
      // leave depends on the list being current.
      void queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
      queryClient.removeQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: memberKeys.list(variables.conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: budgetKeys.conversation(variables.conversationId),
      });
    },
  });
}

interface RotateEpochVariables {
  conversationId: string;
  rotation: StreamChatRotation;
  /** Set only by a recovery: the epoch whose keys verified, below the current one. */
  predecessorEpoch?: number;
}

type RotateEpochResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['epochs']['$post'],
  200
>;

/**
 * The standalone rotation that epoch maintenance submits. Whatever the server
 * answers — rotated, already rotated by someone else, or refused — the keychain
 * held here may now be behind it, so it is refetched and verified again.
 */
export function useRotateEpoch(): UseMutationResult<
  RotateEpochResponse,
  Error,
  RotateEpochVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: RotateEpochVariables) =>
      fetchJson(
        client.conversations[':conversationId'].epochs.$post(
          {
            param: { conversationId: input.conversationId },
            json: {
              ...input.rotation,
              ...(input.predecessorEpoch !== undefined && {
                predecessorEpoch: input.predecessorEpoch,
              }),
            },
          },
          idempotentHeaders(input)
        )
      ),
    onSettled: refetchKeyChainOnSettle(queryClient),
  });
}

interface AcceptMembershipVariables {
  conversationId: string;
}

type AcceptMembershipResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['membership']['accept']['$patch'],
  200
>;

export function useAcceptMembership(): UseMutationResult<
  AcceptMembershipResponse,
  Error,
  AcceptMembershipVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    meta: idempotencyExempt('naturally-idempotent'),
    mutationFn: ({ conversationId }: AcceptMembershipVariables) =>
      fetchJson(
        client.conversations[':conversationId'].membership.accept.$patch({
          param: { conversationId },
        })
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
    },
  });
}

interface DeclineInvitationVariables {
  conversationId: string;
}

type DeclineInvitationResponse = InferResponseType<
  (typeof client.conversations)[':conversationId']['membership']['decline']['$post'],
  200
>;

/**
 * Decline a pending invitation. Server-side this requires `acceptedAt IS NULL`
 * — once the user has accepted, declining is no longer valid and they must
 * `leaveConversation`. The inbox UI only shows the
 * decline button while the invite is pending, so this path is reached from
 * exactly one place.
 */
export function useDeclineInvitation(): UseMutationResult<
  DeclineInvitationResponse,
  Error,
  DeclineInvitationVariables
> {
  const queryClient = useQueryClient();

  return useMutation({
    meta: idempotencyExempt('naturally-idempotent'),
    mutationFn: ({ conversationId }: DeclineInvitationVariables) =>
      fetchJson(
        client.conversations[':conversationId'].membership.decline.$post({
          param: { conversationId },
        })
      ),
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: chatKeys.conversations(),
      });
      queryClient.removeQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
    },
  });
}
