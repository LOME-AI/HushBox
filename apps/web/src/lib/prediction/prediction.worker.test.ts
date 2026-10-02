import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Tensor } from '@huggingface/transformers';

import { ORT_WASM_PATH } from '@hushbox/shared';
import {
  MODEL_WEIGHTS_VERSION,
  PREDICTION_MODEL_FILES,
  PREDICTION_MODEL_ID,
  modelWeightsRoutePath,
} from '@hushbox/shared/model-weights';

import {
  CANARY_EXPECTED_TOKENS,
  CANARY_INPUT,
  createPredictionWorkerHandler,
  type PredictionWorkerContext,
} from './prediction.worker';
import { cappedPredictionInput, MAX_PREDICTION_INPUT_CHARS } from './prediction-input-cap';
import type { PretrainedModelOptions, PreTrainedModel } from '@huggingface/transformers';
import type { PredictionWorkerOutbound } from './prediction-worker-protocol';

interface GenerateArgs {
  input_ids: Tensor;
  attention_mask: Tensor;
  max_new_tokens: number;
  do_sample?: boolean;
  past_key_values?: unknown;
  repetition_penalty?: number;
}

const {
  modelFromPretrained,
  tokenizerFromPretrained,
  generateMock,
  disposeMock,
  decodeMock,
  mockEnv,
} = vi.hoisted(() => ({
  modelFromPretrained: vi.fn(),
  tokenizerFromPretrained: vi.fn(),
  generateMock: vi.fn(),
  disposeMock: vi.fn(),
  decodeMock: vi.fn(),
  // Mirrors the real @huggingface/transformers `env`, whose shape the
  // "real transformers env API" test below grounds against the module itself.
  mockEnv: {
    backends: { onnx: { wasm: { wasmPaths: '' } } },
    allowLocalModels: true,
    allowRemoteModels: false,
    useBrowserCache: false,
    remoteHost: 'https://huggingface.co/',
    remotePathTemplate: '{model}/resolve/{revision}/',
  },
}));

// `Tensor` and `ones` are the library's own rather than doubles, and that is
// load-bearing: every token id the worker reads back arrives through
// `Tensor.tolist()`, whose element type is decided by the tensor's dtype and
// not by whoever built it. A hand-written double gets to choose, and one that
// chose `number` is what let a canary comparison that can never match ship
// green. Only the parts that would load a model are replaced.
vi.mock('@huggingface/transformers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@huggingface/transformers')>();
  return {
    AutoModelForCausalLM: { from_pretrained: modelFromPretrained },
    AutoTokenizer: { from_pretrained: tokenizerFromPretrained },
    Tensor: actual.Tensor,
    ones: actual.ones,
    env: mockEnv,
  };
});

/** One token per code point, so an extended string tokenises to an extended id list. */
function idsOf(text: string): bigint[] {
  return Array.from(text, (character) => BigInt(character.codePointAt(0)!));
}

function textOf(ids: readonly bigint[]): string {
  return ids.map((id) => String.fromCodePoint(Number(id))).join('');
}

/**
 * What the library pads a batched generation's short rows with. One tensor
 * covers the whole batch, so rows that finished early are filled out to the
 * widest one, and `skip_special_tokens` is what drops the filler at decode.
 */
const PAD_TOKEN = 0n;

/**
 * A token tensor as the library builds one: `int64`, which is why `tolist()`
 * hands back BigInt rather than Number.
 */
function tokenTensor(rows: readonly (readonly bigint[])[]): Tensor {
  const width = Math.max(...rows.map((row) => row.length));
  const flat = rows.flatMap((row) => [
    ...row,
    ...Array.from({ length: width - row.length }).fill(PAD_TOKEN),
  ]);
  return new Tensor('int64', BigInt64Array.from(flat), [rows.length, width]);
}

function captureContext(): { ctx: PredictionWorkerContext; posts: PredictionWorkerOutbound[] } {
  const posts: PredictionWorkerOutbound[] = [];
  return {
    posts,
    ctx: {
      postMessage(message: PredictionWorkerOutbound): void {
        posts.push(message);
      },
    },
  };
}

let generatedRows: bigint[][] = [[...CANARY_EXPECTED_TOKENS]];
let pastKeyValuesSeq = 0;

function generateArgsOf(call: number): GenerateArgs {
  return generateMock.mock.calls[call]![0] as GenerateArgs;
}

function rowsOf(tensor: Tensor): bigint[][] {
  const [batch, width] = tensor.dims as [number, number];
  const flat = [...(tensor.data as BigInt64Array)];
  return Array.from({ length: batch }, (_unused, row) =>
    flat.slice(row * width, (row + 1) * width)
  );
}

function promptOf(args: GenerateArgs): bigint[] {
  return rowsOf(args.input_ids)[0]!;
}

beforeEach(() => {
  generateMock.mockReset();
  disposeMock.mockReset();
  modelFromPretrained.mockReset();
  tokenizerFromPretrained.mockReset();
  decodeMock.mockReset();
  generatedRows = [[...CANARY_EXPECTED_TOKENS]];
  pastKeyValuesSeq = 0;

  const tokenizer = ((text: string) => ({
    input_ids: tokenTensor([idsOf(text)]),
  })) as unknown as { decode: typeof decodeMock };
  tokenizer.decode = decodeMock;
  decodeMock.mockImplementation((ids: readonly bigint[]) =>
    textOf(ids.filter((id) => id !== PAD_TOKEN))
  );

  tokenizerFromPretrained.mockResolvedValue(tokenizer);
  modelFromPretrained.mockResolvedValue({ generate: generateMock, dispose: disposeMock });
  generateMock.mockImplementation((args: GenerateArgs) => {
    const rows = rowsOf(args.input_ids).map((prompt, row) => [
      ...prompt,
      ...(generatedRows[row] ?? generatedRows[0]!),
    ]);
    pastKeyValuesSeq += 1;
    return Promise.resolve({
      sequences: tokenTensor(rows),
      past_key_values: { seq: pastKeyValuesSeq },
    });
  });
});

type Handler = ReturnType<typeof createPredictionWorkerHandler>;

async function initialised(): Promise<{ handler: Handler; posts: PredictionWorkerOutbound[] }> {
  const { ctx, posts } = captureContext();
  const handler = createPredictionWorkerHandler(ctx);
  await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
  generateMock.mockClear();
  return { handler, posts };
}

describe('loader configuration', () => {
  it('serves every published artifact from the shared route path', async () => {
    await initialised();
    for (const file of Object.values(PREDICTION_MODEL_FILES)) {
      const resolved = `${mockEnv.remoteHost}${mockEnv.remotePathTemplate.replace('{model}', PREDICTION_MODEL_ID)}${file}`;
      expect(resolved).toBe(
        `https://api.example${modelWeightsRoutePath(PREDICTION_MODEL_ID, MODEL_WEIGHTS_VERSION, file)}`
      );
    }
  });

  it('pins the ONNX runtime to the self-hosted path rather than the library CDN', async () => {
    await initialised();
    expect(mockEnv.backends.onnx.wasm.wasmPaths).toBe(ORT_WASM_PATH);
  });

  it('allows only remote, cached artifacts', async () => {
    await initialised();
    expect(mockEnv.allowLocalModels).toBe(false);
    expect(mockEnv.allowRemoteModels).toBe(true);
    expect(mockEnv.useBrowserCache).toBe(true);
  });

  it('loads the shared model id at int8 on the wasm backend', async () => {
    await initialised();
    const [modelId, options] = modelFromPretrained.mock.calls[0]!;
    expect(modelId).toBe(PREDICTION_MODEL_ID);
    expect(options).toMatchObject({ dtype: 'int8', device: 'wasm' });
  });

  it('names the published weights file with no subfolder', async () => {
    await initialised();
    const [, options] = modelFromPretrained.mock.calls[0]! as [string, Record<string, unknown>];
    expect(options['subfolder']).toBe('');
    expect(`${String(options['model_file_name'])}_int8.onnx`).toBe(PREDICTION_MODEL_FILES.weights);
  });

  it('loads the tokenizer for the same shared model id', async () => {
    await initialised();
    expect(tokenizerFromPretrained.mock.calls[0]![0]).toBe(PREDICTION_MODEL_ID);
  });
});

/**
 * A model built by the library's own constructor, over empty sessions so no
 * weights are loaded. `AutoModelForCausalLM.from_pretrained` resolves an
 * instance of this class, so it is what the worker's model guard must admit.
 */
async function libraryModel(): Promise<PreTrainedModel> {
  const actual = await vi.importActual<typeof import('@huggingface/transformers')>(
    '@huggingface/transformers'
  );
  return new actual.PreTrainedModel(new actual.PretrainedConfig({}), {}, {});
}

describe('real transformers env API', () => {
  // Grounds the mock above against the installed library: the worker writes
  // through `env.backends.onnx.wasm`, `remoteHost` and `remotePathTemplate`, and
  // a mock inventing any of them would be green while production 404s or reaches
  // a CDN. Importing the module runs no model.
  it('exposes the settings the worker writes through', async () => {
    const actual = await vi.importActual<typeof import('@huggingface/transformers')>(
      '@huggingface/transformers'
    );
    const env = actual.env as unknown as Record<string, unknown>;
    expect(typeof env['remoteHost']).toBe('string');
    expect(typeof env['remotePathTemplate']).toBe('string');
    expect(typeof env['allowLocalModels']).toBe('boolean');
    expect(typeof env['allowRemoteModels']).toBe('boolean');
    expect(typeof env['useBrowserCache']).toBe('boolean');
    const backends = env['backends'] as { onnx: { wasm: { wasmPaths: unknown } } };
    // The library types this section as a `Partial`; the worker writes through
    // it unguarded, so what matters is that the runtime really creates it.
    expect(typeof backends.onnx.wasm).toBe('object');
    expect('wasmPaths' in backends.onnx.wasm).toBe(true);
  });

  // The claim `TokenTensor` makes, checked against the thing it describes. Token
  // ids are `int64` throughout this library, and the element type of `tolist()`
  // follows the dtype — upstream types it `any[]`, so nothing but this says so.
  it('hands back BigInt token ids from an int64 tensor', async () => {
    const actual = await vi.importActual<typeof import('@huggingface/transformers')>(
      '@huggingface/transformers'
    );
    const ids = new actual.Tensor('int64', BigInt64Array.from([7042n, 30n]), [1, 2]);
    expect(ids.tolist()).toEqual([[7042n, 30n]]);
  });

  // `PreTrainedModel` extends the library's callable base, whose constructor
  // returns a function closure, so a loaded model is never a plain object and a
  // guard demanding `typeof 'object'` rejects every real one. `generate` and
  // `dispose` ride the prototype, so `in` reaches both.
  it('builds a model that is not a plain object', async () => {
    const model = await libraryModel();

    expect(typeof model).not.toBe('object');
    expect('generate' in model).toBe(true);
    expect('dispose' in model).toBe(true);
  });
});

describe('what the library hands back', () => {
  it('loads a model the library itself constructed', async () => {
    modelFromPretrained.mockResolvedValue(
      Object.assign(await libraryModel(), { generate: generateMock, dispose: disposeMock })
    );
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);

    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });

    expect(posts).toEqual([{ type: 'ready', requestId: 'I' }]);
  });

  it('gives up when the loaded tokenizer cannot be called or cannot decode', async () => {
    tokenizerFromPretrained.mockResolvedValue({ decode: 'not a function' });
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);

    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });

    expect(posts).toEqual([
      {
        type: 'failed',
        requestId: 'I',
        reason: expect.stringContaining('cannot be called or cannot decode'),
      },
    ]);
  });

  it('gives up when the loaded model exposes no generate', async () => {
    modelFromPretrained.mockResolvedValue({ dispose: disposeMock });
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);

    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });

    expect(posts).toEqual([
      {
        type: 'failed',
        requestId: 'I',
        reason: expect.stringContaining('cannot generate or dispose'),
      },
    ]);
  });

  it('gives up when a token tensor lists Numbers rather than BigInt ids', async () => {
    generateMock.mockResolvedValue({
      sequences: { tolist: () => [[1, 2, 3]] },
      past_key_values: null,
    });
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);

    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });

    expect(posts).toEqual([
      {
        type: 'failed',
        requestId: 'I',
        reason: expect.stringContaining('did not list rows of BigInt token ids'),
      },
    ]);
  });
});

describe('the load-time canary', () => {
  it('reports ready when the fixed input greedily produces the pinned tokens', async () => {
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    expect(posts).toEqual([{ type: 'ready', requestId: 'I' }]);
  });

  it('greedily generates the fixed input', async () => {
    const { ctx } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    const args = generateArgsOf(0);
    expect(promptOf(args)).toEqual(idsOf(CANARY_INPUT));
    expect(args.do_sample).toBe(false);
    expect(args.max_new_tokens).toBe(CANARY_EXPECTED_TOKENS.length);
  });

  it('fails and disposes when the tokens differ', async () => {
    generatedRows = [[...CANARY_EXPECTED_TOKENS.slice(0, -1), 999n]];
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    expect(posts).toMatchObject([{ type: 'failed', requestId: 'I' }]);
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it('fails and disposes when the token count differs', async () => {
    generatedRows = [CANARY_EXPECTED_TOKENS.slice(0, -1)];
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    expect(posts).toMatchObject([{ type: 'failed', requestId: 'I' }]);
  });

  it('fails when the artifacts cannot be loaded', async () => {
    modelFromPretrained.mockRejectedValue(new Error('404'));
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    expect(posts).toMatchObject([{ type: 'failed', requestId: 'I' }]);
  });
});

describe('predict', () => {
  it('answers with the decoded continuation', async () => {
    const { handler, posts } = await initialised();
    generatedRows = [idsOf(' sat on the mat')];
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    expect(posts).toContainEqual({
      type: 'completion',
      requestId: 'P',
      completion: ' sat on the mat',
    });
    expect(posts.at(-1)).toEqual({ type: 'alternatives', requestId: 'P', alternatives: [] });
  });

  it('posts the completion before the alternatives', async () => {
    const { handler, posts } = await initialised();
    generatedRows = [idsOf(' one'), idsOf(' two')];
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 2 });
    const completionIndex = posts.findIndex((message) => message.type === 'completion');
    const alternativesIndex = posts.findIndex((message) => message.type === 'alternatives');
    expect(completionIndex).toBeGreaterThanOrEqual(0);
    expect(alternativesIndex).toBeGreaterThan(completionIndex);
  });

  it('generates greedily with no repetition penalty', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    const args = generateArgsOf(generateMock.mock.calls.length - 1);
    expect(args.do_sample).toBe(false);
    expect(args.repetition_penalty).toBeUndefined();
  });

  it('answers an empty text without touching the model', async () => {
    const { handler, posts } = await initialised();
    await handler({ type: 'predict', requestId: 'P', text: '', alternativeCount: 2 });
    expect(generateMock).not.toHaveBeenCalled();
    expect(posts).toContainEqual({ type: 'completion', requestId: 'P', completion: '' });
    expect(posts.at(-1)).toEqual({ type: 'alternatives', requestId: 'P', alternatives: [] });
  });

  it('runs one generation at a time when two requests arrive together', async () => {
    const { handler } = await initialised();
    let inFlight = 0;
    let overlapped = false;
    generateMock.mockImplementation(async (args: GenerateArgs) => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await Promise.resolve();
      inFlight -= 1;
      const prompt = promptOf(args);
      return {
        sequences: tokenTensor([[...prompt, ...generatedRows[0]!]]),
        past_key_values: { seq: 1 },
      };
    });
    await Promise.all([
      handler({ type: 'predict', requestId: 'A', text: 'the cat', alternativeCount: 0 }),
      handler({ type: 'predict', requestId: 'B', text: 'the cat sat', alternativeCount: 0 }),
    ]);
    expect(overlapped).toBe(false);
  });
});

describe('the prompt boundary heal', () => {
  it('tokenizes a trailing space away rather than feeding it to the model', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'P', text: 'the cat sat ', alternativeCount: 0 });
    // The last generate call carries the full prompt (the prefill call ahead of
    // it, per the KV-cache split, already drops one token) — mirrors the
    // convention the input-cap tests above use for the same reason.
    const generation = generateArgsOf(generateMock.mock.calls.length - 1);
    expect(promptOf(generation)).toEqual(idsOf('the cat sat'));
  });

  it('strips the leading whitespace the healed continuation opens with', async () => {
    const { handler, posts } = await initialised();
    generatedRows = [idsOf(' on the mat')];
    await handler({ type: 'predict', requestId: 'P', text: 'the cat sat ', alternativeCount: 0 });
    expect(posts).toContainEqual({ type: 'completion', requestId: 'P', completion: 'on the mat' });
  });

  it('posts nothing when the continuation extends the last word instead of starting one', async () => {
    const { handler, posts } = await initialised();
    generatedRows = [idsOf('urday')];
    await handler({ type: 'predict', requestId: 'P', text: 'the cat sat ', alternativeCount: 0 });
    expect(posts).toContainEqual({ type: 'completion', requestId: 'P', completion: '' });
  });

  it('heals every alternative the same way as the inline completion', async () => {
    const { handler, posts } = await initialised();
    generatedRows = [idsOf(' one'), idsOf(' two'), idsOf('urday')];
    await handler({ type: 'predict', requestId: 'P', text: 'the cat sat ', alternativeCount: 3 });
    expect(posts).toContainEqual({ type: 'completion', requestId: 'P', completion: 'one' });
    // The word-extension row heals to '' exactly as the inline completion
    // would in its place — the seam only dedupes rows identical to the inline
    // completion, and an empty row is not a duplicate of 'one'.
    expect(posts.at(-1)).toEqual({
      type: 'alternatives',
      requestId: 'P',
      alternatives: ['two', ''],
    });
  });

  it('reuses the cache across the space keystroke exactly as it would for a repeat', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'A', text: 'the cat sat', alternativeCount: 0 });
    generateMock.mockClear();

    await handler({ type: 'predict', requestId: 'B', text: 'the cat sat ', alternativeCount: 0 });
    // Baseline confirmed against 'reuses the cache without a prefill pass when
    // the same text is asked twice' above: one generate call for a repeat of
    // already-cached text. The healed ids for 'the cat sat ' equal the cached
    // ids for 'the cat sat', so this call count must match that baseline
    // rather than the two calls (prefill + inline) a cache miss would cost.
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});

describe('the input cap', () => {
  it('tokenizes at the capped length rather than the full typed text', async () => {
    const { handler } = await initialised();
    const text = `${'lorem ipsum '.repeat(500)}dolor sit amet`;
    expect(text.length).toBeGreaterThan(MAX_PREDICTION_INPUT_CHARS);
    await handler({ type: 'predict', requestId: 'P', text, alternativeCount: 0 });
    const generation = generateArgsOf(generateMock.mock.calls.length - 1);
    expect(promptOf(generation)).toEqual(idsOf(cappedPredictionInput(text)));
    expect(promptOf(generation).length).toBeLessThan(idsOf(text).length);
  });

  it('leaves text at or under the cap untouched', async () => {
    const { handler } = await initialised();
    const text = 'the cat';
    await handler({ type: 'predict', requestId: 'P', text, alternativeCount: 0 });
    const generation = generateArgsOf(generateMock.mock.calls.length - 1);
    expect(promptOf(generation)).toEqual(idsOf(text));
  });
});

describe('key-value cache reuse', () => {
  it('prefills only the newly typed tokens when the text was extended', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'A', text: 'the cat', alternativeCount: 0 });
    const firstPass = (await generateMock.mock.results[0]!.value) as { past_key_values: unknown };
    const cache = firstPass.past_key_values;
    generateMock.mockClear();

    await handler({ type: 'predict', requestId: 'B', text: 'the cat sat', alternativeCount: 0 });
    const prefill = generateArgsOf(0);
    expect(prefill.past_key_values).toBe(cache);
    expect(promptOf(prefill)).toEqual(idsOf('the cat sa'));
  });

  it('prefills nothing when a single token has been typed', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'A', text: 'a', alternativeCount: 0 });
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateArgsOf(0).past_key_values).toBeUndefined();
  });

  it('drops the cache when the text is edited rather than extended', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'A', text: 'the cat', alternativeCount: 0 });
    generateMock.mockClear();

    await handler({ type: 'predict', requestId: 'B', text: 'the dog sat', alternativeCount: 0 });
    expect(generateArgsOf(0).past_key_values).toBeUndefined();
  });

  it('reuses the cache without a prefill pass when the same text is asked twice', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'A', text: 'the cat', alternativeCount: 0 });
    generateMock.mockClear();

    await handler({ type: 'predict', requestId: 'B', text: 'the cat', alternativeCount: 0 });
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it('passes the cache to the generating pass, one token short of the typed text', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'A', text: 'the cat', alternativeCount: 0 });
    const prefill = generateArgsOf(0);
    const generation = generateArgsOf(1);
    expect(promptOf(prefill)).toEqual(idsOf('the ca'));
    expect(promptOf(generation)).toEqual(idsOf('the cat'));
    const prefillResult = (await generateMock.mock.results[0]!.value) as {
      past_key_values: unknown;
    };
    expect(generation.past_key_values).toBe(prefillResult.past_key_values);
  });

  it('masks exactly the tokens it passes, so the library prefills only the tail', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'A', text: 'the cat', alternativeCount: 0 });
    for (const call of generateMock.mock.calls) {
      const args = call[0] as GenerateArgs;
      expect(args.attention_mask.dims).toEqual(args.input_ids.dims);
    }
  });
});

describe('the candidate list', () => {
  it('samples the alternatives in one batched generation', async () => {
    const { handler } = await initialised();
    generatedRows = [idsOf(' one'), idsOf(' two'), idsOf(' three')];
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 3 });
    const batched = generateArgsOf(generateMock.mock.calls.length - 1);
    expect(batched.input_ids.dims).toEqual([3, idsOf('the cat').length]);
    expect(batched.do_sample).toBe(true);
  });

  it('posts the inline completion and the sampled continuations separately', async () => {
    const { handler, posts } = await initialised();
    generatedRows = [idsOf(' one'), idsOf(' two'), idsOf(' three')];
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 3 });
    expect(posts).toContainEqual({ type: 'completion', requestId: 'P', completion: ' one' });
    expect(posts.at(-1)).toEqual({
      type: 'alternatives',
      requestId: 'P',
      alternatives: [' two', ' three'],
    });
  });

  it('never repeats the inline continuation among the alternatives', async () => {
    const { handler, posts } = await initialised();
    generatedRows = [idsOf(' one'), idsOf(' one'), idsOf(' one')];
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 3 });
    expect(posts).toContainEqual({ type: 'completion', requestId: 'P', completion: ' one' });
    expect(posts.at(-1)).toEqual({ type: 'alternatives', requestId: 'P', alternatives: [] });
  });

  it('runs no batched generation when no alternatives are wanted', async () => {
    const { handler } = await initialised();
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    for (const call of generateMock.mock.calls) {
      expect((call[0] as GenerateArgs).input_ids.dims[0]).toBe(1);
    }
  });
});

describe('dispose and respawn', () => {
  it('disposes the session when a generation fails', async () => {
    const { handler, posts } = await initialised();
    generateMock.mockRejectedValue(new Error('OrtRun'));
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    expect(posts.at(-1)).toMatchObject({ type: 'failed', requestId: 'P' });
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it('refuses later work rather than retrying the wedged session', async () => {
    const { handler, posts } = await initialised();
    generateMock.mockRejectedValue(new Error('OrtRun'));
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    generateMock.mockClear();

    await handler({ type: 'predict', requestId: 'Q', text: 'the cat sat', alternativeCount: 0 });
    expect(generateMock).not.toHaveBeenCalled();
    expect(posts.at(-1)).toMatchObject({ type: 'failed', requestId: 'Q' });
  });

  it('disposes once however many requests arrive afterwards', async () => {
    const { handler } = await initialised();
    generateMock.mockRejectedValue(new Error('OrtRun'));
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    await handler({ type: 'predict', requestId: 'Q', text: 'the cat', alternativeCount: 0 });
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it('answers the failure even when disposing the wedged session throws', async () => {
    const { handler, posts } = await initialised();
    generateMock.mockRejectedValue(new Error('OrtRun'));
    disposeMock.mockRejectedValue(new Error('dispose on a wedged runtime'));
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    expect(posts.at(-1)).toMatchObject({ type: 'failed', requestId: 'P' });
  });

  it('keeps answering later messages after a disposal threw', async () => {
    const { handler, posts } = await initialised();
    generateMock.mockRejectedValue(new Error('OrtRun'));
    disposeMock.mockRejectedValue(new Error('dispose on a wedged runtime'));
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });

    await handler({ type: 'predict', requestId: 'Q', text: 'the cat sat', alternativeCount: 0 });
    expect(posts.at(-1)).toMatchObject({ type: 'failed', requestId: 'Q' });
  });

  it('refuses a prediction asked for before the model loaded', async () => {
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    expect(generateMock).not.toHaveBeenCalled();
    expect(posts).toMatchObject([{ type: 'failed', requestId: 'P' }]);
    // Non-terminal in the same sense: the refusal wedges nothing, so the load
    // the request arrived ahead of still succeeds.
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    expect(posts.at(-1)).toEqual({ type: 'ready', requestId: 'I' });
  });

  it('refuses to reload after a failure rather than re-running the wedged runtime', async () => {
    const { handler, posts } = await initialised();
    generateMock.mockRejectedValue(new Error('OrtRun'));
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    modelFromPretrained.mockClear();

    await handler({ type: 'init', requestId: 'J', apiOrigin: 'https://api.example' });
    expect(modelFromPretrained).not.toHaveBeenCalled();
    expect(posts.at(-1)).toMatchObject({ type: 'failed', requestId: 'J' });
  });

  it('treats a load that failed as terminal for the worker', async () => {
    // The counterpart of the two non-terminal refusals: a load that got far
    // enough to hold a session and then failed disposes it and wedges the
    // worker, so a consumer terminates and respawns on this `failed` rather
    // than keeping a runtime that will answer nothing.
    generatedRows = [[...CANARY_EXPECTED_TOKENS.slice(0, -1), 999n]];
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    expect(posts.at(-1)).toMatchObject({ type: 'failed', requestId: 'I' });
    expect(disposeMock).toHaveBeenCalledTimes(1);

    generatedRows = [idsOf(' sat on the mat')];
    modelFromPretrained.mockClear();
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    expect(posts.at(-1)).toMatchObject({ type: 'failed', requestId: 'P' });
    await handler({ type: 'init', requestId: 'J', apiOrigin: 'https://api.example' });
    expect(posts.at(-1)).toMatchObject({ type: 'failed', requestId: 'J' });
    expect(modelFromPretrained).not.toHaveBeenCalled();
  });

  it('refuses a second load rather than replacing a live session', async () => {
    const { handler, posts } = await initialised();
    await handler({ type: 'init', requestId: 'J', apiOrigin: 'https://api.example' });
    expect(modelFromPretrained).toHaveBeenCalledTimes(1);
    expect(posts.at(-1)).toMatchObject({ type: 'failed', requestId: 'J' });
    // The refusal is non-terminal, and the published contract tells a consumer
    // to keep the worker on it: nothing is disposed and the session that was
    // already live goes on answering. Disposing here would cost a healthy
    // session and a re-download of the weights.
    expect(disposeMock).not.toHaveBeenCalled();
    generatedRows = [idsOf(' sat on the mat')];
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    expect(posts).toContainEqual({
      type: 'completion',
      requestId: 'P',
      completion: ' sat on the mat',
    });
    expect(posts.at(-1)).toEqual({ type: 'alternatives', requestId: 'P', alternatives: [] });
  });
});

describe('the reason a failure carries', () => {
  /**
   * The user is told nothing, ever — no console line, no toast, no reporting —
   * so this field is the only thing that can say why a worker gave up, and it
   * exists for whoever is debugging rather than for the app: a consumer reads
   * the `type` and drops the rest. It carries token ids and library error text,
   * never anything the user typed.
   */
  function reasonOf(posts: readonly PredictionWorkerOutbound[]): string | undefined {
    const last = posts.at(-1);
    return last?.type === 'failed' ? last.reason : undefined;
  }

  it('names the tokens a canary mismatch produced and the ones it expected', async () => {
    const produced = [...CANARY_EXPECTED_TOKENS.slice(0, -1), 999n];
    generatedRows = [produced];
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    expect(reasonOf(posts)).toContain(produced.join(', '));
    expect(reasonOf(posts)).toContain(CANARY_EXPECTED_TOKENS.join(', '));
  });

  it('carries the message of the error that stopped a load', async () => {
    modelFromPretrained.mockRejectedValue(new Error('weights 404'));
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    expect(reasonOf(posts)).toBe('weights 404');
  });

  it('reads a rejection that is not an Error rather than reporting nothing', async () => {
    modelFromPretrained.mockRejectedValue('the runtime refused to start');
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'init', requestId: 'I', apiOrigin: 'https://api.example' });
    expect(reasonOf(posts)).toBe('the runtime refused to start');
  });

  it('carries the message of the error that wedged a generation', async () => {
    const { handler, posts } = await initialised();
    generateMock.mockRejectedValue(new Error('OrtRun aborted'));
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    expect(reasonOf(posts)).toBe('OrtRun aborted');
  });

  it('says a prediction arrived before any load was asked for', async () => {
    const { ctx, posts } = captureContext();
    const handler = createPredictionWorkerHandler(ctx);
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    expect(reasonOf(posts)).toBe('no session is loaded');
  });

  it('tells a refused second load apart from a refused reload of a wedged worker', async () => {
    const { handler, posts } = await initialised();
    await handler({ type: 'init', requestId: 'J', apiOrigin: 'https://api.example' });
    expect(reasonOf(posts)).toBe('a session is already loaded');

    generateMock.mockRejectedValue(new Error('OrtRun aborted'));
    await handler({ type: 'predict', requestId: 'P', text: 'the cat', alternativeCount: 0 });
    await handler({ type: 'init', requestId: 'K', apiOrigin: 'https://api.example' });
    expect(reasonOf(posts)).toBe('the runtime is wedged and cannot be reloaded');
  });
});

describe('worker auto-registration', () => {
  it('registers a message listener and forwards answers to the global postMessage', async () => {
    const listeners: ((event: MessageEvent) => void)[] = [];
    const originalImportScripts = (globalThis as { importScripts?: unknown }).importScripts;
    const originalPostMessage = globalThis.postMessage;
    const originalAdd = self.addEventListener;
    const posted: unknown[] = [];
    (globalThis as { importScripts?: unknown }).importScripts = (): void => {};
    globalThis.postMessage = ((message: unknown): void => {
      posted.push(message);
    }) as typeof globalThis.postMessage;
    self.addEventListener = ((type: string, listener: (event: MessageEvent) => void): void => {
      if (type === 'message') listeners.push(listener);
    }) as typeof globalThis.addEventListener;
    try {
      vi.resetModules();
      await import('./prediction.worker');
      expect(listeners.length).toBe(1);
      listeners[0]!({
        data: { type: 'init', requestId: 'AR', apiOrigin: 'https://api.example' },
      } as MessageEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(posted).toEqual([{ type: 'ready', requestId: 'AR' }]);
    } finally {
      if (originalImportScripts === undefined) {
        Reflect.deleteProperty(globalThis as object, 'importScripts');
      } else {
        (globalThis as { importScripts?: unknown }).importScripts = originalImportScripts;
      }
      globalThis.postMessage = originalPostMessage;
      self.addEventListener = originalAdd;
    }
  });
});

describe('the installed library, driven for real', () => {
  /**
   * Every assertion above this point runs against a mocked
   * `@huggingface/transformers`, so what they pin is what the worker *hands*
   * the library — never what the library *does* with it. The library owns the
   * whole address: it joins `remoteHost`, `remotePathTemplate` and the file
   * name, and appends the dtype suffix to `model_file_name` itself. A bump that
   * changes any of that leaves every mocked assertion green while every
   * artifact 404s, for a feature designed to fail without a sound.
   *
   * So this drives the installed library with the settings and options the
   * worker itself just handed the mock, over a stubbed `fetch`, and asserts the
   * addresses it asks for are the ones the shared route-path builder names.
   * The whole set, not a sample: a suffix or subfolder change moves some
   * artifacts and not others.
   */
  const API_ORIGIN = 'https://api.example';

  interface RealEnv extends Record<string, unknown> {
    remoteHost: string;
    remotePathTemplate: string;
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    useCustomCache: boolean;
    customCache: unknown;
  }

  /**
   * An always-empty cache, which the library consults before every other
   * caching backend. It stands in for the browser Cache API the worker enables:
   * vitest runs on Node, where a cache hit would hide the very request this
   * test exists to observe and the library's Node fallback would write model
   * files into `node_modules`.
   */
  const EMPTY_CACHE = {
    match: (): Promise<void> => Promise.resolve(),
    put: (): Promise<void> => Promise.resolve(),
  };

  /**
   * The one artifact that resolves, and only so the load reaches the weights
   * request behind it — nothing here is model bytes. The length is declared
   * because the library warns when a response withholds it.
   */
  const configResponse = (): Response => {
    const config = { model_type: 'llama' };
    return Response.json(config, {
      headers: {
        'content-length': String(new TextEncoder().encode(JSON.stringify(config)).length),
      },
    });
  };

  it('asks the shared route path for every published prediction artifact', async () => {
    await initialised();
    const [modelId, modelOptions] = modelFromPretrained.mock.calls[0]! as [
      string,
      PretrainedModelOptions,
    ];
    const [tokenizerId] = tokenizerFromPretrained.mock.calls[0]! as [string];

    const real = await vi.importActual<typeof import('@huggingface/transformers')>(
      '@huggingface/transformers'
    );
    const env = real.env as unknown as RealEnv;
    const restore = { ...env };
    const requested: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL): Promise<Response> => {
      const url = input instanceof Request ? input.url : input.toString();
      requested.push(url);
      // Both loads are expected to fail once their addresses are recorded.
      return Promise.resolve(
        url.endsWith('/config.json') ? configResponse() : new Response('absent', { status: 404 })
      );
    }) as typeof globalThis.fetch;

    try {
      env.remoteHost = mockEnv.remoteHost;
      env.remotePathTemplate = mockEnv.remotePathTemplate;
      env.allowLocalModels = mockEnv.allowLocalModels;
      env.allowRemoteModels = mockEnv.allowRemoteModels;
      env.useCustomCache = true;
      env.customCache = EMPTY_CACHE;
      try {
        await real.AutoTokenizer.from_pretrained(tokenizerId);
      } catch {
        // Expected: the tokenizer files 404. Both were requested first.
      }
      try {
        // `device` names an execution provider, never an address, and
        // onnxruntime-node publishes no wasm provider — so the drive drops it
        // and lets the library pick the provider its own runtime offers.
        // Everything the address is built from is the worker's own.
        const addressing: PretrainedModelOptions = { ...modelOptions };
        delete addressing.device;
        await real.AutoModelForCausalLM.from_pretrained(modelId, addressing);
      } catch {
        // Expected: the weights 404 once their address has been recorded.
      }
    } finally {
      globalThis.fetch = originalFetch;
      Object.assign(env, restore);
    }

    const published = Object.values(PREDICTION_MODEL_FILES).map(
      (file) =>
        `${API_ORIGIN}${modelWeightsRoutePath(PREDICTION_MODEL_ID, MODEL_WEIGHTS_VERSION, file)}`
    );
    const alphabetically = (a: string, b: string): number => a.localeCompare(b);
    expect(requested.toSorted(alphabetically)).toEqual(published.toSorted(alphabetically));
  });
});
