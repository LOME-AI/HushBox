import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  MAX_SELECTED_MODELS,
  VALUE_STORE_BYTE_BUDGET_BYTES,
  WorkflowDefinition,
} from '@hushbox/shared';
import { perImagePricingFixture, perSecondPricingFixture } from '@hushbox/shared/pricing-fixture';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { withStorageFees } from '../../../chat/domain/settlement/settlement.js';
import { createValueStore } from '../../../workflows/domain/engine/value-store.js';
import { createEstimateRun } from './estimate-run.js';
import type { MediaValue, ModelDescriptor, SettlementRequest } from '@hushbox/shared';

/** One generated artifact: what it is and the bytes its stored ciphertext occupies. */
interface MediaArtifact {
  readonly modality: 'image' | 'video';
  readonly byteLength: number;
}

/**
 * `mediaArtifactsArb`: one artifact per generating sibling, each at any size up
 * to the value store's own budget, with the budget itself and sizes just under
 * it drawn on purpose, so draws both fit the store and overflow it. It is sized
 * by the store rather than by the reservation's bound, so a bound below what the
 * store admits is a counterexample rather than a size never drawn.
 */
const mediaArtifactsArb: fc.Arbitrary<readonly MediaArtifact[]> = fc.array(
  fc.record({
    modality: fc.constantFrom('image' as const, 'video' as const),
    byteLength: fc.oneof(
      fc.nat({ max: VALUE_STORE_BYTE_BUDGET_BYTES }),
      fc.integer({ min: VALUE_STORE_BYTE_BUDGET_BYTES - 1000, max: VALUE_STORE_BYTE_BUDGET_BYTES }),
      fc.constant(VALUE_STORE_BYTE_BUDGET_BYTES)
    ),
  }),
  { minLength: 1, maxLength: MAX_SELECTED_MODELS }
);

/** `promptCharsArb`: the new message's characters, which both sides store once. */
const promptCharsArb = fc.nat({ max: 100_000 });

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

function mediaDescriptor(
  id: string,
  outputs: readonly ('image' | 'video')[],
  pricing: ModelDescriptor['pricing']
): ModelDescriptor {
  return {
    id,
    provider: 'openrouter',
    version: '1',
    inputs: ['text'],
    outputs: [...outputs],
    parameters: {},
    behaviors: [],
    limits: {},
    pricing,
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
  };
}

const IMAGE = mediaDescriptor(
  'img',
  ['image'],
  perImagePricingFixture({ anchor: 40_000_000n, dearest: 40_000_000n })
);
const VIDEO = mediaDescriptor(
  'vid',
  ['video'],
  perSecondPricingFixture({ anchor: { '720p': 98_800_000n }, dearest: { '720p': 98_800_000n } })
);

function resolve(id: string): ModelDescriptor | undefined {
  return [IMAGE, VIDEO].find((descriptor) => descriptor.id === id);
}

function nodeIdOf(index: number): string {
  return `m${String(index)}`;
}

/** A persisting turn with one media sibling per artifact, each a sink. */
function turnOf(artifacts: readonly MediaArtifact[], inputChars: number): WorkflowDefinition {
  return WorkflowDefinition.parse({
    version: 1,
    deadlineClass: 'media',
    hooks: { admission: 'chat', settlement: 'chat' },
    nodes: artifacts.map((artifact, index) => ({
      id: nodeIdOf(index),
      version: 1,
      out: 'out',
      type: 'modelCall',
      model: artifact.modality === 'image' ? IMAGE.id : VIDEO.id,
      params: artifact.modality === 'image' ? {} : { resolution: '720p', durationSeconds: 4 },
      in: { node: 'input', port: 'prompt' },
    })),
    edges: [],
    storage: { inputChars },
  });
}

function mediaValueOf(artifact: MediaArtifact, index: number): MediaValue {
  return {
    ref: `media/c/m/${String(index)}`,
    mimeType: artifact.modality === 'image' ? 'image/png' : 'video/mp4',
    modality: artifact.modality,
    byteLength: artifact.byteLength,
    metadata: {},
  };
}

/**
 * What settlement bills for storage when the run keeps exactly the artifacts its
 * value store admits: one charge per kept artifact, the prompt stored once.
 */
function billedStorageNanoUsd(artifacts: readonly MediaArtifact[], inputChars: number): bigint {
  const store = createValueStore();
  const outputs: Record<string, { readonly kind: 'media'; readonly value: MediaValue }> = {};
  for (const [index, artifact] of artifacts.entries()) {
    const output = { kind: 'media' as const, value: mediaValueOf(artifact, index) };
    if (store.store(output).isOk()) outputs[nodeIdOf(index)] = output;
  }
  const request: SettlementRequest = {
    runKey: 'k',
    outputs,
    charges: Object.keys(outputs).map((key) => ({
      key,
      modelId: 'm',
      providerName: 'p',
      modality: 'image',
      billableCostNanoUsd: 1n,
      isEstimated: false,
    })),
  };
  let total = 0n;
  for (const charge of withStorageFees(request, inputChars)) {
    if (charge.storageFeeNanoUsd === undefined) throw new Error('settlement attached no fee');
    total += charge.storageFeeNanoUsd;
  }
  return total;
}

describe('a media run reserves every storage byte its value store can admit', () => {
  it('bills no more storage than the hold reserved, over any artifacts the store admits', () => {
    const reserve = createEstimateRun(resolve);
    fc.assert(
      fc.property(mediaArtifactsArb, promptCharsArb, (artifacts, inputChars) => {
        const reservation = reserve(turnOf(artifacts, inputChars))._unsafeUnwrap();
        const reserved = reservation.calls.reduce((total, call) => total + call.storageNanoUsd, 0n);

        expect(billedStorageNanoUsd(artifacts, inputChars)).toBeLessThanOrEqual(reserved);
      })
    );
  });
});
