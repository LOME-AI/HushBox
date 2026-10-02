import { client, fetchJson } from '@/lib/api-client';
import type { InferResponseType } from 'hono/client';

export const authKeys = {
  all: ['auth'] as const,
  me: (): readonly ['auth', 'me'] => [...authKeys.all, 'me'] as const,
};

export const accountKeys = {
  all: ['account'] as const,
  instructions: (): readonly ['account', 'instructions'] =>
    [...accountKeys.all, 'instructions'] as const,
};

/** The `/me` bootstrap payload, taken from the route definition. */
export type MeResponse = InferResponseType<typeof client.auth.me.$get, 200>;

/** The stored custom-instructions ciphertext, taken from the route definition. */
type InstructionsResponse = InferResponseType<typeof client.account.instructions.$get, 200>;

/**
 * Canonical query for the current user (`GET /api/auth/me`).
 *
 * Consumed imperatively via `queryClient.fetchQuery` during auth bootstrap
 * (`restoreSession`, `finalizeLoginWithKey`) so the request inherits the
 * app-wide retry policy (`query-provider` defaults) instead of being a one-off
 * `fetchJson` that silently skipped retries — the gap that let a transient
 * `/me` blip on reload bounce an authenticated user to the login screen.
 */
export function meQueryOptions(): {
  queryKey: readonly ['auth', 'me'];
  queryFn: () => Promise<MeResponse>;
} {
  return {
    queryKey: authKeys.me(),
    queryFn: () => fetchJson(client.auth.me.$get()),
  };
}

/**
 * Canonical query for the stored custom-instructions ciphertext
 * (`GET /api/account/instructions`).
 *
 * The account slice owns the instructions table, so `/me` deliberately does not
 * carry the blob and the client reads it from the owning slice's own route.
 * Routed through the query client for the same retry policy `/me` gets, because
 * both are bootstrap reads.
 */
export function instructionsQueryOptions(): {
  queryKey: readonly ['account', 'instructions'];
  queryFn: () => Promise<InstructionsResponse>;
} {
  return {
    queryKey: accountKeys.instructions(),
    queryFn: () => fetchJson(client.account.instructions.$get()),
  };
}
