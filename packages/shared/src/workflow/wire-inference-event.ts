import { z } from 'zod';
import { InferenceEvent } from './inference.ts';

type InferenceEventOption = (typeof InferenceEvent.options)[number];
type OptionOf<K extends InferenceEvent['kind']> = Extract<
  InferenceEventOption,
  { shape: { kind: z.ZodLiteral<K> } }
>;

function isOption<K extends InferenceEvent['kind']>(
  option: InferenceEventOption,
  kind: K
): option is OptionOf<K> {
  return option.shape.kind.value === kind;
}

/**
 * An {@link InferenceEvent} as the conversation room delivers it to a socket,
 * member or link guest alike. Parsing through it builds a copy that carries no
 * provider cost, no raw provider response (where a provider's own cost and
 * token figures would sit), no serving endpoint, no step's usage and, of a
 * finish's usage, only the reasoning count: input and output counts times
 * public rates rebuild the cost. The reasoning count is public by design,
 * since share and history reads serve it to guests. Unknown keys are stripped
 * by the parse, which is what removes the dropped fields.
 */
export const WireInferenceEvent = z.union(
  InferenceEvent.options.map((option) => {
    if (isOption(option, 'step-finish')) {
      return option.omit({ providerCostUsd: true, usage: true, servedBy: true });
    }
    if (isOption(option, 'finish')) {
      const metadata = option.shape.metadata;
      return option.extend({
        metadata: metadata.omit({ providerCostUsd: true, raw: true, servedBy: true }).extend({
          usage: metadata.shape.usage.pick({ reasoningTokens: true }),
        }),
      });
    }
    return option;
  })
);

export type WireInferenceEvent = z.infer<typeof WireInferenceEvent>;

/**
 * The copy of an event the room sends: the same fields less the provider cost,
 * the raw provider response, the serving endpoint, a step's usage and, of a
 * finish's usage, everything but the reasoning count. Typed rather than
 * parsed, so an event the executor emits is never rejected mid-stream.
 */
export function toWireInferenceEvent(event: InferenceEvent): WireInferenceEvent {
  const wire = { ...event };
  if (wire.kind === 'step-finish') {
    delete wire.providerCostUsd;
    delete wire.usage;
    delete wire.servedBy;
  }
  if (wire.kind === 'finish') {
    const metadata = { ...wire.metadata };
    delete metadata.providerCostUsd;
    delete metadata.raw;
    delete metadata.servedBy;
    const { reasoningTokens } = metadata.usage;
    return {
      ...wire,
      metadata: { ...metadata, usage: reasoningTokens === undefined ? {} : { reasoningTokens } },
    };
  }
  return wire;
}
