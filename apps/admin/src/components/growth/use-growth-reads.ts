import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import {
  adminOpReadResultSchema,
  growthCampaignsReadSchema,
  growthEventsReadSchema,
  growthFreshnessReadSchema,
  growthFunnelReadSchema,
  growthMarketingReadSchema,
  growthReachReadSchema,
  growthSourcesReadSchema,
  type GrowthCampaignsRead,
  type GrowthEventsRead,
  type GrowthFreshnessRead,
  type GrowthFunnelRead,
  type GrowthGrain,
  type GrowthMarketingRead,
  type GrowthReachRead,
  type GrowthSourcesRead,
} from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';
import type { z } from 'zod';

/** The half-open window every windowed read takes, as the wire carries it. */
export interface GrowthWindow {
  readonly from: string;
  readonly to: string;
}

export const growthKeys = {
  all: ['admin', 'growth'] as const,
  funnel: (window: GrowthWindow, campaign?: string) =>
    ['admin', 'growth', 'funnel', window.from, window.to, campaign ?? null] as const,
  marketing: (window: GrowthWindow, grain: GrowthGrain) =>
    ['admin', 'growth', 'marketing', window.from, window.to, grain] as const,
  sources: (window: GrowthWindow) =>
    ['admin', 'growth', 'sources', window.from, window.to] as const,
  campaigns: () => ['admin', 'growth', 'campaigns'] as const,
  freshness: () => ['admin', 'growth', 'freshness'] as const,
  events: (window: GrowthWindow, campaign: string | undefined, page: number) =>
    ['admin', 'growth', 'events', window.from, window.to, campaign ?? null, page] as const,
  reach: (window: GrowthWindow) => ['admin', 'growth', 'reach', window.from, window.to] as const,
};

/**
 * Read operations are volume-capped against the same per-actor hourly budget
 * preview and execute spend, and a load costs one for each distinct query key
 * the screen mounts. So the cache is refreshed only when the reader asks:
 * nothing polls, nothing refetches on focus or reconnect, and the screen's
 * refresh control is the one way a second round is spent.
 */
const READ_QUERY_OPTIONS = {
  staleTime: Number.POSITIVE_INFINITY,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false,
  refetchInterval: false,
} as const;

/**
 * One registered read, run through the operation route the plane exposes for
 * every op. The envelope is parsed before the payload: its `kind` literal is
 * what separates a read's result from a mutation's, so a contract that stopped
 * being a read fails here rather than rendering a mutation's effect list as
 * panels.
 */
async function runGrowthRead<T>(
  name: string,
  input: Record<string, unknown>,
  schema: z.ZodType<T>
): Promise<T> {
  const raw = await fetchJson<unknown>(
    client.admin.ops[':name'].execute.$post({ param: { name }, json: { input } })
  );
  return schema.parse(adminOpReadResultSchema.parse(raw).data);
}

export function useGrowthFunnel(
  window: GrowthWindow,
  campaign?: string
): UseQueryResult<GrowthFunnelRead> {
  return useQuery({
    queryKey: growthKeys.funnel(window, campaign),
    queryFn: () =>
      runGrowthRead(
        'growth.funnel.read',
        { ...window, ...(campaign === undefined ? {} : { campaign }) },
        growthFunnelReadSchema
      ),
    ...READ_QUERY_OPTIONS,
  });
}

export function useGrowthMarketing(
  window: GrowthWindow,
  grain: GrowthGrain
): UseQueryResult<GrowthMarketingRead> {
  return useQuery({
    queryKey: growthKeys.marketing(window, grain),
    queryFn: () =>
      runGrowthRead('growth.marketing.read', { ...window, grain }, growthMarketingReadSchema),
    ...READ_QUERY_OPTIONS,
  });
}

export function useGrowthSources(window: GrowthWindow): UseQueryResult<GrowthSourcesRead> {
  return useQuery({
    queryKey: growthKeys.sources(window),
    queryFn: () => runGrowthRead('growth.sources.read', { ...window }, growthSourcesReadSchema),
    ...READ_QUERY_OPTIONS,
  });
}

export function useGrowthCampaigns(): UseQueryResult<GrowthCampaignsRead> {
  return useQuery({
    queryKey: growthKeys.campaigns(),
    queryFn: () => runGrowthRead('growth.campaigns.read', {}, growthCampaignsReadSchema),
    ...READ_QUERY_OPTIONS,
  });
}

/**
 * How current the growth data is. It is keyed and read with no window and no
 * campaign, so no control on the page can move what it answers — which is the
 * whole reason it is a read of its own rather than a maximum over the panels.
 */
export function useGrowthFreshness(): UseQueryResult<GrowthFreshnessRead> {
  return useQuery({
    queryKey: growthKeys.freshness(),
    queryFn: () => runGrowthRead('growth.freshness.read', {}, growthFreshnessReadSchema),
    ...READ_QUERY_OPTIONS,
  });
}

export function useGrowthEvents(
  window: GrowthWindow,
  campaign: string | undefined,
  page: number
): UseQueryResult<GrowthEventsRead> {
  return useQuery({
    queryKey: growthKeys.events(window, campaign, page),
    queryFn: () =>
      runGrowthRead(
        'growth.events.read',
        { ...window, ...(campaign === undefined ? {} : { campaign }), page },
        growthEventsReadSchema
      ),
    ...READ_QUERY_OPTIONS,
  });
}

export function useGrowthReach(window: GrowthWindow): UseQueryResult<GrowthReachRead> {
  return useQuery({
    queryKey: growthKeys.reach(window),
    queryFn: () => runGrowthRead('growth.reach.read', { ...window }, growthReachReadSchema),
    ...READ_QUERY_OPTIONS,
  });
}
