import { hc } from 'hono/client';
import { describe, expectTypeOf, it } from 'vitest';
import type { createAccountManifest } from './routes.js';
import type { ErrorResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { JSONParsed } from 'hono/utils/types';

/**
 * The account slice's typed-client contract. This pin fails as a typecheck error
 * the moment the slice's refusal responder reverts to a bare `Response`, which
 * lands at hono's whole `StatusCode` and leaves every refusal body information-free.
 *
 * The client is constructed purely as a `typeof` anchor for `InferResponseType`;
 * no request is made, so the base URL is never dereferenced.
 */
const _typeClient = hc<ReturnType<typeof createAccountManifest>['routes']>('http://demo.invalid');

describe('account route response types', () => {
  it('infers the user-search refusal body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.users.search.$get, 503>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });
});
