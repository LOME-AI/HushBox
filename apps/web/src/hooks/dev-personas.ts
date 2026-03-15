import { useQuery } from '@tanstack/react-query';
import type { DevPersonasResponse } from '@hushbox/shared';
import { client, fetchJson } from '../lib/api-client.js';
import { env } from '../lib/env.js';

export type PersonaType = 'dev' | 'test';

export const devPersonaKeys = {
  all: ['dev-personas'] as const,
  list: (type: PersonaType = 'dev') => [...devPersonaKeys.all, 'list', type] as const,
};

export function useDevPersonas(
  type: PersonaType = 'dev'
): ReturnType<typeof useQuery<DevPersonasResponse, Error>> {
  return useQuery({
    queryKey: devPersonaKeys.list(type),
    queryFn: (): Promise<DevPersonasResponse> =>
      fetchJson<DevPersonasResponse>(client.api.dev.personas.$get({ query: { type } })),
    enabled: env.isDev,
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 5000),
  });
}
