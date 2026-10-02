import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { utcDayKey } from '@hushbox/shared';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { validateInferenceCall } from './inference-boundary.js';
import type { InferenceRequest, ModelDescriptor } from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);
const FIXTURE_UTC_DAY = utcDayKey(new Date(TEST_DAY_START));

function testDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'google/imagen-4.0-generate-001',
    provider: 'google',
    version: '1',
    inputs: ['text'],
    outputs: ['image'],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
    ...overrides,
  };
}

function testRequest(overrides: Partial<InferenceRequest> = {}): InferenceRequest {
  return {
    model: 'google/imagen-4.0-generate-001',
    inputs: [{ modality: 'text', text: 'A red fox' }],
    parameters: {},
    outputs: ['image'],
    utcDay: FIXTURE_UTC_DAY,
    ...overrides,
  };
}

describe('validateInferenceCall', () => {
  it('accepts a matching ZDR-reachable descriptor', () => {
    expect(() => {
      validateInferenceCall(testRequest(), testDescriptor());
    }).not.toThrow();
  });

  it('rejects a request whose model differs from the descriptor', () => {
    expect(() => {
      validateInferenceCall(testRequest({ model: 'google/other' }), testDescriptor());
    }).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });

  it('refuses a ZDR-unreachable descriptor fail-closed', () => {
    expect(() => {
      validateInferenceCall(testRequest(), testDescriptor({ zdrReachable: false }));
    }).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });
});
