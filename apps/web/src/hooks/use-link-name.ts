import { useMutation, useQueryClient } from '@tanstack/react-query';
import { client, fetchJson } from '../lib/api-client.js';

interface GuestNameInput {
  conversationId: string;
  linkPublicKey: string;
  displayName: string;
}

interface AdminNameInput {
  conversationId: string;
  linkId: string;
  displayName: string;
}

export function useGuestLinkName(): ReturnType<
  typeof useMutation<{ success: true }, Error, GuestNameInput>
> {
  return useMutation({
    mutationFn: ({ conversationId, linkPublicKey, displayName }: GuestNameInput) =>
      fetchJson<{ success: true }>(
        client.api['link-guest'].name.$patch({
          json: { conversationId, linkPublicKey, displayName },
        })
      ),
  });
}

export function useAdminLinkName(): ReturnType<
  typeof useMutation<{ success: true }, Error, AdminNameInput>
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ conversationId, linkId, displayName }: AdminNameInput) =>
      fetchJson<{ success: true }>(
        client.api.links[':conversationId'][':linkId'].name.$patch({
          param: { conversationId, linkId },
          json: { displayName },
        })
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['links'] });
    },
  });
}
