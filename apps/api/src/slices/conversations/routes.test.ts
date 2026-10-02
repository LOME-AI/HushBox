import { hc } from 'hono/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { requiredIdempotencyKey } from './routes/handler-tail.js';
import type { createConversationsManifest } from './routes.js';
import type { Context } from 'hono';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { ErrorResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { JSONParsed } from 'hono/utils/types';

function contextWithHeader(value?: string): Context<AppEnv> {
  return { req: { header: () => value } } as unknown as Context<AppEnv>;
}

describe('requiredIdempotencyKey', () => {
  it('reads the header the pipeline stage already enforced', () => {
    expect(requiredIdempotencyKey(contextWithHeader('key-1'))).toBe('key-1');
  });

  it('treats an absent header behind the pipeline as a defect', () => {
    expect(() => requiredIdempotencyKey(contextWithHeader())).toThrow(
      /idempotency key missing after the pipeline stage/
    );
  });
});

/**
 * The conversations slice's typed-client contract. These pins fail as a typecheck
 * error the moment a refusal responder reverts to a bare `Response`.
 *
 * The client is constructed purely as a `typeof` anchor for `InferResponseType`;
 * no request is made, so the base URL is never dereferenced.
 */
const _typeClient =
  hc<ReturnType<typeof createConversationsManifest>['routes']>('http://demo.invalid');

describe('conversations route response types', () => {
  it('infers the conversation-list refusal body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.index.$get, 404>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });

  it('infers the caller-resolution refusal body on a guest-reachable read', () => {
    expectTypeOf<
      InferResponseType<(typeof _typeClient)[':conversationId']['$get'], 401>
    >().toEqualTypeOf<JSONParsed<ErrorResponse>>();
  });

  /**
   * A caller-resolution helper annotated with bare `Response` lands at hono's whole
   * `StatusCode`, so its information-free `{}` unions into every status query —
   * the success one included. Widening the helper again fails here, on the 200 leg.
   */
  it('keeps the guest-reachable read 200 body free of the refusal legs', () => {
    expectTypeOf<
      InferResponseType<(typeof _typeClient)[':conversationId']['$get'], 200>
    >().toHaveProperty('conversation');
  });
});
