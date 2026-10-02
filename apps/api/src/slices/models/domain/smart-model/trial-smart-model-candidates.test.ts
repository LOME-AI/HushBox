import { describe, expect, it } from 'vitest';
import { buildTurnSystemPrompt, utcDayKey } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS, TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { perImagePricingFixture, tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { buildTrialSmartModelCandidates } from './trial-smart-model-candidates.js';
import type { CanonicalReasoningEffort, Modality, ModelDescriptor } from '@hushbox/shared';

/** A fixed reference clock (ms) well past the old releases. */
const NOW_MS = TEST_DAY_START;

/**
 * The built system prompt the send carries, which the candidate builder prices as
 * part of every candidate's message base — the same characters the route measures
 * the turn budget with. A fixture prompt therefore spends this many characters
 * before the caller's own prompt buys a single input token.
 */
const SYSTEM_PROMPT_CHARS = buildTurnSystemPrompt({ utcDay: utcDayKey(new Date(NOW_MS)) }).length;

function descriptorOf(params: {
  readonly id: string;
  readonly inputRate: bigint;
  readonly outputRate: bigint;
  readonly releasedAt?: number;
  readonly outputs?: readonly Modality[];
  readonly inputs?: readonly Modality[];
  readonly description?: string;
  readonly pricing?: ModelDescriptor['pricing'];
  readonly reasoning?: ModelDescriptor['reasoning'];
  readonly contextLength?: number;
  readonly maxOutputTokens?: number;
}): ModelDescriptor {
  const pricing: ModelDescriptor['pricing'] =
    params.pricing ?? tokenPricingFixture({ input: params.inputRate, output: params.outputRate });
  return {
    id: params.id,
    provider: 'openrouter',
    version: '1',
    inputs: [...(params.inputs ?? ['text'])],
    outputs: [...(params.outputs ?? ['text'])],
    parameters: {},
    behaviors: ['streaming'],
    limits: {
      contextLength: params.contextLength ?? 100_000,
      ...(params.maxOutputTokens === undefined ? {} : { maxOutputTokens: params.maxOutputTokens }),
    },
    pricing,
    zdrReachable: true,
    releasedAt: params.releasedAt ?? OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...(params.description === undefined ? {} : { description: params.description }),
    ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
  };
}

const CHEAP = descriptorOf({
  id: 'cheap/model',
  inputRate: 1n,
  outputRate: 2n,
  description: 'cheap and fast',
});
const MID = descriptorOf({ id: 'mid/model', inputRate: 10n, outputRate: 20n });
// Top price quartile of the text catalog — premium by percentile.
const DEAR = descriptorOf({ id: 'dear/model', inputRate: 1000n, outputRate: 2000n });
// Cheap but released "now" — premium by recency.
const RECENT = descriptorOf({
  id: 'recent/model',
  inputRate: 1n,
  outputRate: 2n,
  releasedAt: secondsAt(NOW_MS),
});
const IMAGE = descriptorOf({
  id: 'img/model',
  inputRate: 1n,
  outputRate: 1n,
  outputs: ['image'],
  pricing: perImagePricingFixture({ anchor: 40n, dearest: 40n }),
});
const VISION_INPUT = descriptorOf({
  id: 'vision/model',
  inputRate: 1n,
  outputRate: 1n,
  inputs: ['text', 'image'],
});

/** Expensive text decoys that push the price percentile up without ever
 * qualifying themselves, so a lone cheap fixture stays below the quartile. */
function dearDecoys(): ModelDescriptor[] {
  return [1, 2, 3].map((index) =>
    descriptorOf({
      id: `decoy-${String(index)}/model`,
      inputRate: 1_000_000n,
      outputRate: 1_000_000n,
    })
  );
}

/** The ids the trial menu admits for one catalog at one prompt size; empty when
 * the send is refused outright. */
function admittedIds(
  descriptors: readonly ModelDescriptor[],
  promptCharacterCount: number
): readonly string[] {
  const built = buildTrialSmartModelCandidates({
    descriptors,
    nowMs: NOW_MS,
    promptCharacterCount,
  });
  return built === null ? [] : built.candidates.map((candidate) => candidate.id);
}

/**
 * The trial tier's input ratio: every non-paid tier estimates two characters to
 * the input token, so one whole token is two characters. The bisection steps by
 * a token because a finer step is not a different price.
 */
const CHARS_PER_INPUT_TOKEN = 2;

/**
 * The longest send this catalog still admits — found by bisecting the builder
 * itself rather than by re-deriving the ceiling, which would only transcribe the
 * producer the menu is now graded by. Admission shrinks monotonically as the
 * prompt grows, and the caller asserts that the figure this returns is genuinely
 * the last admitted one, so a non-monotone builder fails rather than silently
 * yielding a number.
 */
function largestAdmittedPromptChars(descriptors: readonly ModelDescriptor[]): number {
  let admittedTokens = 0;
  let refusedTokens = 1_000_000;
  while (refusedTokens - admittedTokens > 1) {
    const middle = Math.floor((admittedTokens + refusedTokens) / 2);
    if (admittedIds(descriptors, middle * CHARS_PER_INPUT_TOKEN).length > 0) {
      admittedTokens = middle;
    } else {
      refusedTokens = middle;
    }
  }
  return admittedTokens * CHARS_PER_INPUT_TOKEN;
}

describe('buildTrialSmartModelCandidates', () => {
  it('keeps every trial-eligible text model, with the cheapest per token as classifier', () => {
    // The decoys spread the price percentile AND are themselves premium on the
    // minimal-exchange leg. VISION_INPUT (text+image input, text output) is a
    // runnable text model — Smart Model only ever sends text — so it qualifies
    // and, being cheapest, drives the classifier; cheap + mid follow.
    //
    // The ORDER is the producer's own, asserted where the producer is
    // (`candidates.test.ts`); this case reads it only as the menu's membership.
    const result = buildTrialSmartModelCandidates({
      descriptors: [MID, CHEAP, RECENT, IMAGE, VISION_INPUT, ...dearDecoys()],
      nowMs: NOW_MS,
      promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
    });
    expect(result?.classifierModelId).toBe('vision/model');
    expect(result?.candidates.map((candidate) => candidate.id)).toEqual([
      'vision/model',
      'cheap/model',
      'mid/model',
    ]);
  });

  it('excludes a top-price-quartile model as premium', () => {
    // Without the decoy spread, DEAR tops the four-model text distribution.
    const result = buildTrialSmartModelCandidates({
      descriptors: [
        DEAR,
        MID,
        CHEAP,
        descriptorOf({ id: 'low/model', inputRate: 1n, outputRate: 1n }),
      ],
      nowMs: NOW_MS,
      promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
    });
    expect(result?.candidates.map((candidate) => candidate.id)).not.toContain('dear/model');
  });

  it('carries descriptions through and omits them where the catalog has none', () => {
    const result = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, MID, ...dearDecoys()],
      nowMs: NOW_MS,
      promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
    });
    expect(result?.candidates[0]?.id).toBe('cheap/model');
    expect(result?.candidates[0]?.description).toBe('cheap and fast');
    expect(result?.candidates[1]?.id).toBe('mid/model');
    // Omitted, never carried as an explicit `undefined`: the classifier prompt
    // renders the field it is given.
    expect(result?.candidates[1]).not.toHaveProperty('description');
  });

  it('excludes a candidate whose per-message base cannot be priced (missing rates)', () => {
    // A text row priced by the image, with no per-token rate: the pool
    // projection admits only token-priced models, so it never reaches the menu
    // and never takes the classifier pick.
    const partial = descriptorOf({
      id: 'partial/model',
      inputRate: 1n,
      outputRate: 1n,
      pricing: perImagePricingFixture({ anchor: 50n, dearest: 50n }),
    });
    const result = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, partial, ...dearDecoys()],
      nowMs: NOW_MS,
      promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
    });
    expect(result?.candidates.map((candidate) => candidate.id)).toEqual(['cheap/model']);
  });

  it('keeps a candidate at the cap boundary and drops it one input token over', () => {
    const catalog = [CHEAP, ...dearDecoys()];
    const boundary = largestAdmittedPromptChars(catalog);
    // The flip is as sharp as the basis allows: the cap plays the wallet's part,
    // and a trial send grows out of it one input token at a time.
    expect(admittedIds(catalog, boundary)).toEqual(['cheap/model']);
    expect(admittedIds(catalog, boundary + CHARS_PER_INPUT_TOKEN)).toEqual([]);
  });

  it('prices EVERY character the route counted, custom instructions included', () => {
    // The gate's basis is the route's own `promptCharacterCount`, which folds in
    // the system prompt, custom instructions, history and the input. A send that
    // fits without instructions and not with them must be refused WITH them —
    // this is the arm that admitted a 1.192¢ turn while pricing 0.98¢.
    //
    // 5,000 characters is `InferenceRequest.customInstructions`' current schema
    // maximum, i.e. the worst case. The figure is not load-bearing: the property
    // is that ANY character the route counted is priced here, so a smaller one
    // would pin the same thing less sharply.
    const instructionChars = 5000;
    const catalog = [CHEAP, ...dearDecoys()];
    // The longest send this catalog admits, less the instructions less one input
    // token: it fits with room to spare while they are unpriced, and only
    // pricing them can push it over.
    const withoutInstructions =
      largestAdmittedPromptChars(catalog) - instructionChars + CHARS_PER_INPUT_TOKEN;
    expect(admittedIds(catalog, withoutInstructions)).toEqual(['cheap/model']);
    expect(admittedIds(catalog, withoutInstructions + instructionChars)).toEqual([]);
  });

  it('returns null when the classifier reserve alone meets the cap, even at the smallest answer rate', () => {
    // Old and below-percentile (the decoys spread the distribution), so nothing
    // about the tier withholds it — but the classifier reserve at its input rate
    // already swallows the whole per-message ceiling, leaving no answer to fund.
    const steep = descriptorOf({ id: 'steep/model', inputRate: 6000n, outputRate: 1n });
    const result = buildTrialSmartModelCandidates({
      descriptors: [steep, ...dearDecoys()],
      nowMs: NOW_MS,
      promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
    });
    expect(result).toBeNull();
  });

  it('returns null when no text model is trial-eligible', () => {
    const result = buildTrialSmartModelCandidates({
      descriptors: [RECENT, IMAGE],
      nowMs: NOW_MS,
      promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
    });
    expect(result).toBeNull();
  });

  it('returns null for an empty catalog', () => {
    expect(
      buildTrialSmartModelCandidates({ descriptors: [], nowMs: NOW_MS, promptCharacterCount: 2 })
    ).toBeNull();
  });

  it('excludes an unpriceable model at the gate instead of poisoning the whole list', () => {
    // A model with no per-token rates cannot be priced at all, so it is out of
    // the pool (fail-closed = drop the model, never the whole menu); the
    // priceable MID drives the list, which still builds.
    const rateless = descriptorOf({
      id: 'free/model',
      inputRate: 1n,
      outputRate: 1n,
      pricing: perImagePricingFixture({ anchor: 1n, dearest: 1n }),
    });
    const result = buildTrialSmartModelCandidates({
      descriptors: [rateless, MID, ...dearDecoys()],
      nowMs: NOW_MS,
      promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
    });
    expect(result?.classifierModelId).toBe('mid/model');
    expect(result?.candidates.map((candidate) => candidate.id)).not.toContain('free/model');
  });

  it('supports a single-eligible list (the run then short-circuits the classifier)', () => {
    const result = buildTrialSmartModelCandidates({
      descriptors: [CHEAP, ...dearDecoys()],
      nowMs: NOW_MS,
      promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
    });
    expect(result?.classifierModelId).toBe('cheap/model');
    expect(result?.candidates).toHaveLength(1);
  });
});

describe('a pinned reasoning level grades the trial menu', () => {
  /** Three enumerated rungs, so the canonical ladder is Low < Mid < High. */
  const REASONER = descriptorOf({
    id: 'reasoner/model',
    inputRate: 10n,
    outputRate: 20n,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
  });

  const CATALOG = [CHEAP, REASONER, ...dearDecoys()];
  const BASE = {
    descriptors: CATALOG,
    nowMs: NOW_MS,
    promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
  };

  /**
   * Budget-native reasoning rows (a `null` vocabulary offers the full ladder),
   * each paired with the cheap, ladderless row the pin withholds on its own —
   * so an empty menu is the reasoning row's refusal and nothing else. The dear
   * decoys spread the price percentile, keeping both rows below the quartile.
   */
  const reasoner = (id: string, outputRate: bigint, maxOutputTokens?: number): ModelDescriptor =>
    descriptorOf({
      id,
      inputRate: 1n,
      outputRate,
      reasoning: { supportedEfforts: null },
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    });

  /** The ids the menu admits for a cheaply-priced reasoning row at one declared
   * completion cap, beside the ladderless cheap row; empty when the send is
   * refused outright. */
  function cappedMenu(
    maxOutputTokens: number,
    effortPin?: CanonicalReasoningEffort
  ): readonly string[] {
    const built = buildTrialSmartModelCandidates({
      descriptors: [reasoner('tight/model', 2n, maxOutputTokens), CHEAP, ...dearDecoys()],
      nowMs: NOW_MS,
      promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
      ...(effortPin === undefined ? {} : { effortPin }),
    });
    return built === null ? [] : built.candidates.map((candidate) => candidate.id);
  }

  /**
   * The smallest declared completion cap at which `tight/model` can still offer
   * the High rung — bisected out of the builder, as
   * {@link largestAdmittedPromptChars} is for the prompt, rather than named from
   * the rung's token budget: that budget is a money-layer internal this file has
   * no door onto, and transcribing it would pin the fixture to one
   * implementation of the rule instead of to the rule. Offerability grows
   * monotonically with the cap, and the caller asserts both sides of the figure,
   * so a non-monotone builder fails the case rather than silently yielding a
   * number.
   */
  function smallestCapOfferingHigh(): number {
    let refused = 0;
    let offered = 1_000_000;
    while (offered - refused > 1) {
      const middle = Math.floor((refused + offered) / 2);
      if (cappedMenu(middle, 'high').includes('tight/model')) offered = middle;
      else refused = middle;
    }
    return offered;
  }

  it('withholds a candidate that can offer no rung at all', () => {
    const open = buildTrialSmartModelCandidates(BASE);
    const pinned = buildTrialSmartModelCandidates({ ...BASE, effortPin: 'low' });
    expect(open?.candidates.map((candidate) => candidate.id)).toContain('cheap/model');
    expect(pinned?.candidates.map((candidate) => candidate.id)).toEqual(['reasoner/model']);
  });

  it('leaves the classifier on the cheapest pool row the pin withholds as an ANSWER', () => {
    // The classifier routes, it does not answer, so the pin is none of its
    // business — and the reserve the menu was graded against is priced for THIS
    // engine, so moving the pick here would reserve for one call and buy another.
    expect(buildTrialSmartModelCandidates(BASE)?.classifierModelId).toBe('cheap/model');
    expect(buildTrialSmartModelCandidates({ ...BASE, effortPin: 'low' })?.classifierModelId).toBe(
      'cheap/model'
    );
  });

  it('keeps a candidate that resolves the pin down onto its own ladder', () => {
    // The ladder tops out at High, so a Max pin lands there rather than
    // withholding the row (§Reasoning Effort 10(a)).
    const pinned = buildTrialSmartModelCandidates({ ...BASE, effortPin: 'max' });
    expect(pinned?.candidates.map((candidate) => candidate.id)).toEqual(['reasoner/model']);
  });

  it('refuses the send when no candidate can offer the pinned rung', () => {
    // Null is this builder's refusal signal — the same one an over-cap send
    // gets, and the one §Reasoning Effort 3 requires of a pin nothing can honour.
    expect(
      buildTrialSmartModelCandidates({
        ...BASE,
        descriptors: [CHEAP, ...dearDecoys()],
        effortPin: 'low',
      })
    ).toBeNull();
  });

  it('withholds a candidate whose completion cap cannot hold the pinned rung beside a minimum answer', () => {
    const smallest = smallestCapOfferingHigh();
    expect(cappedMenu(smallest, 'high')).toContain('tight/model');
    // One token under that cap the row is still an unpinned candidate, so what
    // the pin withholds it for is the rung needing room beside an answer — not
    // a cap too small to answer at all, which withholds it either way.
    expect(cappedMenu(smallest - 1)).toContain('tight/model');
    expect(
      buildTrialSmartModelCandidates({
        descriptors: [reasoner('tight/model', 2n, smallest - 1), CHEAP, ...dearDecoys()],
        nowMs: NOW_MS,
        promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
        effortPin: 'high',
      })
    ).toBeNull();
  });

  it('withholds a candidate whose pinned rung the one-cent cap cannot fund', () => {
    const dearRung = reasoner('dear-rung/model', 400n);
    expect(
      buildTrialSmartModelCandidates({
        descriptors: [dearRung, CHEAP, ...dearDecoys()],
        nowMs: NOW_MS,
        promptCharacterCount: SYSTEM_PROMPT_CHARS + 2,
        effortPin: 'high',
      })
    ).toBeNull();
  });
});
