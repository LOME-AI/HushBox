import { generateImage, NoContentGeneratedError, NoImageGeneratedError } from 'ai';
import { z } from 'zod';
import { imageRoutingOptions } from '@hushbox/shared';
import {
  classifyInferenceFailure,
  emptyCompletionError,
  invalidRequestError,
} from './inference-error.js';
import { validateInferenceCall } from './inference-boundary.js';
import { mediaFinishEvent, mediaOutputEvents, mediaPromptFromInputs } from './media-generate.js';
import { createOpenRouterProvider } from './openrouter-provider.js';
import type { OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import type { GenerateImageResult, ImageModelUsage } from 'ai';
import type { InferenceEvent, InferenceRequest, ModelDescriptor, Usage } from '@hushbox/shared';
import type { InferOptions, ModelProvider } from '../ports/index.js';

/**
 * The image-family adapter behind the ModelProvider port: the AI SDK's
 * `generateImage` against OpenRouter's `/images` endpoint (non-streaming
 * generate). The Images API carries no `zdr` field, so every call is pinned to
 * the descriptor's ZDR endpoint tags via `imageRoutingOptions()`, and a
 * descriptor without a pin is refused before any request. The images API
 * returns the call's cost in `usage.cost`, which the SDK drops, so the adapter
 * reads it off the responses themselves and the finish carries it as the inline
 * cost settlement bills.
 */
interface CreateImageAdapterOptions {
  readonly apiKey: string;
  /**
   * The cassette/fixture seam — tests inject a wrapped fetch here so calls
   * record/replay uniformly. Production omits it and the SDK uses
   * `globalThis.fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The first-class call settings the adapter can wire today. The
 * ParamSpec→wire compiler (catalog work) replaces this closed set; until
 * then an unknown key is rejected at the boundary, never dropped silently.
 */
const callParametersSchema = z.strictObject({
  n: z.number().int().positive().optional(),
  size: z.templateLiteral([z.number(), 'x', z.number()]).optional(),
  aspectRatio: z.templateLiteral([z.number(), ':', z.number()]).optional(),
  resolution: z.string().min(1).optional(),
});

type CallParameters = z.infer<typeof callParametersSchema>;

function parseCallParameters(parameters: Record<string, unknown>): CallParameters {
  const parsed = callParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    const keys = Object.keys(parameters).join(', ');
    throw invalidRequestError(`Unsupported image parameters (keys: ${keys})`);
  }
  return parsed.data;
}

/**
 * The inputs billing's estimate flow prices against the per-size pricing
 * matrix (OpenRouter catalog pricing). Exposed here so estimation never re-derives
 * the adapter's parameter contract; this module does not price.
 */
interface ImageEstimateInputs {
  readonly n: number;
  readonly size?: `${number}x${number}`;
  readonly aspectRatio?: `${number}:${number}`;
}

export function imageEstimateInputs(request: InferenceRequest): ImageEstimateInputs {
  const parameters = parseCallParameters(request.parameters);
  return {
    n: parameters.n ?? 1,
    ...(parameters.size === undefined ? {} : { size: parameters.size }),
    ...(parameters.aspectRatio === undefined ? {} : { aspectRatio: parameters.aspectRatio }),
  };
}

function mapImageUsage(usage: ImageModelUsage): Usage {
  return { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 };
}

const imagesCostSchema = z.looseObject({
  usage: z.looseObject({ cost: z.number().nonnegative() }),
});

/**
 * The summed `usage.cost` of one call's `/images` responses, read off a clone of
 * each, or `undefined` when any of them carried none: a partial sum would bill
 * less than the call cost as if it were exact. A successful response whose body
 * is not JSON throws out of the fetch, as the SDK's own read of it would.
 */
interface CostTap {
  readonly fetch: typeof globalThis.fetch;
  readonly costUsd: () => number | undefined;
}

function tapImagesCost(base: typeof globalThis.fetch | undefined): CostTap {
  const costs: (number | undefined)[] = [];
  const tapped: typeof globalThis.fetch = async (input, init) => {
    const response = await (base ?? globalThis.fetch)(input, init);
    if (response.ok) {
      const body: unknown = await response.clone().json();
      costs.push(imagesCostSchema.safeParse(body).data?.usage.cost);
    }
    return response;
  };
  return {
    fetch: tapped,
    costUsd: () => {
      const [first, ...rest] = costs;
      let sum = first;
      for (const cost of rest) {
        sum = sum === undefined || cost === undefined ? undefined : sum + cost;
      }
      return sum;
    },
  };
}

interface InferImageInput {
  apiKey: string;
  fetch: typeof globalThis.fetch | undefined;
  request: InferenceRequest;
  zdrPin: readonly [string, ...string[]];
  options: InferOptions;
}

async function* inferImage(input: InferImageInput): AsyncGenerator<InferenceEvent> {
  const { request, options } = input;
  const parameters = parseCallParameters(request.parameters);
  const prompt = mediaPromptFromInputs(request.inputs);
  // A provider per call, so the cost tap sees only this call's responses.
  const tap = tapImagesCost(input.fetch);
  const provider: OpenRouterProvider = createOpenRouterProvider({
    apiKey: input.apiKey,
    fetch: tap.fetch,
  });

  let result: GenerateImageResult;
  try {
    result = await generateImage({
      model: provider.imageModel(request.model, imageRoutingOptions(input.zdrPin)),
      prompt,
      maxRetries: 0,
      ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
      ...(parameters.n === undefined ? {} : { n: parameters.n }),
      ...(parameters.size === undefined ? {} : { size: parameters.size }),
      ...(parameters.aspectRatio === undefined ? {} : { aspectRatio: parameters.aspectRatio }),
      ...(parameters.resolution === undefined
        ? {}
        : { providerOptions: { openrouter: { resolution: parameters.resolution } } }),
    });
  } catch (error) {
    // A successful call that yielded zero images — the media analogue of the
    // language adapter's empty completion. OpenRouter's image model raises
    // NoContentGeneratedError from doGenerate; generateImage raises
    // NoImageGeneratedError when it gathers none.
    if (NoContentGeneratedError.isInstance(error) || NoImageGeneratedError.isInstance(error)) {
      throw emptyCompletionError();
    }
    throw classifyInferenceFailure(error);
  }

  const costUsd = tap.costUsd();
  yield* mediaOutputEvents(result.images, options.mapFilePart);
  // The generating call's own metadata: the result's aggregate merges every
  // call down to their per-image arrays, so a generation id cannot survive it.
  yield mediaFinishEvent(result.calls[0]?.providerMetadata, mapImageUsage(result.usage), costUsd);
}

export function createImageAdapter(options: CreateImageAdapterOptions): ModelProvider {
  return {
    infer(
      request: InferenceRequest,
      descriptor: ModelDescriptor,
      inferOptions: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      validateInferenceCall(request, descriptor);
      if (descriptor.zdrPin === undefined) {
        throw invalidRequestError(`Image model ${descriptor.id} has no ZDR endpoint pin`);
      }
      return inferImage({
        apiKey: options.apiKey,
        fetch: options.fetch,
        request,
        zdrPin: descriptor.zdrPin,
        options: inferOptions,
      });
    },
  };
}
