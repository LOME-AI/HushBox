import { hc } from 'hono/client';
import { describe, expectTypeOf, it } from 'vitest';
import type { createIdentityManifest } from './routes.js';
import type { ErrorResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { JSONParsed } from 'hono/utils/types';

/**
 * The identity slice's typed-client contract. This pin fails as a typecheck error
 * the moment the slice's refusal responder reverts to a bare `Response`, which
 * lands at hono's whole `StatusCode` and leaves every refusal body information-free.
 *
 * The client is constructed purely as a `typeof` anchor for `InferResponseType`;
 * no request is made, so the base URL is never dereferenced.
 */
const _typeClient = hc<ReturnType<typeof createIdentityManifest>['routes']>('http://demo.invalid');

describe('identity route response types', () => {
  it('infers the session-read refusal body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.me.$get, 503>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });

  // The auth flows refuse through their own ts-pattern arms rather than the
  // domain-error responder, so they carry a second responder to keep typed.
  it('infers the login refusal body from the ts-pattern arms', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.login.finish.$post, 401>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });

  it('infers the rate-limit refusal body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.login.init.$post, 429>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });
});
