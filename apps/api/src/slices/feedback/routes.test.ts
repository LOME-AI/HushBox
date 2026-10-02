import { hc } from 'hono/client';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { requiredIdempotencyKey } from './routes.js';
import type { Context } from 'hono';
import type { createFeedbackManifest } from './routes.js';
import type { SubmitFeedbackResponse } from './domain/index.js';
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
 * The submit endpoint's typed-client contract. A bare `Response` on the refusal
 * arm lands the whole handler at hono's undiscriminated `StatusCode` and erases
 * BOTH bodies — the success one included, because the two arms union — so the
 * success pin below is what fails first when the responder regresses.
 *
 * The client is constructed purely as a `typeof` anchor for `InferResponseType`;
 * no request is made, so the base URL is never dereferenced.
 */
const _typeClient = hc<ReturnType<typeof createFeedbackManifest>['routes']>('http://demo.invalid');

describe('feedback route response types', () => {
  it('infers the submit success body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.index.$post, 200>>().toEqualTypeOf<
      JSONParsed<SubmitFeedbackResponse>
    >();
  });

  it('infers the submit refusal body', () => {
    expectTypeOf<InferResponseType<typeof _typeClient.index.$post, 503>>().toEqualTypeOf<
      JSONParsed<ErrorResponse>
    >();
  });
});
