/**
 * The Smart Model candidate menu, asserted THROUGH the one producer rather than
 * against a transcription of it. The server's menu and the client's picker are
 * the same call over the same pool projection, so the agreement this file used
 * to state twice and compare is now a property of one derivation — and the test
 * that matters is the one a second pool made unprovable: that the free tier's
 * two menus are identical.
 *
 * The hold a send places is NOT asserted here. It is the run estimator's figure
 * over the compiled definition, which lives beside the compile in the chat
 * slice; a second hold derived alongside the menu would be a number admission
 * never places.
 */

import { describe, expect, it } from 'vitest';
import {
  CLASSIFIER_OUTPUT_TOKEN_CAP,
  MAX_CLASSIFIER_CONTEXT_CHARS,
  computeClassifierPromptOverhead,
  getTurnOptions,
  modelId,
  nanoUSD,
  poolModelFrom,
  poolModelFromWire,
  promptBasisFromTotal,
  ResolvedReasoningEffort,
} from '@hushbox/shared';
import { ASSISTANT_FRAMING_MAX_CHARS, WEB_SEARCH_ROW_MAX_CHARS } from '@hushbox/shared';
import {
  WEB_SEARCH_RESULT_MAX_CHARS,
  inputTokensOf,
  toolCallBillableNano,
  toolLoopBound,
} from '@hushbox/shared/affordability';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { classifierWorstCaseNanoUsd } from '@hushbox/shared/affordability/estimate/smart-model-affordability';
import { REASONING_BUDGET_TOKENS_BY_EFFORT } from '@hushbox/shared/affordability/estimate/reasoning-plan';
import { ceilingOf } from '@hushbox/shared/affordability/price/schedule';
import { DAY_MS, OLD_RELEASE_SECONDS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { perImagePricingFixture, tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { buildModelsListResponse } from '../catalog/list-models.js';
import {
  buildSmartModelCandidates,
  pickEffortClassifier,
  smartModelMinimumNanoUsd,
  smartModelPool,
} from './candidates.js';
import type { SmartModelCandidates } from './candidates.js';
import type {
  Modality,
  CanonicalReasoningEffort,
  Model,
  ModelDescriptor,
  PriceableModel,
  UserTier,
} from '@hushbox/shared';

/** A fixed instant well past the recency window, so the clock is an argument. */
const NOW_MS = TEST_DAY_START;

function descriptorOf(params: {
  readonly id: string;
  readonly inputRate?: bigint;
  readonly outputRate?: bigint;
  readonly contextLength?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly inputs?: readonly Modality[];
  readonly outputs?: readonly Modality[];
  readonly description?: string;
  readonly releasedAt?: number;
}): ModelDescriptor {
  // A row stating one rate leg has no token price: it stands for a price no token
  // turn can read, which a per-image price is.
  const pricing: ModelDescriptor['pricing'] =
    params.inputRate === undefined || params.outputRate === undefined
      ? perImagePricingFixture({ anchor: 1n, dearest: 1n })
      : tokenPricingFixture({ input: params.inputRate, output: params.outputRate });
  return {
    id: params.id,
    provider: 'openrouter',
    version: '1',
    inputs: [...(params.inputs ?? ['text'])],
    outputs: [...(params.outputs ?? ['text'])],
    parameters: {},
    behaviors: ['streaming'],
    limits: {
      ...(params.contextLength === undefined ? {} : { contextLength: params.contextLength }),
      ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    },
    pricing,
    zdrReachable: true,
    releasedAt: params.releasedAt ?? OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...(params.description === undefined ? {} : { description: params.description }),
  };
}

// Cheap: combined 3n/token, context 100_000.
const CHEAP = descriptorOf({
  id: 'cheap/model',
  inputRate: 1n,
  outputRate: 2n,
  contextLength: 100_000,
  description: 'cheap and fast',
});
// Mid: combined 30n/token, same context — an ordinary second candidate.
const MID = descriptorOf({
  id: 'mid/model',
  inputRate: 10n,
  outputRate: 20n,
  contextLength: 100_000,
});

const HUGE_BALANCE = 10n ** 18n;
const PROMPT_CHARS = 400;

/** A sibling's terms as a paid budget solve reads them. */
interface PaidTerms {
  /** Fixed nano-USD the sibling takes before any token is bought. */
  readonly fixed: bigint;
  /** Nano-USD per shared output token. */
  readonly perToken: bigint;
}

/** Prompt tokens: 400 characters at 3 per token. */
const PROMPT_TOKENS = 134n;

/** The framing allowance every persisting answer reserves, at 300 nano per character. */
const FRAMING_NANO = BigInt(ASSISTANT_FRAMING_MAX_CHARS) * 300n;

/** The base rates a hold reserves at: the ceiling of the row's anchor. */
function ratesOf(row: ModelDescriptor): { readonly input: bigint; readonly output: bigint } {
  if (row.pricing.kind !== 'tokens') {
    throw new TypeError(`expected per-token rates on ${row.id}`);
  }
  return ceilingOf(row.pricing.anchor).base;
}

/** A token-priced descriptor as the shared reserve reads it. */
function tokenPriced(descriptor: ModelDescriptor): {
  readonly pricing: Extract<ModelDescriptor['pricing'], { kind: 'tokens' }>;
} {
  if (descriptor.pricing.kind !== 'tokens') {
    throw new TypeError(`expected per-token rates on ${descriptor.id}`);
  }
  return { pricing: descriptor.pricing };
}

/** A paid sibling answering in one call: its prompt and framing, its output and storage. */
function paidPlainTerms(row: ModelDescriptor): PaidTerms {
  const { input, output } = ratesOf(row);
  return { fixed: PROMPT_TOKENS * input + FRAMING_NANO, perToken: output + 5n * 300n };
}

/**
 * A paid sibling running the search loop, from first principles: 11 steps for
 * 10 calls. The prompt rides every step, each call's result is re-sent on 10
 * later steps, the 10 tool-carrying steps each send the tool-use overhead, each
 * call pays the after-fee web-search rate, and the search rows and the framing
 * are stored; per output token, every step's output and its
 * storage, and the model's own output re-sent 55 answers' worth.
 */
function paidSearchTerms(row: ModelDescriptor): PaidTerms {
  const { input, output } = ratesOf(row);
  const resultTokens = BigInt(Math.ceil(WEB_SEARCH_RESULT_MAX_CHARS / 3));
  const overheadTokens = BigInt(toolLoopBound(['webSearch'], 10).overheadTokens);
  return {
    fixed:
      11n * PROMPT_TOKENS * input +
      10n * 10n * resultTokens * input +
      10n * overheadTokens * input +
      10n * toolCallBillableNano('webSearch') +
      BigInt(WEB_SEARCH_ROW_MAX_CHARS) * 300n +
      FRAMING_NANO,
    perToken: 11n * (output + 5n * 300n) + 55n * input,
  };
}

function build(
  descriptors: readonly ModelDescriptor[],
  balanceNanoUsd: bigint,
  tier: UserTier = 'paid',
  pinnedModelIds: readonly string[] = []
): ReturnType<typeof buildSmartModelCandidates> {
  return buildSmartModelCandidates({
    descriptors,
    balanceNanoUsd,
    tier,
    pinnedModelIds,
    promptChars: PROMPT_CHARS,
    inputChars: PROMPT_CHARS,
    nowMs: NOW_MS,
    webSearch: false,
  });
}

/**
 * The exact classifier reserve, worked by hand: the reserve's input tokens and
 * the output cap, each at the classifier's own rate.
 */
function classifierReserve(
  classifier: ModelDescriptor,
  textCatalog: readonly ModelDescriptor[]
): bigint {
  const overheadChars = computeClassifierPromptOverhead(
    textCatalog.map((descriptor) => ({ id: descriptor.id, description: '' }))
  );
  const inputTokens = inputTokensOf(MAX_CLASSIFIER_CONTEXT_CHARS + overheadChars);
  const { input, output } = ratesOf(classifier);
  return BigInt(inputTokens) * input + BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * output;
}

describe('classifierWorstCaseNanoUsd', () => {
  it('derives classifier input tokens from the shared input-token conversion', () => {
    const classifier = descriptorOf({ id: 'cls/model', inputRate: 1000n, outputRate: 2000n });
    const catalog = [classifier];
    const overheadChars = computeClassifierPromptOverhead(
      catalog.map((d) => ({ id: d.id, description: d.description ?? '' }))
    );
    const expectedInputTokens = inputTokensOf(MAX_CLASSIFIER_CONTEXT_CHARS + overheadChars);
    // At the ceiling of 1,000 / 2,000.
    const expectedBase =
      BigInt(expectedInputTokens) * 1250n + BigInt(CLASSIFIER_OUTPUT_TOKEN_CAP) * 2500n;
    expect(classifierWorstCaseNanoUsd(tokenPriced(classifier), catalog)).toBe(expectedBase);
  });
});

describe('smartModelPool — the one projection, three legs', () => {
  // Each case removes exactly one leg's satisfaction from an otherwise poolable
  // row, so a leg quietly dropped from the projection reddens exactly one of
  // them rather than none.
  it('draws an ordinary text row, and a vision row beside it', () => {
    const vision = descriptorOf({
      id: 'vision/model',
      inputRate: 1n,
      outputRate: 2n,
      contextLength: 1000,
      inputs: ['text', 'image'],
    });
    expect(smartModelPool([CHEAP, vision]).map((model) => model.modelId)).toEqual([
      'cheap/model',
      'vision/model',
    ]);
  });

  it('drops a row on the runnable-shape leg alone', () => {
    const imageOut = descriptorOf({
      id: 'draw/model',
      inputRate: 1n,
      outputRate: 2n,
      contextLength: 1000,
      outputs: ['image'],
    });
    expect(smartModelPool([imageOut])).toEqual([]);
  });

  it('drops a row on the context-length leg alone', () => {
    const noContext = descriptorOf({ id: 'no-context/model', inputRate: 1n, outputRate: 2n });
    expect(smartModelPool([noContext])).toEqual([]);
  });

  it('drops a row on the release-date leg alone', () => {
    // A descriptor always dates a model, so the leg is exercised through the
    // projection the wire row reaches it by — the one carrier that can omit it.
    expect(
      poolModelFrom({
        id: 'undated/model',
        inputs: ['text'],
        outputs: ['text'],
        pricing: tokenPricingFixture({ input: 1n, output: 2n }),
        contextLength: 1000,
        maxOutputTokens: undefined,
        reasoning: undefined,
        releasedAtSeconds: undefined,
      })
    ).toBeUndefined();
  });

  it('drops a row missing a per-token rate leg', () => {
    const inputOnly = descriptorOf({ id: 'half/model', inputRate: 1n, contextLength: 1000 });
    expect(smartModelPool([inputOnly])).toEqual([]);
  });

  describe('the two carriers agree on a cap the money layer would once have floored', () => {
    // A non-integer cap is the one shape that used to leave the server pool a
    // strict superset of the client's: the wire contract refuses the row, while
    // the money layer floored it and kept it — so the classifier could route onto
    // a model the client never received. Both draws are run here rather than
    // reasoned about.
    it('drops a fractional context length from BOTH pools', () => {
      const frac = descriptorOf({
        id: 'frac/context',
        inputRate: 1n,
        outputRate: 2n,
        contextLength: 1000.5,
      });
      expect(smartModelPool([frac])).toEqual([]);
      expect(clientPool([frac])).toEqual([]);
    });

    it('drops a fractional completion cap from BOTH pools', () => {
      const frac = descriptorOf({
        id: 'frac/cap',
        inputRate: 1n,
        outputRate: 2n,
        contextLength: 1000,
        maxOutputTokens: 500.5,
      });
      expect(smartModelPool([frac])).toEqual([]);
      expect(clientPool([frac])).toEqual([]);
    });
  });
});

/**
 * The client's pool, drawn the way `apps/web` draws it: off the rows this
 * service actually serves, through the SAME `poolModelFromWire` the client hook
 * calls. Nothing about the wire hop is rebuilt here, and that is the point — a
 * reconstruction would leave this pin green exactly when the shipped adapter
 * drifts, so the agreement it claims would stop being true without anything
 * going red.
 */
function clientPool(descriptors: readonly ModelDescriptor[]): readonly PriceableModel[] {
  return buildModelsListResponse(descriptors, NOW_MS).response.models.flatMap(
    (model: Model): PriceableModel[] => {
      const projected = poolModelFromWire(model);
      return projected === undefined ? [] : [projected];
    }
  );
}

/** The ids the CLIENT's picker would present as runnable for a smart-slot turn. */
function clientMenu(
  descriptors: readonly ModelDescriptor[],
  balanceNanoUsd: bigint,
  tier: UserTier
): readonly string[] {
  const set = getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(balanceNanoUsd),
      heldNanoUsd: nanoUSD(0n),
      payerTier: tier,
      payer: 'self',
    },
    {
      systemChars: 0,
      instructionChars: 0,
      historyChars: 0,
      inputChars: PROMPT_CHARS,
      attachmentBytes: 0,
    },
    {
      answerSources: { models: [], smartSlot: true },
      modality: 'text',
      pinned: {},
      webSearch: false,
    },
    { models: clientPool(descriptors), nowMs: NOW_MS }
  ).admissible;
  return set.sendable ? set.runnable.map((entry) => entry.modelId) : [];
}

describe('the server menu and the client picker', () => {
  /**
   * The four-row control, wide enough on its own for premium classification to
   * resolve a price threshold (the minimum pool size is four). Its threshold is
   * 30n and `mid/model` sits at it, so TWO rows — not one — are withheld from
   * every free menu below once the premium row joins them at the same rate.
   * This is the case the two pools measurably disagreed on.
   */
  const BASIC = [
    CHEAP,
    MID,
    descriptorOf({ id: 'a/one', inputRate: 2n, outputRate: 4n, contextLength: 100_000 }),
    descriptorOf({ id: 'b/two', inputRate: 3n, outputRate: 6n, contextLength: 100_000 }),
  ];
  /**
   * Premium on BOTH legs, and EITHER alone suffices — so these tests discriminate
   * neither, and no reader should take them as evidence about one. Measured on
   * this pool: rate-at-threshold plus a recent date is premium; dated back to
   * `OLD_RELEASE_SECONDS` it is still premium; dropped to a cheap rate but left
   * recent it is still premium; only both together turn it basic.
   *
   * The price leg is the one worth knowing about, because it is not obvious from
   * the fixture: this row's combined rate of 30n sits exactly AT the pool's
   * 75th-percentile threshold, which is also 30n. `mid/model` ties it at the same
   * rate and is dated outside the recency window, so `mid/model` is
   * withheld from the free menu on price alone — which is why the free menu below
   * is three rows and not four.
   *
   * The 900k window does no work in classification either — narrowing it to 100k
   * leaves the row premium. Its work is on the money side: it makes this row's
   * arrangement the costliest a paid hold must cover while keeping it under the
   * 20× pool-median multiple that would make it an `outlier(m)` and drop it out
   * of the classifier-selectable set. Nothing here measures that; the hold cases
   * that do live beside the compile, in the chat slice.
   */
  const PREMIUM = descriptorOf({
    id: 'z/premium',
    inputRate: 10n,
    outputRate: 20n,
    contextLength: 900_000,
    releasedAt: secondsAt(NOW_MS - DAY_MS),
  });
  const POOL = [...BASIC, PREMIUM];

  it('offers the free payer exactly what the free payer is shown', () => {
    expect(build(POOL, HUGE_BALANCE, 'free')?.candidates.map((entry) => entry.id)).toEqual(
      clientMenu(POOL, HUGE_BALANCE, 'free')
    );
  });

  it('offers the paid payer exactly what the paid payer is shown', () => {
    expect(build(POOL, HUGE_BALANCE, 'paid')?.candidates.map((entry) => entry.id)).toEqual(
      clientMenu(POOL, HUGE_BALANCE, 'paid')
    );
  });

  it('withholds the premium row from the free menu and keeps it on the paid one', () => {
    // The deliberate free-tier change, pinned in both directions: a tier-blind
    // build would put `z/premium` in both lists and this goes red if one comes
    // back.
    expect(build(POOL, HUGE_BALANCE, 'free')?.candidates.map((entry) => entry.id)).not.toContain(
      'z/premium'
    );
    expect(build(POOL, HUGE_BALANCE, 'paid')?.candidates.map((entry) => entry.id)).toContain(
      'z/premium'
    );
  });
});

describe('buildSmartModelCandidates', () => {
  it('gives each candidate its own affordable answer cap', () => {
    const built = build([CHEAP, MID], HUGE_BALANCE)!;
    const caps = new Map(built.candidates.map((entry) => [entry.id, entry.maxOutputTokens]));
    expect(caps.get('cheap/model')).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
    expect(caps.get('mid/model')).toBeGreaterThanOrEqual(MINIMUM_OUTPUT_TOKENS);
  });

  it('bounds a rich wallet by the catalog completion ceiling, not by the money', () => {
    const capped = descriptorOf({
      id: 'capped/model',
      inputRate: 1n,
      outputRate: 2n,
      contextLength: 100_000,
      maxOutputTokens: 2000,
    });
    expect(build([capped], HUGE_BALANCE)?.candidates[0]?.maxOutputTokens).toBe(2000);
  });

  it('carries each candidate description through for the classifier prompt', () => {
    expect(build([CHEAP, MID], HUGE_BALANCE)?.candidates[0]?.description).toBe('cheap and fast');
  });

  it('refuses the send when the wallet cannot fund a minimum answer anywhere', () => {
    expect(build([CHEAP, MID], 0n)).toBeNull();
  });

  it('refuses the send when nothing in the catalog is poolable', () => {
    const imageOnly = descriptorOf({
      id: 'draw/model',
      inputRate: 1n,
      outputRate: 2n,
      contextLength: 1000,
      outputs: ['image'],
    });
    expect(build([imageOnly], HUGE_BALANCE)).toBeNull();
  });

  it('builds the menu around a rate-less row rather than refusing on it', () => {
    // One unpriced catalog row must not take the feature down for every payer.
    const rateless = descriptorOf({ id: 'aaa/rateless', contextLength: 100_000 });
    expect(build([rateless, CHEAP], HUGE_BALANCE)?.candidates.map((entry) => entry.id)).toEqual([
      'cheap/model',
    ]);
  });

  it('runs the classification on the cheapest pool member per token', () => {
    expect(build([MID, CHEAP], HUGE_BALANCE)?.classifierModelId).toBe('cheap/model');
  });

  it('excludes a model the same turn pinned from the slot\u2019s candidates', () => {
    // The slot answers BESIDE the pinned siblings, so a candidate set that kept
    // one would let the slot resolve onto it — two answers from one model, both
    // priced and both billed, under two different tile labels.
    const third = descriptorOf({
      id: 'third/model',
      inputRate: 5n,
      outputRate: 10n,
      contextLength: 100_000,
    });
    const built = build([CHEAP, MID, third], HUGE_BALANCE, 'paid', ['cheap/model']);
    expect(built?.candidates.map((entry) => entry.id).toSorted()).toEqual([
      'mid/model',
      'third/model',
    ]);
  });

  it('refuses the send when every affordable model is already pinned', () => {
    expect(build([CHEAP], HUGE_BALANCE, 'paid', ['cheap/model'])).toBeNull();
  });

  describe('candidate order decides the fallback model', () => {
    // `smart-model-execution.ts` binds `node.candidates[0]` as the model that
    // RUNS whenever the classifier's answer names nothing in the list, so this
    // order is billed, not presented. The identifiers deliberately sort the
    // OPPOSITE way to the costs: a fixture whose ids are alphabetical in cost
    // order passes under a database row ordering too, and cannot tell the two
    // apart — which is exactly how a row-ordered menu once survived a green run.
    const EXPENSIVE = descriptorOf({
      id: 'a/expensive',
      inputRate: 30n,
      outputRate: 60n,
      contextLength: 100_000,
    });
    const MIDDLE = descriptorOf({
      id: 'm/middle',
      inputRate: 10n,
      outputRate: 20n,
      contextLength: 100_000,
    });
    const CHEAPEST = descriptorOf({
      id: 'z/cheap',
      inputRate: 1n,
      outputRate: 2n,
      contextLength: 100_000,
    });

    it('puts the cheapest eligible model first, not the first catalog row', () => {
      const built = build([EXPENSIVE, MIDDLE, CHEAPEST], HUGE_BALANCE)!;
      expect(built.candidates.map((entry) => entry.id)).toEqual([
        'z/cheap',
        'm/middle',
        'a/expensive',
      ]);
      expect(built.candidates[0]?.id).toBe('z/cheap');
    });

    it('names the same fallback whichever order the catalog rows arrive in', () => {
      expect(build([CHEAPEST, MIDDLE, EXPENSIVE], HUGE_BALANCE)?.candidates[0]?.id).toBe('z/cheap');
      expect(build([EXPENSIVE, MIDDLE, CHEAPEST], HUGE_BALANCE)?.candidates[0]?.id).toBe('z/cheap');
    });
  });
});

describe('pickEffortClassifier', () => {
  it('picks the cheapest pool member and prices its reserve over no model list', () => {
    const pick = pickEffortClassifier([MID, CHEAP])!;
    expect(pick.classifierModelId).toBe('cheap/model');
    expect(pick.classifierWorstCaseNanoUsd).toBe(classifierReserve(CHEAP, []));
  });

  it('resolves a cheapest-price tie on the identifier, whichever order it reads', () => {
    const twinB = descriptorOf({
      id: 'b/twin',
      inputRate: 1n,
      outputRate: 2n,
      contextLength: 100_000,
    });
    const twinA = descriptorOf({
      id: 'a/twin',
      inputRate: 1n,
      outputRate: 2n,
      contextLength: 100_000,
    });
    expect(pickEffortClassifier([twinB, twinA])?.classifierModelId).toBe('a/twin');
    expect(pickEffortClassifier([twinA, twinB])?.classifierModelId).toBe('a/twin');
  });

  it('skips a cheaper row the shared projection does not admit', () => {
    // The pick and the pool are the same set, so a row nothing can price never
    // reaches the classifier slot however cheap its declared leg is.
    const cheaperButUnpoolable = descriptorOf({
      id: 'aaa/no-context',
      inputRate: 1n,
      outputRate: 1n,
    });
    expect(pickEffortClassifier([cheaperButUnpoolable, CHEAP])?.classifierModelId).toBe(
      'cheap/model'
    );
  });

  it('returns null when no poolable model exists to classify with', () => {
    expect(pickEffortClassifier([descriptorOf({ id: 'half/model', inputRate: 1n })])).toBeNull();
  });
});

describe('smartModelMinimumNanoUsd', () => {
  it('is the balance at which the candidate builder stops returning null', () => {
    const minimum = smartModelMinimumNanoUsd({
      descriptors: [CHEAP, MID],
      pinned: [],
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      persists: true,
      webSearch: false,
      reasoningEffort: undefined,
    })!;
    expect(build([CHEAP, MID], minimum)).not.toBeNull();
    expect(build([CHEAP, MID], minimum - 1n)).toBeNull();
  });

  it('stops returning null at the same balance when the new message is part of the prompt', () => {
    // The menu and the threshold read the prompt in two shapes — a component
    // basis inside the menu, a pair of counts on the threshold — so a menu
    // reserving storage for the whole prompt would stop offering rows above the
    // balance the threshold names, and every row between the two is a candidate
    // the payer could in fact afford.
    const counts = { promptChars: PROMPT_CHARS * 10, inputChars: PROMPT_CHARS };
    const minimum = smartModelMinimumNanoUsd({
      descriptors: [CHEAP, MID],
      pinned: [],
      ...counts,
      persists: true,
      webSearch: false,
      reasoningEffort: undefined,
    })!;

    function menuAt(balanceNanoUsd: bigint): ReturnType<typeof buildSmartModelCandidates> {
      return buildSmartModelCandidates({
        descriptors: [CHEAP, MID],
        balanceNanoUsd,
        tier: 'paid',
        pinnedModelIds: [],
        ...counts,
        nowMs: NOW_MS,
        webSearch: false,
      });
    }

    expect(menuAt(minimum)).not.toBeNull();
    expect(menuAt(minimum - 1n)).toBeNull();
  });

  it('drops the storage terms when the turn’s content will not rest', () => {
    const persisting = smartModelMinimumNanoUsd({
      descriptors: [CHEAP, MID],
      pinned: [],
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      persists: true,
      webSearch: false,
      reasoningEffort: undefined,
    })!;
    const ephemeral = smartModelMinimumNanoUsd({
      descriptors: [CHEAP, MID],
      pinned: [],
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      persists: false,
      webSearch: false,
      reasoningEffort: undefined,
    })!;
    expect(ephemeral).toBeLessThan(persisting);
  });

  it('rises with the prompt, so a longer turn cannot freeze a payer on a shorter one’s price', () => {
    const shortPrompt = smartModelMinimumNanoUsd({
      descriptors: [CHEAP, MID],
      pinned: [],
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      persists: true,
      webSearch: false,
      reasoningEffort: undefined,
    })!;
    const longPrompt = smartModelMinimumNanoUsd({
      descriptors: [CHEAP, MID],
      pinned: [],
      promptChars: PROMPT_CHARS * 100,
      inputChars: PROMPT_CHARS * 100,
      persists: true,
      webSearch: false,
      reasoningEffort: undefined,
    })!;
    expect(longPrompt).toBeGreaterThan(shortPrompt);
  });

  it('adds the search reservation for the pinned siblings, and none for the slot', () => {
    const base = {
      descriptors: [CHEAP, MID],
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      persists: true,
      reasoningEffort: undefined,
    };
    const pinned = smartModelPool([MID]);
    const searchFree = smartModelMinimumNanoUsd({ ...base, pinned, webSearch: false })!;
    const withSearch = smartModelMinimumNanoUsd({ ...base, pinned, webSearch: true })!;
    // The pinned sibling's loop over a plain answer, at the minimum answer.
    const search = paidSearchTerms(MID);
    const plain = paidPlainTerms(MID);
    expect(withSearch - searchFree).toBe(
      search.fixed -
        plain.fixed +
        BigInt(MINIMUM_OUTPUT_TOKENS) * (search.perToken - plain.perToken)
    );
    // The slot resolves through a node with no tools field, so a turn whose only
    // answer source is the slot reserves nothing however the toggle is set.
    expect(smartModelMinimumNanoUsd({ ...base, pinned: [], webSearch: true })).toBe(
      smartModelMinimumNanoUsd({ ...base, pinned: [], webSearch: false })
    );
  });

  it('has no figure when nothing in the catalog prices a candidate', () => {
    expect(
      smartModelMinimumNanoUsd({
        descriptors: [descriptorOf({ id: 'half/model', inputRate: 1n })],
        pinned: [],
        promptChars: PROMPT_CHARS,
        inputChars: PROMPT_CHARS,
        persists: true,
        webSearch: false,
        reasoningEffort: undefined,
      })
    ).toBeUndefined();
  });
});

describe('the pinned siblings’ web search inside the candidate menu', () => {
  /**
   * A catalog whose context is wide enough that every ceiling below is MONEY
   * bound: a context-bound ceiling would be identical at every funding level,
   * so the loop's effect on the menu would be invisible and these tests would
   * pass without grading anything. Each menu has exactly one candidate, so no
   * classifier call is bought and the solve holds the siblings' terms alone.
   */
  const WIDE_CONTEXT = 10_000_000;
  const wide = (id: string, inputRate: bigint, outputRate: bigint): ModelDescriptor =>
    descriptorOf({ id, inputRate, outputRate, contextLength: WIDE_CONTEXT });
  const SLOT_ONLY_ROW = wide('aaa/model', 1n, 2n);
  const FIRST_PINNED = wide('bbb/model', 10n, 20n);
  const SECOND_PINNED = wide('ccc/model', 11n, 21n);
  const CATALOG = [SLOT_ONLY_ROW, FIRST_PINNED, SECOND_PINNED];
  /** Comfortably above two search loops, so every control below funds a menu. */
  const BALANCE = 4_000_000_000n;
  const INPUT_STORAGE_NANO = BigInt(PROMPT_CHARS) * 300n;

  function menuOrNull(
    catalog: readonly ModelDescriptor[],
    balanceNanoUsd: bigint,
    pinnedModelIds: readonly string[],
    webSearch: boolean
  ): SmartModelCandidates | null {
    return buildSmartModelCandidates({
      descriptors: catalog,
      balanceNanoUsd,
      tier: 'paid',
      pinnedModelIds,
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      nowMs: NOW_MS,
      webSearch,
    });
  }

  function capOf(built: SmartModelCandidates | null): number | undefined {
    const [only, ...rest] = built?.candidates ?? [];
    if (rest.length > 0) throw new Error('expected a one-candidate menu');
    return only?.maxOutputTokens;
  }

  /** The one shared token count the siblings' terms buy at `BALANCE`. */
  function sharedTokens(siblings: readonly PaidTerms[]): number {
    let fixed = INPUT_STORAGE_NANO;
    let perToken = 0n;
    for (const sibling of siblings) {
      fixed += sibling.fixed;
      perToken += sibling.perToken;
    }
    return Number((BALANCE - fixed) / perToken);
  }

  it('caps every candidate against funding the pinned sibling’s search has already taken', () => {
    const catalog = [SLOT_ONLY_ROW, FIRST_PINNED];
    const searching = menuOrNull(catalog, BALANCE, [FIRST_PINNED.id], true);
    expect(capOf(searching)).toBe(
      sharedTokens([paidSearchTerms(FIRST_PINNED), paidPlainTerms(SLOT_ONLY_ROW)])
    );
    // Non-vacuous: the same menu with search off caps strictly higher.
    const unreserved = menuOrNull(catalog, BALANCE, [FIRST_PINNED.id], false);
    expect(capOf(searching) ?? 0).toBeLessThan(capOf(unreserved) ?? 0);
  });

  it('takes one reservation per pinned sibling, never the slot-inclusive count', () => {
    const searching = menuOrNull(CATALOG, BALANCE, [FIRST_PINNED.id, SECOND_PINNED.id], true);
    expect(capOf(searching)).toBe(
      sharedTokens([
        paidSearchTerms(FIRST_PINNED),
        paidSearchTerms(SECOND_PINNED),
        paidPlainTerms(SLOT_ONLY_ROW),
      ])
    );
    // The slot charged a loop its node cannot carry grades elsewhere.
    expect(capOf(searching)).not.toBe(
      sharedTokens([
        paidSearchTerms(FIRST_PINNED),
        paidSearchTerms(SECOND_PINNED),
        paidSearchTerms(SLOT_ONLY_ROW),
      ])
    );
  });

  it('charges the slot nothing: a slot-only menu is identical with search on', () => {
    expect(menuOrNull(CATALOG, BALANCE, [], true)).toEqual(menuOrNull(CATALOG, BALANCE, [], false));
  });

  it('refuses the menu when the balance cannot cover the pinned sibling’s reservation', () => {
    const catalog = [SLOT_ONLY_ROW, FIRST_PINNED];
    const balance = paidSearchTerms(FIRST_PINNED).fixed - 1n;
    expect(menuOrNull(catalog, balance, [FIRST_PINNED.id], true)).toBeNull();
    // The same balance funds the same turn without the tool, so the refusal is
    // the loop's doing rather than an unaffordable catalog.
    expect(menuOrNull(catalog, balance, [FIRST_PINNED.id], false)).not.toBeNull();
  });
});

describe('the menu a pinned effort level is derived at', () => {
  /**
   * Budget-native reasoning rows (a `null` vocabulary offers the full ladder),
   * separated only by the completion cap the provider allows. `TIGHT`'s cap is
   * the High budget exactly, so High leaves nothing for an answer; `ROOMY`
   * clears it by the minimum viable answer. Nothing else distinguishes them,
   * so a menu difference between the two is the pin's doing and nothing else.
   */
  const HIGH_BUDGET_TOKENS = REASONING_BUDGET_TOKENS_BY_EFFORT.high;
  const reasoner = (id: string, maxOutputTokens: number): ModelDescriptor => ({
    ...descriptorOf({ id, inputRate: 1n, outputRate: 2n, contextLength: 100_000 }),
    limits: { contextLength: 100_000, maxOutputTokens },
    reasoning: { supportedEfforts: null },
  });
  const TIGHT = reasoner('tight/model', HIGH_BUDGET_TOKENS);
  const ROOMY = reasoner('roomy/model', HIGH_BUDGET_TOKENS + MINIMUM_OUTPUT_TOKENS);

  function pinnedBuild(effortPin?: CanonicalReasoningEffort): readonly string[] {
    const built = buildSmartModelCandidates({
      descriptors: [TIGHT, ROOMY],
      balanceNanoUsd: HUGE_BALANCE,
      tier: 'paid',
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      pinnedModelIds: [],
      webSearch: false,
      nowMs: NOW_MS,
      ...(effortPin === undefined ? {} : { effortPin }),
    });
    return built === null ? [] : built.candidates.map((candidate) => candidate.id);
  }

  it('offers both rows when the turn pins nothing — the classifier grades the axis', () => {
    expect(pinnedBuild()).toEqual([TIGHT.id, ROOMY.id]);
  });

  it('drops the row whose ceiling cannot fit the pinned rung', () => {
    // The one the pin excludes is the one whose cap leaves no answer beside the
    // rung's budget — so a pinned turn can never bind a model that would have
    // answered at some other rung than the one the sender asked for.
    expect(pinnedBuild('high')).toEqual([ROOMY.id]);
  });

  describe('the effort ceiling each candidate is annotated with', () => {
    const MAXED = reasoner(
      'maxed/model',
      REASONING_BUDGET_TOKENS_BY_EFFORT.max + MINIMUM_OUTPUT_TOKENS
    );

    function ceilings(descriptors: readonly ModelDescriptor[]): Map<string, string | undefined> {
      const built = buildSmartModelCandidates({
        descriptors,
        balanceNanoUsd: HUGE_BALANCE,
        tier: 'paid',
        promptChars: PROMPT_CHARS,
        inputChars: PROMPT_CHARS,
        pinnedModelIds: [],
        webSearch: false,
        nowMs: NOW_MS,
      });
      return new Map((built?.candidates ?? []).map((entry) => [entry.id, entry.effortCeiling]));
    }

    it('stamps each candidate with the highest rung its own ceiling holds', () => {
      // Three rows separated only by their completion caps, so the three
      // different answers are the caps' doing: TIGHT stops below High, ROOMY
      // clears High by a minimum answer, MAXED clears Max by one.
      expect(ceilings([TIGHT, ROOMY, MAXED])).toEqual(
        new Map([
          [TIGHT.id, 'Mid'],
          [ROOMY.id, 'High'],
          [MAXED.id, 'Max'],
        ])
      );
    });

    it('leaves a candidate that offers nothing on the axis unannotated', () => {
      // No reasoning metadata means no effort dimension at all, so there is no
      // ceiling to print — not a ceiling of the axis's lowest rung.
      expect(ceilings([CHEAP, MID])).toEqual(
        new Map([
          [CHEAP.id, undefined],
          [MID.id, undefined],
        ])
      );
    });
  });
});

describe('the per-rung menu an auto slot turn hands its classifier', () => {
  /**
   * A searching pinned sibling beside two candidates, all on a context wide
   * enough that every ceiling is money bound: the sibling's loop then takes more
   * funding at each higher rung, so the candidates' caps differ by rung. Every
   * row reasons on the full ladder (a `null` vocabulary) except the plain one.
   */
  const WIDE_CONTEXT = 10_000_000;
  const reasoningRow = (id: string, inputRate: bigint, outputRate: bigint): ModelDescriptor => ({
    ...descriptorOf({ id, inputRate, outputRate, contextLength: WIDE_CONTEXT }),
    limits: { contextLength: WIDE_CONTEXT, maxOutputTokens: 200_000 },
    reasoning: { supportedEfforts: null },
  });
  const PLAIN = descriptorOf({
    id: 'aaa/plain',
    inputRate: 1n,
    outputRate: 2n,
    contextLength: WIDE_CONTEXT,
  });
  const LADDERED = reasoningRow('bbb/laddered', 2n, 4n);
  const SIBLING = reasoningRow('ccc/sibling', 10n, 20n);
  const CATALOG = [PLAIN, LADDERED, SIBLING];
  const BALANCE = 1_000_000_000n;

  /** The menu an `auto` send builds, or with `effortPin` a send that pins its rung. */
  function menu(
    webSearch: boolean,
    effortPin?: ResolvedReasoningEffort
  ): SmartModelCandidates | null {
    return buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: BALANCE,
      tier: 'paid',
      pinnedModelIds: [SIBLING.id],
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      nowMs: NOW_MS,
      webSearch,
      ...(effortPin === undefined ? { effortAuto: true } : { effortPin }),
    });
  }

  /** The admissible set the browser's picker reads for the same turn. */
  function producerSet(
    smartSlot: boolean,
    pin?: ResolvedReasoningEffort
  ): ReturnType<typeof getTurnOptions>['admissible'] {
    return getTurnOptions(
      {
        spendableNanoUsd: nanoUSD(BALANCE),
        heldNanoUsd: nanoUSD(0n),
        payerTier: 'paid',
        payer: 'self',
      },
      promptBasisFromTotal({ promptChars: PROMPT_CHARS, inputChars: PROMPT_CHARS }),
      {
        answerSources: { models: [modelId(SIBLING.id)], smartSlot },
        modality: 'text',
        pinned: pin === undefined ? {} : { effort: pin },
        webSearch: true,
      },
      { models: smartModelPool(CATALOG), nowMs: NOW_MS }
    ).admissible;
  }

  function availableRungs(set: ReturnType<typeof producerSet>): readonly string[] {
    return set.turnDimensions.flatMap((dimension) =>
      dimension.options.flatMap((option) =>
        option.availability.available ? [option.optionId] : []
      )
    );
  }

  function built(webSearch: boolean): SmartModelCandidates {
    const candidates = menu(webSearch);
    if (candidates === null) throw new Error('expected a menu');
    return candidates;
  }

  it('offers the classifier exactly the rungs the turn’s own menu marks available', () => {
    const rungs = availableRungs(producerSet(true));
    expect(rungs.length).toBeGreaterThan(1);
    expect(built(true).effortOptions.map((option) => option.optionId)).toEqual(rungs);
  });

  it('declares the loop of the highest rung the turn’s menu marks available', () => {
    const set = producerSet(true);
    expect(built(true).toolLoopEffort).toBe(set.toolLoopEffort);
    expect(built(true).toolLoopEffort).toBe(availableRungs(set).at(-1));
  });

  it('gives each candidate the browser’s own cap at every available rung', () => {
    const set = producerSet(true);
    const rungs = new Set(availableRungs(set));
    for (const candidate of built(true).candidates) {
      const row = set.all.find((entry) => entry.modelId === candidate.id);
      expect(candidate.rungCeilings).toEqual(
        Object.fromEntries(
          (row?.rungCeilings ?? [])
            .filter((rung) => rungs.has(rung.effort))
            .map((rung) => [rung.effort, rung.ceilingTokens])
        )
      );
    }
  });

  it('caps a candidate lower at a dearer rung of the searching sibling’s loop', () => {
    const rungs = built(true).effortOptions.map((option) =>
      ResolvedReasoningEffort.parse(option.optionId)
    );
    const [lowest] = rungs;
    const highest = rungs.at(-1);
    if (lowest === undefined || highest === undefined) throw new Error('expected rungs');
    const [first] = built(true).candidates;
    expect(first?.rungCeilings?.[highest] ?? 0).toBeLessThan(first?.rungCeilings?.[lowest] ?? 0);
  });

  it('runs each candidate at its cap for the loop the turn declares', () => {
    const candidates = built(true);
    const loop = candidates.toolLoopEffort;
    if (loop === undefined) throw new Error('expected a loop effort');
    for (const candidate of candidates.candidates) {
      expect(candidate.maxOutputTokens).toBe(candidate.rungCeilings?.[loop]);
    }
  });

  it('stamps no per-rung cap when no sibling searches', () => {
    expect(built(false).candidates.map((candidate) => candidate.rungCeilings)).toEqual(
      built(false).candidates.map(() => undefined)
    );
  });

  it('stamps no per-rung cap when the send pins its rung', () => {
    const pinned = menu(true, 'low');
    expect(pinned?.candidates.map((candidate) => candidate.rungCeilings)).toEqual(
      pinned?.candidates.map(() => undefined)
    );
  });

  it('stamps no per-rung cap on a send that leaves effort unselected', () => {
    const unselected = buildSmartModelCandidates({
      descriptors: CATALOG,
      balanceNanoUsd: BALANCE,
      tier: 'paid',
      pinnedModelIds: [SIBLING.id],
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      nowMs: NOW_MS,
      webSearch: true,
    });
    expect(unselected?.candidates.map((candidate) => candidate.rungCeilings)).toEqual(
      unselected?.candidates.map(() => undefined)
    );
  });

  it('caps each candidate of a Min send at the browser’s pin-off ceiling, with no per-rung cap', () => {
    const offSet = producerSet(true, 'off');
    const minSend = menu(true, 'off');
    expect(minSend?.candidates.length).toBeGreaterThan(0);
    for (const candidate of minSend?.candidates ?? []) {
      expect(candidate.rungCeilings).toBeUndefined();
      expect(candidate.maxOutputTokens).toBe(
        offSet.all.find((entry) => entry.modelId === candidate.id)?.ceilingTokens
      );
    }
  });

  it('reads a pinned turn’s classifier options and loop off that turn’s own menu', () => {
    const set = producerSet(false);
    const pick = pickEffortClassifier(CATALOG, {
      models: [SIBLING.id],
      balanceNanoUsd: BALANCE,
      tier: 'paid',
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      webSearch: true,
      nowMs: NOW_MS,
    });
    expect(pick?.effortOptions.map((option) => option.optionId)).toEqual(availableRungs(set));
    expect(pick?.toolLoopEffort).toBe(set.toolLoopEffort);
  });

  it('prices a searching sibling’s minimum at the loop of the rung the send pins', () => {
    const base = {
      descriptors: CATALOG,
      pinned: smartModelPool([SIBLING]),
      promptChars: PROMPT_CHARS,
      inputChars: PROMPT_CHARS,
      persists: true,
    };
    const lite = smartModelMinimumNanoUsd({ ...base, webSearch: true, reasoningEffort: 'lite' });
    const max = smartModelMinimumNanoUsd({ ...base, webSearch: true, reasoningEffort: 'max' });
    expect(lite ?? 0n).toBeLessThan(max ?? 0n);
    // Without the tool no loop is priced, so the rung moves nothing.
    expect(smartModelMinimumNanoUsd({ ...base, webSearch: false, reasoningEffort: 'lite' })).toBe(
      smartModelMinimumNanoUsd({ ...base, webSearch: false, reasoningEffort: 'max' })
    );
  });
});
