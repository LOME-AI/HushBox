import { hc } from 'hono/client';
import { describe, expectTypeOf, it } from 'vitest';
import type { createAnnouncementsManifest } from './routes.js';
import type { ErrorResponse } from '@hushbox/shared';
import type { InferResponseType } from 'hono/client';
import type { JSONParsed } from 'hono/utils/types';

/**
 * The announcements slice's typed-client contract. This pin fails as a typecheck error
 * the moment the slice's refusal responder reverts to a bare `Response`, which
 * lands at hono's whole `StatusCode` and leaves every refusal body information-free.
 *
 * The client is constructed purely as a `typeof` anchor for `InferResponseType`;
 * no request is made, so the base URL is never dereferenced.
 */
const _typeClient =
  hc<ReturnType<typeof createAnnouncementsManifest>['routes']>('http://demo.invalid');

describe('announcements route response types', () => {
  it('infers the banner-read refusal body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.banner.$get, 503>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });
});
