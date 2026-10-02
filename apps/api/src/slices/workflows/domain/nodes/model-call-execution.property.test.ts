import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { Node as NodeSchema, textTag } from '@hushbox/shared';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { providerUsdToBillableNanoUsd } from '../../../billing/index.js';
import { ok } from '../../../../lib/result/index.js';
import { createValueStore } from '../engine/value-store.js';
import { createModelCallExecution } from './model-call-execution.js';
import type { InferenceEvent, ModelDescriptor, Node } from '@hushbox/shared';
import type { ModelProvider } from '../../../models/index.js';
import type { EngineClock, NodeRunContext } from '../engine/execution-registry.js';

/** One provider event and the engine-clock reading while the executor handles it. */
interface TimedEvent {
  readonly atMs: number;
  readonly event: InferenceEvent;
}

/**
 * `timedInferenceEventsArb`: a stream of reasoning and answer deltas on a
 * non-decreasing integer clock, ended by the terminal finish. Each event waits
 * a whole number of milliseconds after the one before it, zero included, so
 * two events may share an instant.
 */
const timedInferenceEventsArb: fc.Arbitrary<readonly TimedEvent[]> = fc
  .tuple(
    fc.nat({ max: 10_000 }),
    fc.array(fc.record({ gapMs: fc.nat({ max: 5000 }), reasoning: fc.boolean() }), {
      maxLength: 30,
    }),
    fc.nat({ max: 5000 })
  )
  .map(([startMs, steps, finishGapMs]) => {
    const events: TimedEvent[] = [];
    let atMs = startMs;
    for (const step of steps) {
      atMs += step.gapMs;
      const event: InferenceEvent = step.reasoning
        ? { kind: 'reasoning-delta', index: 0, content: 'thinking ' }
        : { kind: 'text-delta', index: 0, content: 'answer ' };
      events.push({ atMs, event });
    }
    const finish: InferenceEvent = {
      kind: 'finish',
      metadata: { usage: { inputTokens: 3, outputTokens: 5 }, finishReason: 'stop' },
    };
    events.push({ atMs: atMs + finishGapMs, event: finish });
    return events;
  });

const DESCRIPTOR: ModelDescriptor = {
  id: 'answer-model',
  provider: 'p',
  version: '1',
  inputs: ['text'],
  outputs: ['text'],
  parameters: {},
  behaviors: [],
  limits: {},
  pricing: tokenPricingFixture({ input: 1n, output: 1n }),
  zdrReachable: true,
  releasedAt: secondsAt(TEST_DAY_START),
  fetchedAt: 0,
};

function answerNode(): Extract<Node, { type: 'modelCall' }> {
  const node = NodeSchema.parse({
    id: 'answer',
    type: 'modelCall',
    version: 1,
    out: 'out',
    model: 'answer-model',
    params: {},
    in: { node: 'input', port: 'prompt' },
  });
  if (node.type !== 'modelCall') throw new Error('the fixture is not a modelCall node');
  return node;
}

/** A scripted provider whose engine clock reads each event's `atMs` while that event is handled. */
function timedStream(events: readonly TimedEvent[]): {
  readonly provider: ModelProvider;
  readonly clock: EngineClock;
} {
  let nowMs = 0;
  return {
    clock: { now: () => nowMs },
    provider: {
      infer: () =>
        (async function* stream(): AsyncGenerator<InferenceEvent> {
          await Promise.resolve();
          for (const timed of events) {
            nowMs = timed.atMs;
            yield timed.event;
          }
        })(),
    },
  };
}

async function reasoningDurationOf(events: readonly TimedEvent[]): Promise<number | undefined> {
  const stream = timedStream(events);
  const ctx: NodeRunContext = {
    values: createValueStore(1_000_000),
    clock: stream.clock,
    rng: { random: () => 0.5 },
    signal: new AbortController().signal,
  };
  const result = await createModelCallExecution({
    provider: stream.provider,
    binding: {
      descriptor: DESCRIPTOR,
      ports: { in: [textTag()], out: textTag() },
      price: () => ok(50n),
    },
    schemas: { resolveSchema: () => undefined },
    usdToBillableNanoUsd: providerUsdToBillableNanoUsd,
  }).run(answerNode(), ['hi'], ctx);
  return result._unsafeUnwrap().billing?.reasoningDurationMs;
}

describe('the reasoning time of a streamed call', () => {
  it('is absent exactly when no reasoning delta streamed, else within the first delta to the last event', async () => {
    await fc.assert(
      fc.asyncProperty(timedInferenceEventsArb, async (events) => {
        const durationMs = await reasoningDurationOf(events);
        const firstReasoning = events.find((timed) => timed.event.kind === 'reasoning-delta');
        if (firstReasoning === undefined) {
          expect(durationMs).toBeUndefined();
          return;
        }
        const lastAtMs = events.at(-1)?.atMs ?? firstReasoning.atMs;
        expect(durationMs).toBeGreaterThanOrEqual(0);
        expect(durationMs).toBeLessThanOrEqual(lastAtMs - firstReasoning.atMs);
      })
    );
  });
});
