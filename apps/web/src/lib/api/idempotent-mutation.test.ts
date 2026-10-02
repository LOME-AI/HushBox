import { describe, it, expect } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';

import {
  MUTATION_IDEMPOTENCY_EXEMPTIONS,
  idempotencyExempt,
  idempotencyKeyFor,
  idempotentHeaders,
  markRequestKeyed,
  wasRequestKeyed,
  dispatchCountFor,
  dispatchFailuresFor,
  recordDispatchFailure,
} from '@/lib/api/idempotent-mutation.js';

function createWrapper(client: QueryClient): ({ children }: { children: ReactNode }) => ReactNode {
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): React.JSX.Element {
    return createElement(QueryClientProvider, { client }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('idempotencyKeyFor', () => {
  it('returns the same key for the same variables reference', () => {
    const variables = { conversationId: 'conv-1' };
    expect(idempotencyKeyFor(variables)).toBe(idempotencyKeyFor(variables));
  });

  it('returns different keys for distinct variables objects', () => {
    expect(idempotencyKeyFor({ conversationId: 'conv-1' })).not.toBe(
      idempotencyKeyFor({ conversationId: 'conv-1' })
    );
  });
});

describe('idempotentHeaders', () => {
  it('wraps the key in a per-call headers object', () => {
    const variables = { conversationId: 'conv-1' };
    expect(idempotentHeaders(variables)).toEqual({
      headers: { 'Idempotency-Key': idempotencyKeyFor(variables) },
    });
  });
});

describe('markRequestKeyed', () => {
  it('reports a response whose request carried the key', () => {
    expect(wasRequestKeyed(markRequestKeyed(new Response(), true))).toBe(true);
  });

  it('reports a response whose request carried no key', () => {
    expect(wasRequestKeyed(markRequestKeyed(new Response(), false))).toBe(false);
  });

  it('reports a response no fetch wrapper recorded', () => {
    expect(wasRequestKeyed(new Response())).toBe(false);
  });

  it('returns the response it recorded, so a wrapper can record in return position', () => {
    const response = new Response();
    expect(markRequestKeyed(response, true)).toBe(response);
  });
});

describe('idempotencyExempt', () => {
  it('carries the declared class as mutation meta', () => {
    expect(idempotencyExempt('naturally-idempotent')).toEqual({
      idempotencyExemption: 'naturally-idempotent',
    });
  });

  it('accepts every class in the closed set', () => {
    for (const exemption of MUTATION_IDEMPOTENCY_EXEMPTIONS) {
      expect(idempotencyExempt(exemption).idempotencyExemption).toBe(exemption);
    }
  });

  it('accepts a single-use token standing in for the key', () => {
    expect(idempotencyExempt('token-is-key')).toEqual({ idempotencyExemption: 'token-is-key' });
  });

  it('throws where an unknown class is declared rather than exempting silently', () => {
    // The compiler already refuses this; the cast stands in for the untyped
    // call site or `as` that would otherwise reach the runtime unchecked.
    const unknownClass =
      'webhook-event-id' as unknown as (typeof MUTATION_IDEMPOTENCY_EXEMPTIONS)[number];
    expect(() => idempotencyExempt(unknownClass)).toThrow('unknown exemption class');
  });
});

describe('reuse across a retried mutation', () => {
  it('sends the SAME key on a mutation that fails once then succeeds', async () => {
    const keysSeen: string[] = [];
    let attempts = 0;
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: 1, retryDelay: 0 } },
    });

    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: (variables: { conversationId: string }): Promise<string> => {
            attempts += 1;
            keysSeen.push(idempotencyKeyFor(variables));
            if (attempts === 1) return Promise.reject(new Error('transient'));
            return Promise.resolve('ok');
          },
        }),
      { wrapper: createWrapper(queryClient) }
    );

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'conv-1' });
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(keysSeen).toHaveLength(2);
    expect(keysSeen[0]).toBe(keysSeen[1]);
  });
});

describe('what one logical mutation dispatched', () => {
  it('counts one dispatch per outgoing request its key is authored for', () => {
    const variables = { conversationId: 'conv-1' };
    idempotentHeaders(variables);
    idempotentHeaders(variables);
    expect(dispatchCountFor(variables)).toBe(2);
  });

  it('counts nothing for a mutation that has authored no request', () => {
    expect(dispatchCountFor({ conversationId: 'conv-1' })).toBe(0);
  });

  it('counts each logical mutation separately', () => {
    const first = { conversationId: 'conv-1' };
    const second = { conversationId: 'conv-1' };
    idempotentHeaders(first);
    expect(dispatchCountFor(second)).toBe(0);
  });

  it('reads back what each dispatch came back with, in dispatch order', () => {
    const variables = { conversationId: 'conv-1' };
    const first = new Error('first');
    const second = new Error('second');
    recordDispatchFailure(variables, first);
    recordDispatchFailure(variables, second);
    expect(dispatchFailuresFor(variables)).toEqual([first, second]);
  });

  it('reports no failures for a mutation that recorded none', () => {
    expect(dispatchFailuresFor({ conversationId: 'conv-1' })).toEqual([]);
  });
});
