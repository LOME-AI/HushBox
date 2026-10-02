import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, secondsAt } from '@hushbox/shared/test-time';
import { perImagePricingFixture, tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { turnMinCost } from './pricing.js';
import type { TurnPricingSelection, TurnPromptCounts } from './pricing.js';
import type {
  Modality,
  ModelDescriptor,
  ModelReasoning,
  ReasoningEffortSelection,
  TurnSource,
} from '@hushbox/shared';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/**
 * A catalog row the money layer can price: both per-token legs and a context
 * length. `outputs` and `reasoning` are the two axes these tests move — the
 * first decides whether the row can run the classifier call, the second how
 * many effort options the turn presents.
 */
function descriptorOf(params: {
  readonly id: string;
  readonly outputs: readonly Modality[];
  readonly reasoning?: ModelReasoning;
  readonly pricing?: ModelDescriptor['pricing'];
}): ModelDescriptor {
  return {
    id: params.id,
    provider: 'openrouter',
    version: '1',
    inputs: ['text'],
    outputs: [...params.outputs],
    parameters: {},
    behaviors: ['streaming'],
    limits: { contextLength: 8000, maxOutputTokens: 4000 },
    pricing: params.pricing ?? tokenPricingFixture({ input: 10n, output: 20n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
    ...(params.reasoning === undefined ? {} : { reasoning: params.reasoning }),
  };
}

/** Upstream enumerates efforts descending; two rungs make a choice exist. */
const TWO_RUNGS: ModelReasoning = { supportedEfforts: ['high', 'low'] };

const FREEZE_PROMPT_CHARS = 400;

/** The freeze's two counts, where the whole prompt is the new message. */
const FREEZE_COUNTS: TurnPromptCounts = {
  promptCharacterCount: FREEZE_PROMPT_CHARS,
  inputCharacterCount: FREEZE_PROMPT_CHARS,
};

/** A 4,000-character prompt, of which the given count is the new message. */
function countsOf(inputCharacterCount: number): TurnPromptCounts {
  return { promptCharacterCount: 4000, inputCharacterCount };
}

/** The Smart slot, as the freeze body's sources carry it. */
const SLOT = { kind: 'smart' } as const;

function freezeBody(
  sources: readonly TurnSource[],
  reasoningEffort?: ReasoningEffortSelection,
  webSearchEnabled?: boolean
): TurnPricingSelection {
  return {
    turnSources: [...sources],
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(webSearchEnabled === undefined ? {} : { webSearchEnabled }),
  };
}

/** One pinned model as a source list. */
function pinned(...ids: readonly string[]): TurnSource[] {
  return ids.map((id) => ({ kind: 'model', id }));
}

/** The freeze minimum where the turn does price one — the amount comparisons. */
function pricedMinimum(
  catalog: readonly ModelDescriptor[],
  sources: readonly TurnSource[],
  reasoningEffort?: ReasoningEffortSelection,
  webSearchEnabled?: boolean
): bigint {
  const priced = turnMinCost(
    catalog,
    freezeBody(sources, reasoningEffort, webSearchEnabled),
    FREEZE_COUNTS
  );
  if (priced === undefined) throw new Error('the turn priced no minimum');
  return priced;
}

describe('the payer freeze minimum and its classifier reserve', () => {
  it('composes a text turn minimum at a stated amount', () => {
    // The one assertion in this file that is not read back from the code under
    // test: every other expectation here compares two of `turnMinCost`'s own
    // outputs, so a change to the composition moves both sides and nothing
    // fails. A literal cannot move with it, which is the whole reason one
    // exists — and this is the file that owns the composition, so it is the
    // file the literal belongs in.
    const model = descriptorOf({ id: 'vendor/anchor', outputs: ['text'] });
    // 134 input tokens × 10 + 400 new characters × 300 + 640 framing characters
    // × 300 + 1,000 minimum answer tokens × (20 + 1,500 storage).
    expect(pricedMinimum([model], pinned(model.id))).toBe(1_833_340n);
  });

  it('prices no minimum for a classifying turn whose catalog holds no priceable engine', () => {
    const mediaOnly = descriptorOf({
      id: 'vendor/image',
      outputs: ['image'],
      reasoning: TWO_RUNGS,
    });
    expect(
      turnMinCost([mediaOnly], freezeBody(pinned(mediaOnly.id), 'auto'), FREEZE_COUNTS)
    ).toBeUndefined();
  });

  it('reserves nothing for an auto turn whose model presents fewer than two effort options', () => {
    const settled = descriptorOf({ id: 'vendor/settled', outputs: ['text'] });
    expect(pricedMinimum([settled], pinned(settled.id), 'auto')).toBe(
      pricedMinimum([settled], pinned(settled.id))
    );
  });

  it('reserves the classifier call for an auto turn that does classify', () => {
    const reasoner = descriptorOf({
      id: 'vendor/reasoner',
      outputs: ['text'],
      reasoning: TWO_RUNGS,
    });
    expect(pricedMinimum([reasoner], pinned(reasoner.id), 'auto')).toBeGreaterThan(
      pricedMinimum([reasoner], pinned(reasoner.id))
    );
  });
});

describe('the tool loop the payer freeze prices a searching turn at', () => {
  /** A mandatory Low/High ladder, so the lowest rung it offers is Low. */
  const MANDATORY_TWO_RUNGS: ModelReasoning = {
    supportedEfforts: ['high', 'low'],
    mandatory: true,
  };
  const LADDERED = descriptorOf({
    id: 'vendor/laddered',
    outputs: ['text'],
    reasoning: MANDATORY_TWO_RUNGS,
  });
  const LADDERLESS = descriptorOf({ id: 'vendor/ladderless', outputs: ['text'] });

  /** What turning search on adds to the minimum at one selection. */
  function searchTerm(model: ModelDescriptor, reasoningEffort?: ReasoningEffortSelection): bigint {
    return (
      pricedMinimum([model], pinned(model.id), reasoningEffort, true) -
      pricedMinimum([model], pinned(model.id), reasoningEffort, false)
    );
  }

  it('prices the loop of the rung the send pins', () => {
    expect(searchTerm(LADDERED, 'low')).toBeLessThan(searchTerm(LADDERED, 'high'));
  });

  it('prices an auto turn at the loop of the lowest rung its models offer', () => {
    expect(searchTerm(LADDERED, 'auto')).toBe(searchTerm(LADDERED, 'low'));
    expect(searchTerm(LADDERED, 'auto')).not.toBe(searchTerm(LADDERED, 'high'));
  });

  it('prices the ceiling loop for a turn with no reasoning ladder', () => {
    expect(searchTerm(LADDERLESS, 'auto')).toBe(searchTerm(LADDERLESS));
    expect(searchTerm(LADDERLESS, 'auto')).toBeGreaterThan(searchTerm(LADDERLESS, 'lite'));
  });
});

/**
 * The freeze reserves the storage settlement will actually bill: one new user
 * message row per turn. The system prompt never rests and every history
 * character was stored by the turn that wrote it, so a freeze priced over the
 * assembled prompt reserves a fee no settlement can charge — and it grows
 * without bound with the conversation.
 */
describe('the prompt storage the payer freeze reserves', () => {
  /** 3,600 characters at the 300 nano per-character storage rate. */
  const NARROWED_STORAGE = 3600n * 300n;

  it('prices a text turn’s storage over the new message, not the assembled prompt', () => {
    const model = descriptorOf({ id: 'vendor/anchor', outputs: ['text'] });
    const sources = pinned(model.id);
    const wholePromptIsNew = turnMinCost([model], freezeBody(sources), countsOf(4000));
    const shortNewMessage = turnMinCost([model], freezeBody(sources), countsOf(400));

    expect(wholePromptIsNew! - shortNewMessage!).toBe(NARROWED_STORAGE);
  });

  it('prices a media turn’s storage over the new message too', () => {
    const image = descriptorOf({
      id: 'vendor/image',
      outputs: ['image'],
      pricing: perImagePricingFixture({ anchor: 40_000_000n, dearest: 40_000_000n }),
    });
    const selection: TurnPricingSelection = {
      turnSources: pinned(image.id),
      modality: 'image',
    };
    const wholePromptIsNew = turnMinCost([image], selection, countsOf(4000));
    const shortNewMessage = turnMinCost([image], selection, countsOf(400));

    expect(wholePromptIsNew! - shortNewMessage!).toBe(NARROWED_STORAGE);
  });

  it('prices a Smart slot turn’s storage over the new message too', () => {
    const slotModel = descriptorOf({ id: 'vendor/slot', outputs: ['text'] });
    const wholePromptIsNew = turnMinCost([slotModel], freezeBody([SLOT]), countsOf(4000));
    const shortNewMessage = turnMinCost([slotModel], freezeBody([SLOT]), countsOf(400));

    expect(wholePromptIsNew! - shortNewMessage!).toBe(NARROWED_STORAGE);
  });
});

describe('the payer freeze minimum of a selection carrying the Smart slot', () => {
  const A = descriptorOf({ id: 'vendor/a', outputs: ['text'] });
  const B = descriptorOf({ id: 'vendor/b', outputs: ['text'] });
  const C = descriptorOf({ id: 'vendor/c', outputs: ['text'] });
  const CATALOG = [A, B, C];

  it('prices the pinned siblings beside the slot, not the slot alone', () => {
    // The slot's own minimum is the whole turn's minimum only when the slot is
    // the whole turn. Reading the first source and stopping priced a mixed
    // selection identically to Smart alone — roughly half the pinned pair's own
    // minimum — so the freeze compared group headroom against another turn.
    expect(pricedMinimum(CATALOG, [SLOT, ...pinned(A.id, B.id)])).toBeGreaterThan(
      pricedMinimum(CATALOG, [SLOT])
    );
  });

  it('prices no minimum when every model the slot could pick is already pinned', () => {
    expect(
      turnMinCost(CATALOG, freezeBody([SLOT, ...pinned(A.id, B.id, C.id)]), FREEZE_COUNTS)
    ).toBeUndefined();
  });

  it('prices a mixed selection identically whichever end the slot sits at', () => {
    expect(pricedMinimum(CATALOG, [SLOT, ...pinned(A.id)])).toBe(
      pricedMinimum(CATALOG, [...pinned(A.id), SLOT])
    );
  });

  it('reserves web search once per pinned sibling of a mixed turn, and never for the slot', () => {
    // The tool lands on the pinned siblings — the slot's own node carries no
    // tools field — so the freeze must reserve for them or it freezes a payer on
    // headroom admission then refuses. Read as a ratio rather than an amount:
    // the amount belongs to the money layer, but doubling the pinned siblings
    // must double the term, which a reservation that also bought the slot (3×
    // against 2×) or dropped the siblings (0) cannot satisfy.
    const onePinned =
      pricedMinimum(CATALOG, [SLOT, ...pinned(A.id)], undefined, true) -
      pricedMinimum(CATALOG, [SLOT, ...pinned(A.id)]);
    const twoPinned =
      pricedMinimum(CATALOG, [SLOT, ...pinned(A.id, B.id)], undefined, true) -
      pricedMinimum(CATALOG, [SLOT, ...pinned(A.id, B.id)]);
    expect(onePinned).toBeGreaterThan(0n);
    expect(twoPinned).toBe(onePinned * 2n);
  });

  it('reserves no web search for a slot-only turn, which puts the tool on nothing', () => {
    expect(pricedMinimum(CATALOG, [SLOT], undefined, true)).toBe(pricedMinimum(CATALOG, [SLOT]));
  });

  it('prices no minimum when a pinned sibling beside the slot is unknown', () => {
    expect(
      turnMinCost(CATALOG, freezeBody([SLOT, ...pinned('no/such-model')]), FREEZE_COUNTS)
    ).toBeUndefined();
  });
});

/**
 * Two selections a send cannot deliver: the shared turn-source list schema
 * requires at least one source, and the send and the regenerate bodies each
 * refuse a media turn carrying the Smart slot. Both refusals sit on the wire,
 * above pricing, so a direct call is what reaches either arm.
 */
describe('the payer freeze minimum of a selection the wire refuses', () => {
  const MODEL = descriptorOf({ id: 'vendor/text', outputs: ['text'] });

  it('prices no minimum for a selection naming no answer source', () => {
    expect(turnMinCost([MODEL], freezeBody([]), FREEZE_COUNTS)).toBeUndefined();
  });

  it('prices no minimum for a media selection whose only answer source is the Smart slot', () => {
    expect(
      turnMinCost([MODEL], { turnSources: [SLOT], modality: 'image' }, FREEZE_COUNTS)
    ).toBeUndefined();
  });
});

/**
 * The exclusion is a compile-time contract, so this is where it is asserted:
 * each directive below fails typecheck the moment {@link TurnPricingSelection}
 * stops refusing the field it names. A pre-built request rather than a fresh
 * literal on purpose — excess-property checking already rejects a literal, and
 * the object a route holds is never one.
 */
describe('the routing identity a turn price refuses to read', () => {
  const MODEL = descriptorOf({ id: 'vendor/priced', outputs: ['text'] });
  const CONVERSATION_ID = '00000000-0000-4000-8000-000000000001';

  it('refuses a request naming the conversation the turn runs on', () => {
    const selection = freezeBody(pinned(MODEL.id));
    const request = { ...selection, conversationId: CONVERSATION_ID };
    // @ts-expect-error -- a conversation id names where the turn runs and prices nothing; pricing must not accept a request carrying one
    const priced = turnMinCost([MODEL], request, FREEZE_COUNTS);
    expect(priced).toBe(turnMinCost([MODEL], selection, FREEZE_COUNTS));
  });

  it('refuses a request naming the branch the turn runs on', () => {
    const selection = freezeBody(pinned(MODEL.id));
    const request = { ...selection, forkId: CONVERSATION_ID };
    // @ts-expect-error -- a fork id picks a branch to run on, not a price; pricing must not accept a request carrying one
    const priced = turnMinCost([MODEL], request, FREEZE_COUNTS);
    expect(priced).toBe(turnMinCost([MODEL], selection, FREEZE_COUNTS));
  });
});
