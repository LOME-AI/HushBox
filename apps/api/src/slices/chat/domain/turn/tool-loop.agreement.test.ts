/**
 * The browser's hold for a searching turn against the server's estimate of the
 * send it compiles, whole hold, BY AMOUNT.
 *
 * The browser prices the tool loop through the shared producer
 * (`getTurnOptions`); the server prices the compiled definition through the run
 * estimator. Both expand the loop in the one shared estimator core, so the two
 * holds are one number. Every provider cap here binds below what the funding
 * buys, so the documented difference in where the two sides clamp a shared
 * token count (`ceiling.clamp-order.test.ts`) cannot reach the amounts.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ResolvedReasoningEffort, modelId, nanoUSD } from '@hushbox/shared';
import { getTurnOptions, toolCallCapFor, toolLoopStepsFor } from '@hushbox/shared/affordability';
import { OLD_RELEASE_SECONDS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import { buildSmartModelCandidates, createEstimateRun } from '../../../models/index.js';
import {
  compileSmartModelBuild,
  compileSmartModelSend,
  turnSiblings,
} from '../smart-model/turn.js';
import { CHAT_CLASSIFIER_NODE_ID } from './classifier.js';
import { compileMultiModelTurnOutcome, compileSingleTurn } from './definition.js';
import type { MultiModelTurnBuild, MultiModelTurnOutcome, TurnBudget } from './definition.js';
import type { ModelPricingResolver } from '../../../models/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Result } from '../../../../lib/result/index.js';
import type {
  ModelDescriptor,
  ModelReasoning,
  Node,
  UserTier,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { NanoUSD } from '@hushbox/shared';

/** The run estimator read as its hold's total. */
function createEstimateTotal(
  resolveModel: Parameters<typeof createEstimateRun>[0]
): (definition: WorkflowDefinition) => Result<NanoUSD, DomainError> {
  const reserve = createEstimateRun(resolveModel);
  return (definition) => reserve(definition).map((reservation) => reservation.totalNanoUsd);
}

type FundingSnapshot = Parameters<typeof getTurnOptions>[0];
type PromptBasis = Parameters<typeof getTurnOptions>[1];
type Selection = Parameters<typeof getTurnOptions>[2];
type PriceableModel = Parameters<typeof getTurnOptions>[3]['models'][number];
type TokenPricing = PriceableModel['pricing'];

const NOW_MS = TEST_DAY_START;

/** Far more than any hold below, so every sibling answers at its provider cap. */
const SPENDABLE = 10n ** 13n;

const CONTEXT_LENGTH = 200_000;

/** Two input rates, so a loop charged to the wrong sibling moves the amount. */
const FIRST = { id: 'vendor/first', input: 100n, output: 300n, cap: 2000 } as const;
const SECOND = { id: 'vendor/second', input: 150n, output: 200n, cap: 3000 } as const;
/** The Smart slot's one candidate: with nothing else to choose, no classifier runs. */
const CANDIDATE = { id: 'vendor/candidate', input: 50n, output: 120n, cap: 2500 } as const;

interface Row {
  readonly id: string;
  readonly input: bigint;
  readonly output: bigint;
  readonly cap: number;
  readonly reasoning?: ModelReasoning;
  /** A whole price, long-context tiers included, in place of the two base rates. */
  readonly pricing?: TokenPricing;
  readonly contextLength?: number;
}

function pricingOf(row: Row): TokenPricing {
  return row.pricing ?? tokenPricingFixture({ input: row.input, output: row.output });
}

function descriptorOf(row: Row): ModelDescriptor {
  return {
    id: row.id,
    provider: 'p',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming', 'tools'],
    limits: { contextLength: row.contextLength ?? CONTEXT_LENGTH, maxOutputTokens: row.cap },
    pricing: pricingOf(row),
    zdrReachable: true,
    releasedAt: OLD_RELEASE_SECONDS,
    fetchedAt: 0,
    ...(row.reasoning === undefined ? {} : { reasoning: row.reasoning }),
  };
}

function priceableOf(row: Row): PriceableModel {
  return {
    modelId: modelId(row.id),
    pricing: pricingOf(row),
    contextLength: row.contextLength ?? CONTEXT_LENGTH,
    providerCap: row.cap,
    reasoning: row.reasoning,
    releasedAtMs: OLD_RELEASE_SECONDS * 1000,
  };
}

/** 600 system + 300 history + 100 new-message characters. */
const BASIS: PromptBasis = {
  systemChars: 600,
  instructionChars: 0,
  historyChars: 300,
  inputChars: 100,
  attachmentBytes: 0,
};

/** A multi-model compile the test expects to build. */
function builtTurn(result: Result<MultiModelTurnOutcome, DomainError>): MultiModelTurnBuild {
  const outcome = result._unsafeUnwrap();
  if (outcome.kind !== 'built') throw new Error('expected a built turn');
  return outcome;
}

function budgetFor(tier: UserTier, spendableNanoUsd = SPENDABLE): TurnBudget {
  return {
    promptCharacterCount: 1000,
    inputCharacterCount: BASIS.inputChars,
    funding: { kind: tier === 'paid' ? 'purchased' : 'free', spendableNanoUsd },
  };
}

function browserHold(
  tier: UserTier,
  rows: readonly Row[],
  answerSources: Selection['answerSources']
): bigint {
  const funding: FundingSnapshot = {
    spendableNanoUsd: nanoUSD(SPENDABLE),
    heldNanoUsd: nanoUSD(0n),
    payerTier: tier,
    payer: 'self',
  };
  const options = getTurnOptions(
    funding,
    BASIS,
    { answerSources, modality: 'text', pinned: {}, webSearch: true },
    { models: rows.map((row) => priceableOf(row)), nowMs: NOW_MS }
  );
  if (options.holdNanoUsd === undefined) throw new Error('expected a sendable searching turn');
  return BigInt(options.holdNanoUsd);
}

function resolverOf(rows: readonly Row[]): ModelPricingResolver {
  const catalog = rows.map((row) => descriptorOf(row));
  return (id) => catalog.find((row) => row.id === id);
}

function serverHold(rows: readonly Row[], definition: WorkflowDefinition): bigint {
  return createEstimateTotal(resolverOf(rows))(definition)._unsafeUnwrap();
}

async function slotSend(tier: UserTier): Promise<WorkflowDefinition> {
  const catalog = [FIRST, CANDIDATE].map((row) => descriptorOf(row));
  const budget = budgetFor(tier);
  const picked = buildSmartModelCandidates({
    descriptors: catalog,
    balanceNanoUsd: SPENDABLE,
    tier,
    promptChars: budget.promptCharacterCount,
    inputChars: budget.inputCharacterCount,
    pinnedModelIds: [FIRST.id],
    webSearch: true,
    nowMs: NOW_MS,
  });
  if (picked === null) throw new Error('expected a buildable smart-model turn');
  const compiled = await compileSmartModelBuild(catalog, picked, {
    budget,
    siblings: turnSiblings(catalog, [FIRST.id], {
      budget,
      webSearchEnabled: true,
    })._unsafeUnwrap(),
  });
  const build = compiled._unsafeUnwrap();
  if (!build.buildable) throw new Error('expected a buildable smart-model turn');
  return build.definition;
}

describe.each<UserTier>(['paid', 'free'])('a searching turn held by a %s payer', (tier) => {
  it('holds the same amount on both sides for one pinned model', () => {
    const definition = compileSingleTurn(resolverOf([FIRST]), FIRST.id, {
      budget: budgetFor(tier),
      webSearchEnabled: true,
    })._unsafeUnwrap();

    expect(browserHold(tier, [FIRST], { models: [modelId(FIRST.id)], smartSlot: false })).toBe(
      serverHold([FIRST], definition)
    );
  });

  it('agrees on the loop itself, not on a figure without it', () => {
    const definition = compileSingleTurn(resolverOf([FIRST]), FIRST.id, {
      budget: budgetFor(tier),
      webSearchEnabled: true,
    })._unsafeUnwrap();
    const toolFree: WorkflowDefinition = {
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.type === 'modelCall' ? { ...node, tools: [], maxSteps: 1 } : node
      ),
    };

    expect(
      browserHold(tier, [FIRST], { models: [modelId(FIRST.id)], smartSlot: false })
    ).toBeGreaterThan(serverHold([FIRST], toolFree));
  });

  it('holds the same amount on both sides for two pinned models', () => {
    const build = builtTurn(
      compileMultiModelTurnOutcome(resolverOf([FIRST, SECOND]), [FIRST.id, SECOND.id], {
        budget: budgetFor(tier),
        webSearchEnabled: true,
      })
    );

    expect(
      browserHold(tier, [FIRST, SECOND], {
        models: [modelId(FIRST.id), modelId(SECOND.id)],
        smartSlot: false,
      })
    ).toBe(serverHold([FIRST, SECOND], build.definition));
  });

  it('holds the same amount on both sides for a pinned model beside the Smart slot', async () => {
    const definition = await slotSend(tier);

    expect(
      browserHold(tier, [FIRST, CANDIDATE], { models: [modelId(FIRST.id)], smartSlot: true })
    ).toBe(serverHold([FIRST, CANDIDATE], definition));
  });
});

/** A reasoner on the full ladder, whose provider cap clears the largest reasoning budget. */
const REASONER: Row = {
  id: 'vendor/reasoner',
  input: 10n,
  output: 30n,
  cap: 128_000,
  reasoning: { supportedEfforts: null },
};
/** A second reasoner, so a two-model turn shares one budget across two ladders. */
const SECOND_REASONER: Row = {
  id: 'vendor/second-reasoner',
  input: 12n,
  output: 36n,
  cap: 128_000,
  reasoning: { supportedEfforts: null },
};
/** The cheapest row, so it runs every auto turn's classifier. */
const ENGINE: Row = { id: 'aaa/engine', input: 1n, output: 2n, cap: 4000 };
/** A candidate with a ladder of its own, beside the engine in the slot's pool. */
const LADDERED_CANDIDATE: Row = {
  id: 'vendor/laddered-candidate',
  input: 20n,
  output: 60n,
  cap: 128_000,
  reasoning: { supportedEfforts: null },
};

/**
 * Money binds below the reasoners' caps at the dearer rungs' loops, so each
 * rung's own budget solve buys a different ceiling and a mismatched rung shows.
 */
const TIGHT = 600_000_000n;

function browserOptions(
  tier: UserTier,
  rows: readonly Row[],
  turn: Pick<Selection, 'answerSources' | 'pinned'>,
  spendableNanoUsd = TIGHT
): ReturnType<typeof getTurnOptions> {
  return getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(spendableNanoUsd),
      heldNanoUsd: nanoUSD(0n),
      payerTier: tier,
      payer: 'self',
    },
    BASIS,
    { ...turn, modality: 'text', webSearch: true },
    { models: rows.map((row) => priceableOf(row)), nowMs: NOW_MS }
  );
}

function holdOf(options: ReturnType<typeof getTurnOptions>): bigint {
  if (options.holdNanoUsd === undefined) throw new Error('expected a sendable searching turn');
  return BigInt(options.holdNanoUsd);
}

function availableRungs(options: ReturnType<typeof getTurnOptions>): readonly string[] {
  return options.admissible.turnDimensions.flatMap((dimension) =>
    dimension.options.flatMap((option) => (option.availability.available ? [option.optionId] : []))
  );
}

/** Each available rung's ceiling on the browser's row for one model. */
function browserRungCeilings(
  options: ReturnType<typeof getTurnOptions>,
  id: string
): Readonly<Record<string, number>> {
  const rungs = new Set(availableRungs(options));
  const row = options.admissible.all.find((entry) => entry.modelId === id);
  return Object.fromEntries(
    (row?.rungCeilings ?? [])
      .filter((rung) => rungs.has(rung.effort))
      .map((rung) => [rung.effort, rung.ceilingTokens])
  );
}

/** The tool-carrying answer node for one model. */
function searchingNode(
  definition: WorkflowDefinition,
  id: string
): Extract<Node, { type: 'modelCall' }> {
  const node = definition.nodes.find(
    (candidate): candidate is Extract<Node, { type: 'modelCall' }> =>
      candidate.type === 'modelCall' && candidate.model === id && candidate.tools.length > 0
  );
  if (node === undefined) throw new Error(`no searching node for ${id}`);
  return node;
}

function stepsAt(effort: ResolvedReasoningEffort | undefined): number {
  return toolLoopStepsFor(toolCallCapFor(effort));
}

function autoMultiModel(
  tier: UserTier,
  rows: readonly Row[],
  spendableNanoUsd = TIGHT
): WorkflowDefinition {
  const catalog = [...rows, ENGINE].map((row) => descriptorOf(row));
  return builtTurn(
    compileMultiModelTurnOutcome(
      resolverOf([...rows, ENGINE]),
      rows.map((row) => row.id),
      {
        catalog,
        budget: budgetFor(tier, spendableNanoUsd),
        webSearchEnabled: true,
        reasoningEffort: 'auto',
        nowMs: NOW_MS,
      }
    )
  ).definition;
}

/**
 * An `auto` send with a searching reasoner beside the Smart slot, at a funding
 * every provider cap binds below: where money binds, the slot's per-candidate
 * caps and its siblings' fit round one shared token count differently, a
 * difference that predates per-rung ceilings and is pinned nowhere as equal.
 */
async function autoSlotSend(tier: UserTier): Promise<WorkflowDefinition> {
  const rows = [REASONER, ENGINE, LADDERED_CANDIDATE];
  const compiled = await compileSmartModelSend(
    rows.map((row) => descriptorOf(row)),
    {
      budget: budgetFor(tier),
      classifyEffort: true,
      pinnedModels: [REASONER.id],
      webSearchEnabled: true,
      balanceNanoUsd: SPENDABLE,
      nowMs: NOW_MS,
    }
  );
  const build = compiled._unsafeUnwrap();
  if (!build.buildable) throw new Error('expected a buildable smart-model turn');
  return build.definition;
}

describe.each<UserTier>(['paid', 'free'])(
  'a searching reasoning turn held by a %s payer',
  (tier) => {
    const soloSources: Selection['answerSources'] = {
      models: [modelId(REASONER.id)],
      smartSlot: false,
    };
    const auto = browserOptions(tier, [REASONER, ENGINE], {
      answerSources: soloSources,
      pinned: {},
    });
    // Every rung the auto menu marks available is a rung a pin at the full funding
    // can send at, so each is a sendable pinned turn on both sides.
    const pinnedRungs = availableRungs(auto).map((rung) => ResolvedReasoningEffort.parse(rung));

    it('offers more than one rung to pin, so every rung below is exercised', () => {
      expect(pinnedRungs.length).toBeGreaterThan(1);
    });

    it('holds the same amount on both sides at every pinned rung', () => {
      for (const rung of pinnedRungs) {
        const definition = compileSingleTurn(resolverOf([REASONER, ENGINE]), REASONER.id, {
          budget: budgetFor(tier, TIGHT),
          webSearchEnabled: true,
          reasoningEffort: rung,
        })._unsafeUnwrap();
        const browser = browserOptions(tier, [REASONER, ENGINE], {
          answerSources: soloSources,
          pinned: { effort: rung },
        });
        expect(serverHold([REASONER, ENGINE], definition)).toBe(holdOf(browser));
      }
    });

    it('declares the pinned rung’s own loop steps', () => {
      for (const rung of pinnedRungs) {
        const definition = compileSingleTurn(resolverOf([REASONER, ENGINE]), REASONER.id, {
          budget: budgetFor(tier, TIGHT),
          webSearchEnabled: true,
          reasoningEffort: rung,
        })._unsafeUnwrap();
        expect(searchingNode(definition, REASONER.id).maxSteps).toBe(stepsAt(rung));
      }
    });

    it('holds the same amount on both sides for an auto turn', () => {
      expect(serverHold([REASONER, ENGINE], autoMultiModel(tier, [REASONER]))).toBe(holdOf(auto));
    });

    it('gives each available rung the browser’s own ceiling on an auto turn', () => {
      const rungs = browserRungCeilings(auto, REASONER.id);
      expect(new Set(Object.values(rungs)).size).toBeGreaterThan(1);
      expect(searchingNode(autoMultiModel(tier, [REASONER]), REASONER.id).rungCeilings).toEqual(
        rungs
      );
    });

    it('declares the loop and the ceiling of the highest available rung on an auto turn', () => {
      const node = searchingNode(autoMultiModel(tier, [REASONER]), REASONER.id);
      const loop = auto.admissible.toolLoopEffort;
      if (loop === undefined) throw new Error('expected a loop effort');
      expect(node.maxSteps).toBe(stepsAt(loop));
      expect(node.params['maxOutputTokens']).toBe(browserRungCeilings(auto, REASONER.id)[loop]);
    });

    it('stamps no per-rung ceiling on an auto turn that carries no tool', () => {
      const catalog = [REASONER, ENGINE].map((row) => descriptorOf(row));
      const definition = builtTurn(
        compileMultiModelTurnOutcome(resolverOf([REASONER, ENGINE]), [REASONER.id], {
          catalog,
          budget: budgetFor(tier, TIGHT),
          reasoningEffort: 'auto',
          nowMs: NOW_MS,
        })
      ).definition;
      expect(definition.nodes.some((node) => node.id === CHAT_CLASSIFIER_NODE_ID)).toBe(true);
      expect(
        definition.nodes.map((node) => (node.type === 'modelCall' ? node.rungCeilings : undefined))
      ).toEqual(definition.nodes.map(() => undefined));
    });

    it('holds the same amount on both sides for two pinned models on an auto turn', () => {
      const rows = [REASONER, SECOND_REASONER];
      const browser = browserOptions(tier, [...rows, ENGINE], {
        answerSources: {
          models: [modelId(REASONER.id), modelId(SECOND_REASONER.id)],
          smartSlot: false,
        },
        pinned: {},
      });
      const definition = autoMultiModel(tier, rows);
      expect(serverHold([...rows, ENGINE], definition)).toBe(holdOf(browser));
      for (const row of rows) {
        expect(searchingNode(definition, row.id).rungCeilings).toEqual(
          browserRungCeilings(browser, row.id)
        );
      }
    });

    it('holds the same amount on both sides for an auto turn beside the Smart slot', async () => {
      const rows = [REASONER, ENGINE, LADDERED_CANDIDATE];
      const browser = browserOptions(
        tier,
        rows,
        { answerSources: { models: [modelId(REASONER.id)], smartSlot: true }, pinned: {} },
        SPENDABLE
      );
      const definition = await autoSlotSend(tier);
      expect(serverHold(rows, definition)).toBe(holdOf(browser));
      expect(searchingNode(definition, REASONER.id).rungCeilings).toEqual(
        browserRungCeilings(browser, REASONER.id)
      );
    });
  }
);

/** The Smart slot beside a searching `REASONER`, compiled as the paid send compiles it. */
async function slotSendAt(
  tier: UserTier,
  rows: readonly Row[],
  effort: { readonly classifyEffort?: true; readonly reasoningOff?: true },
  spendableNanoUsd: bigint
): Promise<MultiModelTurnBuild> {
  const compiled = await compileSmartModelSend(
    rows.map((row) => descriptorOf(row)),
    {
      budget: budgetFor(tier, spendableNanoUsd),
      ...effort,
      pinnedModels: [REASONER.id],
      webSearchEnabled: true,
      balanceNanoUsd: spendableNanoUsd,
      nowMs: NOW_MS,
    }
  );
  const build = compiled._unsafeUnwrap();
  if (!build.buildable) throw new Error('expected a buildable smart-model turn');
  return build;
}

function slotCandidates(
  definition: WorkflowDefinition
): Extract<Node, { type: 'smartModel' }>['candidates'] {
  const slot = definition.nodes.find(
    (node): node is Extract<Node, { type: 'smartModel' }> => node.type === 'smartModel'
  );
  if (slot === undefined) throw new Error('expected a Smart Model slot');
  return slot.candidates;
}

/** The browser's ceiling for each candidate row it marks available. */
function browserCandidateCeilings(
  options: ReturnType<typeof getTurnOptions>
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    options.admissible.all.flatMap((entry) =>
      entry.kind === 'candidate' && entry.availability.available
        ? [[entry.modelId, entry.ceilingTokens]]
        : []
    )
  );
}

function hasClassifier(definition: WorkflowDefinition): boolean {
  return definition.nodes.some((node) => node.id === CHAT_CLASSIFIER_NODE_ID);
}

/** A funding at which the auto menu of a searching `REASONER` marks only its cheapest rung. */
const ONE_RUNG = 30_000_000n;

describe.each<UserTier>(['paid', 'free'])(
  'a searching reasoning turn whose menu marks one rung available, held by a %s payer',
  (tier) => {
    const solo = browserOptions(
      tier,
      [REASONER, ENGINE],
      { answerSources: { models: [modelId(REASONER.id)], smartSlot: false }, pinned: {} },
      ONE_RUNG
    );
    const [only] = availableRungs(solo);
    const rung = ResolvedReasoningEffort.parse(only);

    it('marks exactly one rung available', () => {
      expect(availableRungs(solo)).toHaveLength(1);
    });

    it('buys no classifier call on a non-slot turn', () => {
      expect(hasClassifier(autoMultiModel(tier, [REASONER], ONE_RUNG))).toBe(false);
    });

    /** The reasoning a turn pinned at the one available rung sends. */
    const pinnedReasoning = searchingNode(
      compileSingleTurn(resolverOf([REASONER, ENGINE]), REASONER.id, {
        budget: budgetFor(tier, ONE_RUNG),
        webSearchEnabled: true,
        reasoningEffort: rung,
      })._unsafeUnwrap(),
      REASONER.id
    ).params['reasoning'];

    it('runs the one available rung on a non-slot turn', () => {
      const node = searchingNode(autoMultiModel(tier, [REASONER], ONE_RUNG), REASONER.id);
      expect(node.maxSteps).toBe(stepsAt(rung));
      expect(node.params['reasoning']).toEqual(pinnedReasoning);
    });

    it('holds the same amount on both sides, with no reserve, on a non-slot turn', () => {
      expect(solo.setAsideNanoUsd).toBeDefined();
      expect(serverHold([REASONER, ENGINE], autoMultiModel(tier, [REASONER], ONE_RUNG))).toBe(
        holdOf(solo)
      );
    });

    describe('beside a Smart slot whose pool holds one candidate', () => {
      const rows = [REASONER, LADDERED_CANDIDATE];
      const browser = browserOptions(
        tier,
        rows,
        { answerSources: { models: [modelId(REASONER.id)], smartSlot: true }, pinned: {} },
        ONE_RUNG
      );

      it('marks exactly one rung available', () => {
        expect(availableRungs(browser)).toEqual([only]);
      });

      it('buys no classifier call', async () => {
        const build = await slotSendAt(tier, rows, { classifyEffort: true }, ONE_RUNG);
        expect(build.classifier).toBeUndefined();
        expect(hasClassifier(build.definition)).toBe(false);
      });

      it('runs the one available rung', async () => {
        const build = await slotSendAt(tier, rows, { classifyEffort: true }, ONE_RUNG);
        const node = searchingNode(build.definition, REASONER.id);
        expect(node.maxSteps).toBe(stepsAt(rung));
        expect(node.params['reasoning']).toEqual(pinnedReasoning);
      });

      it('holds the same amount on both sides, with no reserve', async () => {
        const build = await slotSendAt(tier, rows, { classifyEffort: true }, ONE_RUNG);
        expect(browser.setAsideNanoUsd).toBeDefined();
        expect(serverHold(rows, build.definition)).toBe(holdOf(browser));
      });
    });

    describe('beside a Smart slot whose model axis is open', () => {
      const rows = [REASONER, ENGINE, LADDERED_CANDIDATE];
      const browser = browserOptions(
        tier,
        rows,
        { answerSources: { models: [modelId(REASONER.id)], smartSlot: true }, pinned: {} },
        ONE_RUNG
      );

      it('still buys its call', async () => {
        const build = await slotSendAt(tier, rows, { classifyEffort: true }, ONE_RUNG);
        expect(availableRungs(browser)).toEqual([only]);
        expect(browser.setAsideNanoUsd).toBeUndefined();
        expect(hasClassifier(build.definition)).toBe(true);
      });
    });
  }
);

/** A funding at which money binds a Min send's candidates below their provider caps. */
const MIN_FUNDING = 100_000_000n;

describe.each<UserTier>(['paid', 'free'])(
  'a Smart slot search turn sent at Min, held by a %s payer',
  (tier) => {
    const rows = [REASONER, ENGINE, LADDERED_CANDIDATE];
    const browser = browserOptions(
      tier,
      rows,
      {
        answerSources: { models: [modelId(REASONER.id)], smartSlot: true },
        pinned: { effort: 'off' },
      },
      MIN_FUNDING
    );

    it('carries no per-rung record on any candidate', async () => {
      const build = await slotSendAt(tier, rows, { reasoningOff: true }, MIN_FUNDING);
      expect(slotCandidates(build.definition).map((candidate) => candidate.rungCeilings)).toEqual(
        slotCandidates(build.definition).map(() => undefined)
      );
    });

    it('gives each candidate the browser’s pin-off ceiling for it', async () => {
      const build = await slotSendAt(tier, rows, { reasoningOff: true }, MIN_FUNDING);
      const ceilings = browserCandidateCeilings(browser);
      expect(Object.values(ceilings).some((ceiling) => ceiling < LADDERED_CANDIDATE.cap)).toBe(
        true
      );
      expect(
        Object.fromEntries(
          slotCandidates(build.definition).map((candidate) => [
            candidate.id,
            candidate.maxOutputTokens,
          ])
        )
      ).toEqual(ceilings);
    });
  }
);

/**
 * A pinned searching Sonnet beside a Smart slot at a funding whose menu is Off and
 * Lite: the cheaper answers fit Lite's dearer loop and the mandatory candidate
 * does not, so its row carries a cap for Off alone. The per-rung records are
 * compared rather than the holds: at a funding that binds money, the slot's one
 * sibling cap and the browser's per-arrangement token counts round differently.
 */
describe('a Smart slot candidate the menu’s dearer rung leaves without a cap', () => {
  const SONNET: Row = {
    id: 'vendor/sonnet',
    input: 3450n,
    output: 17_250n,
    cap: 128_000,
    reasoning: { supportedEfforts: ['max', 'high', 'medium', 'low'] },
  };
  const MANDATORY_ENGINE: Row = {
    id: 'vendor/engine',
    input: 52n,
    output: 161n,
    cap: 16_384,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  };
  const MANDATORY: Row = {
    id: 'vendor/mandatory',
    input: 1000n,
    output: 5000n,
    cap: 64_000,
    reasoning: { supportedEfforts: ['high', 'medium', 'low'], mandatory: true },
  };
  const LADDERLESS: Row = { id: 'vendor/ladderless', input: 200n, output: 800n, cap: 16_000 };
  const OPEN: Row = {
    id: 'vendor/open',
    input: 300n,
    output: 1200n,
    cap: 64_000,
    reasoning: { supportedEfforts: null },
  };
  const rows = [SONNET, MANDATORY_ENGINE, MANDATORY, LADDERLESS, OPEN];
  const FUNDING = 710_000_000n;
  const browser = browserOptions(
    'paid',
    rows,
    { answerSources: { models: [modelId(SONNET.id)], smartSlot: true }, pinned: {} },
    FUNDING
  );

  async function send(): Promise<WorkflowDefinition> {
    const compiled = await compileSmartModelSend(
      rows.map((row) => descriptorOf(row)),
      {
        budget: budgetFor('paid', FUNDING),
        classifyEffort: true,
        pinnedModels: [SONNET.id],
        webSearchEnabled: true,
        balanceNanoUsd: FUNDING,
        nowMs: NOW_MS,
      }
    );
    const build = compiled._unsafeUnwrap();
    if (!build.buildable) throw new Error('expected a buildable smart-model turn');
    return build.definition;
  }

  it('offers Off and Lite, and the mandatory candidate a cap for Off alone', () => {
    expect(availableRungs(browser)).toEqual(['off', 'lite']);
    expect(browserRungCeilings(browser, MANDATORY.id)).toEqual({
      off: expect.any(Number),
    });
  });

  it('gives every candidate the browser’s own cap at each rung it can run, and none elsewhere', async () => {
    const candidates = slotCandidates(await send());
    expect(
      Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.rungCeilings]))
    ).toEqual(
      Object.fromEntries(
        candidates.map((candidate) => [candidate.id, browserRungCeilings(browser, candidate.id)])
      )
    );
  });

  it('leaves the mandatory candidate out of Lite’s figure, where its own cap would hold more', async () => {
    const definition = await send();
    const priced = (lite: boolean): bigint =>
      serverHold(rows, {
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.type === 'smartModel'
            ? {
                ...node,
                candidates: node.candidates.map((candidate) =>
                  candidate.id === MANDATORY.id && candidate.maxOutputTokens !== undefined
                    ? {
                        ...candidate,
                        rungCeilings: {
                          ...candidate.rungCeilings,
                          ...(lite ? { lite: candidate.maxOutputTokens } : {}),
                        },
                      }
                    : candidate
                ),
              }
            : node
        ),
      });
    expect(priced(false)).toBe(serverHold(rows, definition));
    expect(priced(false)).toBeLessThan(priced(true));
  });
});

/** The live long-context thresholds. */
const TIER_THRESHOLDS = [128_000, 200_000, 272_000] as const;

/** A rate multiple from 1 to 2, in basis points. */
const multipleArb = fc.integer({ min: 10_000, max: 20_000 });

/**
 * A token price: base rates from 50 to 80,000 nano, and up to two tiers at the
 * live thresholds, each rate its base times a multiple from 1 to 2 that never
 * falls from one tier to the next.
 */
const tokenPricingArb: fc.Arbitrary<TokenPricing> = fc
  .record({
    input: fc.bigInt({ min: 50n, max: 80_000n }),
    output: fc.bigInt({ min: 50n, max: 80_000n }),
    thresholds: fc.subarray([...TIER_THRESHOLDS], { maxLength: 2 }),
    inputMultiples: fc.array(multipleArb, { minLength: 2, maxLength: 2 }),
    outputMultiples: fc.array(multipleArb, { minLength: 2, maxLength: 2 }),
  })
  .map(({ input, output, thresholds, inputMultiples, outputMultiples }) => {
    const ascending = (values: readonly number[]): readonly bigint[] =>
      values.toSorted((a, b) => a - b).map(BigInt);
    const inMultiples = ascending(inputMultiples);
    const outMultiples = ascending(outputMultiples);
    const scaled = (rate: bigint, basisPoints: bigint | undefined): bigint =>
      (rate * (basisPoints ?? 10_000n) + 9999n) / 10_000n;
    return tokenPricingFixture({
      input,
      output,
      tiers: thresholds.map((abovePromptTokens, index) => ({
        abovePromptTokens,
        input: scaled(input, inMultiples[index]),
        output: scaled(output, outMultiples[index]),
      })),
    });
  });

/** A generated turn: its models, prompt, funding, search switch and pinned rung. */
interface TurnShape {
  readonly tier: UserTier;
  readonly rows: readonly Row[];
  readonly basis: PromptBasis;
  readonly spendableNanoUsd: bigint;
  readonly webSearch: boolean;
  readonly rung: ResolvedReasoningEffort | undefined;
}

/** One answering model: a generated price, a provider cap, and a full ladder or none. */
function rowArb(index: number, reasons: boolean): fc.Arbitrary<Row> {
  return fc
    .record({ pricing: tokenPricingArb, cap: fc.integer({ min: 1000, max: 64_000 }) })
    .map(({ pricing, cap }) => ({
      id: `vendor/generated-${String(index)}`,
      input: 0n,
      output: 0n,
      cap,
      pricing,
      contextLength: 1_000_000,
      ...(reasons ? { reasoning: { supportedEfforts: null } } : {}),
    }));
}

/**
 * A prompt whose history reaches past every live threshold: up to 900,000
 * characters, 300,000 tokens.
 */
const basisArb: fc.Arbitrary<PromptBasis> = fc.record({
  systemChars: fc.integer({ min: 0, max: 3000 }),
  instructionChars: fc.constant(0),
  historyChars: fc.oneof(
    fc.integer({ min: 0, max: 5000 }),
    fc.integer({ min: 380_000, max: 900_000 })
  ),
  inputChars: fc.integer({ min: 0, max: 3000 }),
  attachmentBytes: fc.constant(0),
});

/**
 * One to three models from `tokenPricingArb`, a prompt basis, funding, search on
 * or off, and a pinned rung when the models reason. A turn of several models is
 * funded far past every cap: where money binds, the two sides clamp the shared
 * token count in different orders by design (`ceiling.clamp-order.test.ts`), so
 * agreement there is not this property's claim.
 */
const turnShapeArb: fc.Arbitrary<TurnShape> = fc
  .record({
    count: fc.integer({ min: 1, max: 3 }),
    reasons: fc.boolean(),
    tier: fc.constantFrom<UserTier>('paid', 'free'),
    basis: basisArb,
    webSearch: fc.boolean(),
    rung: fc.constantFrom<ResolvedReasoningEffort>('low', 'medium', 'high'),
    funding: fc.bigInt({ min: 10n ** 8n, max: 10n ** 11n }),
  })
  .chain(({ count, reasons, tier, basis, webSearch, rung, funding }) =>
    fc
      .tuple(...Array.from({ length: count }, (_unused, index) => rowArb(index, reasons)))
      .map((rows) => ({
        tier,
        rows,
        basis,
        spendableNanoUsd: count === 1 ? funding : SPENDABLE,
        webSearch,
        rung: reasons ? rung : undefined,
      }))
  );

function promptCharsOf(basis: PromptBasis): number {
  return basis.systemChars + basis.instructionChars + basis.historyChars + basis.inputChars;
}

/** The browser's hold for the shape, or `undefined` when its send gate refuses the turn. */
function generatedBrowserHold(shape: TurnShape): bigint | undefined {
  const [first, ...rest] = shape.rows.map((row) => modelId(row.id));
  if (first === undefined) return undefined;
  const options = getTurnOptions(
    {
      spendableNanoUsd: nanoUSD(shape.spendableNanoUsd),
      heldNanoUsd: nanoUSD(0n),
      payerTier: shape.tier,
      payer: 'self',
    },
    shape.basis,
    {
      answerSources: { models: [first, ...rest], smartSlot: false },
      modality: 'text',
      pinned: shape.rung === undefined ? {} : { effort: shape.rung },
      webSearch: shape.webSearch,
    },
    { models: shape.rows.map((row) => priceableOf(row)), nowMs: NOW_MS }
  );
  return options.holdNanoUsd === undefined ? undefined : BigInt(options.holdNanoUsd);
}

/** The server's hold for the send the shape compiles, or `undefined` when it builds none. */
function generatedServerHold(shape: TurnShape): bigint | undefined {
  const budget: TurnBudget = {
    promptCharacterCount: promptCharsOf(shape.basis),
    inputCharacterCount: shape.basis.inputChars,
    funding: {
      kind: shape.tier === 'paid' ? 'purchased' : 'free',
      spendableNanoUsd: shape.spendableNanoUsd,
    },
  };
  const options = {
    budget,
    webSearchEnabled: shape.webSearch,
    ...(shape.rung === undefined ? {} : { reasoningEffort: shape.rung }),
  };
  const resolver = resolverOf(shape.rows);
  if (shape.rows.length === 1) {
    const [only] = shape.rows;
    if (only === undefined) return undefined;
    const definition = compileSingleTurn(resolver, only.id, options);
    if (definition.isErr()) return undefined;
    return serverHold(shape.rows, definition.value);
  }
  const outcome = compileMultiModelTurnOutcome(
    resolver,
    shape.rows.map((row) => row.id),
    options
  );
  if (outcome.isErr() || outcome.value.kind !== 'built') return undefined;
  return serverHold(shape.rows, outcome.value.definition);
}

describe('the browser’s hold against the server’s, generated by turnShapeArb', () => {
  it('is one amount wherever both sides price the turn', () => {
    let compared = 0;
    let comparedPastThreshold = 0;
    fc.assert(
      fc.property(turnShapeArb, (shape) => {
        const browser = generatedBrowserHold(shape);
        const server = generatedServerHold(shape);
        fc.pre(browser !== undefined && server !== undefined);
        compared += 1;
        // 600,000 characters are 200,000 prompt tokens, past the middle threshold.
        if (promptCharsOf(shape.basis) > 600_000) comparedPastThreshold += 1;
        expect(browser).toBe(server);
      })
    );
    // The amounts were compared on many turns, prompts past a threshold among them.
    expect(compared).toBeGreaterThan(100);
    expect(comparedPastThreshold).toBeGreaterThan(10);
  });
});
