import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client';
import { chatKeys } from './chat';
import type { ForkResponse, ConversationResponse } from '@/lib/api';

export const forkKeys = {
  forConversation: (conversationId: string) => ['forks', conversationId] as const,
};

export function useForks(
  conversationId: string
): ReturnType<typeof useQuery<ForkResponse[], Error>> {
  return useQuery({
    queryKey: [...chatKeys.conversation(conversationId), 'forks'] as const,
    queryFn: async (): Promise<ForkResponse[]> => {
      const response = await fetchJson<ConversationResponse>(
        client.api.conversations[':conversationId'].$get({ param: { conversationId } })
      );
      return response.forks;
    },
    enabled: !!conversationId,
  });
}

interface CreateForkParams {
  id: string;
  conversationId: string;
  fromMessageId: string;
  name?: string;
}

interface CreateForkResult {
  forks: ForkResponse[];
}

export function useCreateFork(): ReturnType<
  typeof useMutation<CreateForkResult, Error, CreateForkParams>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: CreateForkParams): Promise<CreateForkResult> => {
      const { conversationId, ...body } = params;
      return fetchJson<CreateForkResult>(
        client.api.forks[':conversationId'].$post({
          param: { conversationId },
          json: body,
        })
      );
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
    },
  });
}

interface DeleteForkParams {
  conversationId: string;
  forkId: string;
}

export function useDeleteFork(): ReturnType<typeof useMutation<unknown, Error, DeleteForkParams>> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: DeleteForkParams): Promise<unknown> => {
      return fetchJson(
        client.api.forks[':conversationId'][':forkId'].$delete({
          param: { conversationId: params.conversationId, forkId: params.forkId },
        })
      );
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({
        queryKey: chatKeys.conversation(variables.conversationId),
      });
      void queryClient.invalidateQueries({
        queryKey: chatKeys.messages(variables.conversationId),
      });
    },
  });
}

interface RenameForkParams {
  conversationId: string;
  forkId: string;
  name: string;
}

interface RenameForkResult {
  fork: ForkResponse;
}

export function useRenameFork(): ReturnType<
  typeof useMutation<RenameForkResult, Error, RenameForkParams>
> {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: RenameForkParams): Promise<RenameForkResult> => {
      return fetchJson<RenameForkResult>(
        client.api.forks[':conversationId'][':forkId'].$patch({
          param: { conversationId: params.conversationId, forkId: params.forkId },
          json: { name: params.name },
        })
      );
    },
    onSuccess: (_data, variables) => {
      queryClient.setQueryData<ForkResponse[]>(
        [...chatKeys.conversation(variables.conversationId), 'forks'],
        (old) =>
          old?.map((f) =>
            f.id === variables.forkId ? { ...f, name: variables.name } : f
          )
      );
    },
  });
}

export { type ForkResponse } from '@/lib/api';
