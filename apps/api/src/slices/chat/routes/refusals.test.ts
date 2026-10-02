import { describe, expect, it } from 'vitest';
import { HOUR_MS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { ERROR_CODES } from '@hushbox/shared';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { rateLimitRejection, respondRunStart, trialGateRejection } from './refusals.js';
import type { Modality, ModelDescriptor } from '@hushbox/shared';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { Context } from 'hono';

/** Well outside the premium recency window, so the eligibility legs never fire. */
const PRE_RECENCY_RELEASE_SECONDS = secondsAt(TEST_DAY_START - 40_000 * HOUR_MS);

function textModel(): ModelDescriptor {
  return {
    id: 'trial/cheap',
    provider: 'vendor',
    version: '1',
    inputs: ['text'] as Modality[],
    outputs: ['text'] as Modality[],
    parameters: {},
    behaviors: [],
    limits: { contextLength: 1_000_000 },
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
    zdrReachable: true,
    releasedAt: PRE_RECENCY_RELEASE_SECONDS,
    fetchedAt: 0,
  };
}

/**
 * These responders read only `c.json`, plus `c.get` and `c.set`, through which
 * the refusal tail reads the logger and records an availability refusal's
 * classification; a real `Context<AppEnv>` carries the whole request pipeline —
 * so the double is asserted, with the same justification a documented `any`
 * needs. It binds no logger, so the tail captures nothing. The assertion is what
 * keeps each case to the one responder under test instead of a served request.
 */
function jsonContext(): Context<AppEnv> {
  return {
    json: (body: unknown, status: number) => ({ body, status }),
    get: (): undefined => undefined,
    set: (): undefined => undefined,
  } as unknown as Context<AppEnv>;
}

describe('rateLimitRejection', () => {
  it('answers the typed unavailable when the reservation itself fails', async () => {
    const rejection = await rateLimitRejection(
      jsonContext(),
      // The reservation is a `ResultAsync` of the limiter's decision; the
      // failure arm needs no decision shape, so the error is asserted into the
      // parameter's type with the justification a documented `any` needs.
      errAsync(unavailableError('redis down')) as unknown as Parameters<
        typeof rateLimitRejection
      >[1]
    );

    expect(rejection).toMatchObject({ status: 503 });
  });
});

describe('trialGateRejection', () => {
  it('answers the priced gate failure rather than a verdict it could not reach', () => {
    // A negative character count is unpriceable, which is the one input that
    // makes the gate's own verdict fail instead of allowing or refusing.
    const rejection = trialGateRejection(jsonContext(), textModel(), [textModel()], -1);

    expect(rejection).toMatchObject({ status: 400 });
  });
});

describe('respondRunStart', () => {
  it('answers a refusal code the status table does not name as a conflict', async () => {
    const response = await respondRunStart(
      jsonContext(),
      // A refusal outcome carrying only its code, asserted into the port's
      // run-start result for the same reason.
      okAsync({ code: ERROR_CODES.CSRF_REJECTED }) as unknown as Parameters<
        typeof respondRunStart
      >[1],
      crypto.randomUUID()
    );

    expect(response).toMatchObject({ status: 409 });
  });
});
