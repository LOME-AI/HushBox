import { useMutation, type UseMutationResult } from '@tanstack/react-query';
import { client, fetchJson } from '@/lib/api-client';
import { idempotencyExempt } from '@/lib/api/idempotent-mutation.js';

interface DeleteAccountInitRequest {
  ke1: number[];
}

interface DeleteAccountInitResponse {
  ke2: number[];
  deleteAccountSessionId: string;
}

interface DeleteAccountFinishRequest {
  ke3: number[];
  totpCode?: string;
  confirmationPhrase: string;
  deleteAccountSessionId: string;
  /** NanoUSD wire string: the purchased balance the user saw and acknowledged as forfeited. */
  acknowledgedForfeitNanoUsd?: string;
}

export function useDeleteAccountInit(): UseMutationResult<
  DeleteAccountInitResponse,
  Error,
  DeleteAccountInitRequest
> {
  return useMutation({
    meta: idempotencyExempt('opaque-protocol'),
    mutationFn: async (body: DeleteAccountInitRequest): Promise<DeleteAccountInitResponse> => {
      return fetchJson(client.auth.account.delete.init.$post({ json: body }));
    },
  });
}

export function useDeleteAccountFinish(): UseMutationResult<
  void,
  Error,
  DeleteAccountFinishRequest
> {
  return useMutation({
    meta: idempotencyExempt('opaque-protocol'),
    mutationFn: async (body: DeleteAccountFinishRequest): Promise<void> => {
      const json: DeleteAccountFinishRequest = {
        ke3: body.ke3,
        confirmationPhrase: body.confirmationPhrase,
        deleteAccountSessionId: body.deleteAccountSessionId,
      };
      if (body.totpCode !== undefined) {
        json.totpCode = body.totpCode;
      }
      if (body.acknowledgedForfeitNanoUsd !== undefined) {
        json.acknowledgedForfeitNanoUsd = body.acknowledgedForfeitNanoUsd;
      }
      await fetchJson<unknown>(client.auth.account.delete.finish.$post({ json }));
    },
  });
}
