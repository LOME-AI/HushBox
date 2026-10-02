import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useInitiatePayment } from '@/hooks/billing/billing.js';
import { dispatchCountFor, dispatchFailuresFor } from '@/lib/api/idempotent-mutation.js';
import type { ReactNode } from 'react';

/**
 * The charge mutation dispatches exactly one request per attempt, and both
 * numbers `components/billing/payment-form.tsx` reads to tell a refused payer
 * nothing was charged track it.
 *
 * That form says "nothing was charged" only where every request it dispatched
 * came back refused before the handler ran, and it counts those two things
 * through `dispatchCountFor` and `dispatchFailuresFor`. The correspondence
 * between them and the requests actually put on the wire is a property of this
 * hook, not of TanStack: a pre-flight call, or a retry loop inside
 * `mutationFn`, would dispatch a request that neither counter saw — one that
 * could have reached the processor — and the form would keep saying "not
 * charged" while offering a re-submit under a fresh idempotency key the server
 * cannot dedup against the lost one.
 *
 * So the assertion is the correspondence, not a bare count. The spy sits on
 * `globalThis.fetch`, below `fetchJson` and `customFetch`, so a second request
 * added at any depth under `mutationFn` reds these.
 *
 * What it does NOT catch: a request the CALLER issues around `mutate()` — this
 * renders the hook alone, not the form; anything the card tokenizer sends,
 * which never enters this process; and a dispatch through a transport that is
 * not `globalThis.fetch`.
 */

interface ChargeInput {
  amountNanoUsd: string;
  cardToken: string;
  customerCode: string;
}

/**
 * One logical charge. Built per call because both counters are keyed on the
 * variables reference, which is what makes them per-`mutate()` rather than
 * per-process.
 */
function newCharge(): ChargeInput {
  return {
    amountNanoUsd: '5000000000',
    cardToken: 'card-token',
    customerCode: 'customer-code',
  };
}

function clientWith(retry: number | false): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry, retryDelay: 0 },
    },
  });
}

function wrapperFor(
  queryClient: QueryClient
): ({ children }: { children: ReactNode }) => ReactNode {
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'ChargeDispatchWrapper';
  return Wrapper;
}

async function refuseCharge(
  retry: number | false
): Promise<{ requests: number; dispatches: number; failures: number }> {
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ code: 'RATE_LIMITED' }, { status: 429 }));
  const charge = newCharge();
  const { result } = renderHook(() => useInitiatePayment(), {
    wrapper: wrapperFor(clientWith(retry)),
  });

  result.current.mutate(charge);
  await waitFor(() => {
    expect(result.current.isError).toBe(true);
  });

  return {
    requests: fetchSpy.mock.calls.length,
    dispatches: dispatchCountFor(charge),
    failures: dispatchFailuresFor(charge).length,
  };
}

describe('useInitiatePayment request dispatch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts one dispatch and one recorded failure for a single refused attempt', async () => {
    const { requests, dispatches, failures } = await refuseCharge(false);

    expect(requests).toBe(1);
    expect(dispatches).toBe(1);
    expect(failures).toBe(1);
  });

  it('counts one of each per attempt when the charge is retried', async () => {
    const { requests, dispatches, failures } = await refuseCharge(1);

    expect(requests).toBe(2);
    expect(dispatches).toBe(2);
    expect(failures).toBe(2);
  });
});
