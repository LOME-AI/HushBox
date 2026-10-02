import { hc } from 'hono/client';
import { describe, expectTypeOf, it } from 'vitest';
import type { createDevManifest } from './routes.js';
import type { ErrorResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { JSONParsed } from 'hono/utils/types';

/**
 * The dev slice's typed-client contract. This pin fails as a typecheck error
 * the moment the slice's refusal responder reverts to a bare `Response`, which
 * lands at hono's whole `StatusCode` and leaves every refusal body information-free.
 *
 * The client is constructed purely as a `typeof` anchor for `InferResponseType`;
 * no request is made, so the base URL is never dereferenced.
 */
const _typeClient = hc<ReturnType<typeof createDevManifest>['routes']>('http://demo.invalid');

describe('dev route response types', () => {
  it('infers the conversation-seed refusal body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.conversation.$post, 503>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });
});
