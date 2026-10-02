/**
 * The single-model turn compile's ACCEPT-OR-REFUSE ANSWER does not move with a
 * model's one output modality. Its FITTED ANSWER CAP does. Both halves are
 * graded here, and they need different funding to be visible at all.
 *
 * `apps/api/src/slices/chat/routes.ts` states the first half three times — in
 * `trialGateRejection`'s docblock, in `trialTurnDefinitionOrRefusal`'s comment
 * on its gate call, and in `trialSingleTurnDefinition`'s docblock — and no row
 * driven through `POST /chat/trial` can bear on any of them: the eligibility
 * gate refuses every media descriptor with `MEDIA_TRIAL_BLOCKED` before the
 * compile those sentences describe ever runs. So the claim is graded here
 * instead, by driving {@link buildTurnDefinition} directly against seeded
 * catalog rows.
 *
 * Each case varies `outputs` ALONE across a body held fixed, so a difference in
 * the answer can only be the modality. The bodies span every axis the compile
 * does refuse on — reasoning metadata, per-token priceability, tool capability
 * — including the two shapes the live catalog actually holds for media
 * (a per-image price and a per-second price, no `contextLength`, no
 * `behaviors`), so an accept here is an accept of a real image or video row.
 * The invariance is measured over exactly that grid: these bodies and these
 * options, through {@link buildTurnDefinition}'s own compile.
 *
 * THE COMPILED CAP IS A DIFFERENT STORY, graded against
 * {@link ABOVE_FLOOR_BUDGET} rather than against the trial's own funding.
 * `compileSingleTurn` ends in the shared answer fit →
 * `fitAnswerCapToCeiling` (`apps/api/src/slices/chat/domain/turn/definition.ts`),
 * whose sweep prices each candidate cap through the canonical estimator, and the
 * estimator's `modelCeiling` (`apps/api/src/slices/models/domain/pricing/estimate-run.ts`)
 * branches on the descriptor's call-shape family. Measured by varying `outputs`
 * alone over {@link PRICEABLE_PLAIN}: at a spendable of 1e9 nano-USD the
 * compiled answer node carries `maxOutputTokens` 79999 for `['text']` and 1000
 * — the shared `MINIMUM_OUTPUT_TOKENS` floor — for `['image']` and `['video']`,
 * and raising the funding raises the text cap while the media arms stay at the
 * floor. The estimator prices a media call from a media basis — a per-image rate,
 * a `resolution` parameter — and an answer node carrying per-token rates supplies
 * neither, so the media arm's estimate ERRORS; `fitAnswerCapToCeiling`'s `fits()`
 * reads an error as "does not fit" and the sweep collapses to the floor. That same swallow is why the
 * accept/refuse answer stays invariant — the error never reaches the verdict.
 * Reading that branch takes a funding the trial's ceiling cannot supply: over
 * {@link PRICEABLE_PLAIN} the {@link TRIAL_BUDGET} figure seats all three
 * modalities on the floor, so every case driving it is blind to the branch by
 * construction — which is why {@link ABOVE_FLOOR_BUDGET} exists and why
 * {@link answerCap} is the only helper here that does not use the trial's.
 *
 * WHY THE MODALITY-BLINDNESS ABOVE IS SAFE RATHER THAN A HOLE, and where the
 * refusal lives instead: neither route hands this compile a media descriptor.
 * The trial route refuses one at its eligibility gate
 * (`MEDIA_TRIAL_BLOCKED`), and the paid route refuses one at
 * `textTurnModalityRefusal` (`apps/api/src/slices/chat/routes.ts`), both before
 * the compile. Each refusal is driven through its own route —
 * `apps/api/src/slices/chat/routes-trial-gates.integration.test.ts` and
 * `apps/api/src/slices/chat/routes-send-media.integration.test.ts` — and the
 * paid case is the one that fails if that gate is removed, because behind it the
 * compile accepts.
 *
 * The cap halves below therefore read a shape no route reaches: they grade the
 * compile's own sizing, and the live-media-row case records that a media row
 * derives no ceiling at all — it declares neither per-token rates nor a context
 * length — which is what an accept here would have shipped.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, modelCatalog } from '@hushbox/db';
import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { TRIAL_MESSAGE_COST_CAP_NANO_USD } from '../../../models/index.js';
import { TRIAL_TURN_HOOKS } from '../constants.js';
import { buildTurnDefinition } from './definition.js';
import type { Modality, ModelReasoning, ReasoningEffortSelection } from '@hushbox/shared';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { StoredPricing } from '../../../models/domain/catalog/normalize.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for turn-definition modality tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const seededModelIds: string[] = [];

const silentTelemetry: Telemetry = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
};

afterAll(async () => {
  if (seededModelIds.length > 0) {
    await db.delete(modelCatalog).where(inArray(modelCatalog.modelId, seededModelIds));
  }
  await db.$client.end();
});

/** The per-token rates and window a text row carries; the only priceable basis. */
const TOKEN_PRICING: StoredPricing = {
  kind: 'tokens',
  anchor: { base: { input: '2500', output: '10000' }, tiers: [] },
};
/** An exposed image row's whole pricing object, as the live catalog holds it. */
const PER_IMAGE_PRICING: StoredPricing = {
  kind: 'perImage',
  anchor: '46000000',
  dearest: '46000000',
};
/** An exposed video row's whole pricing object, as the live catalog holds it. */
const VIDEO_SKUS = { '720p': '57500000', '1080p': '92000000' };
const PER_SECOND_PRICING: StoredPricing = {
  kind: 'perSecond',
  anchor: VIDEO_SKUS,
  dearest: VIDEO_SKUS,
};

/** Everything of a descriptor except its output modality. */
interface DescriptorBody {
  readonly pricing: StoredPricing;
  readonly limits: Record<string, number>;
  readonly behaviors: readonly string[];
  readonly reasoning?: ModelReasoning;
}

async function seedModel(outputs: readonly Modality[], body: DescriptorBody): Promise<string> {
  const modelId = `trial-modality/${crypto.randomUUID().slice(0, 8)}`;
  seededModelIds.push(modelId);
  await db.insert(modelCatalog).values({
    modelId,
    descriptor: {
      id: modelId,
      provider: 'p',
      version: '3',
      inputs: ['text'],
      outputs: [...outputs],
      parameters: {},
      behaviors: [...body.behaviors],
      limits: body.limits,
      pricing: body.pricing,
      zdrReachable: true,
      releasedAt: OLD_RELEASE_SECONDS,
      fetchedAt: 0,
      ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
    },
  });
  return modelId;
}

/** The trial's own funding shape: the per-message ceiling stands in for a wallet. */
const TRIAL_BUDGET = {
  promptCharacterCount: 'hello world'.length,
  inputCharacterCount: 'hello world'.length,
  funding: { kind: 'free', spendableNanoUsd: TRIAL_MESSAGE_COST_CAP_NANO_USD },
} as const;

interface CompileOptions {
  readonly effort?: ReasoningEffortSelection;
  readonly webSearch?: boolean;
}

/** The compile's verdict, reduced to the accept/refuse answer the clauses speak of. */
async function compileAnswer(modelId: string, options: CompileOptions): Promise<string> {
  const result = await buildTurnDefinition({ db, telemetry: silentTelemetry }, modelId, {
    hooks: TRIAL_TURN_HOOKS,
    budget: TRIAL_BUDGET,
    ...(options.effort === undefined ? {} : { reasoningEffort: options.effort }),
    ...(options.webSearch === undefined ? {} : { webSearchEnabled: options.webSearch }),
  });
  return result.match(
    () => 'accepted',
    (error) => `refused: ${error.message}`
  );
}

/** The three output modalities an exposed row may declare (`isRunnableModelShape`). */
const OUTPUT_MODALITIES = [['text'], ['image'], ['video']] as const;

/** The one answer every output modality gives for a body, or the differing set. */
async function answersByModality(
  body: DescriptorBody,
  options: CompileOptions
): Promise<readonly string[]> {
  const answers: string[] = [];
  for (const outputs of OUTPUT_MODALITIES) {
    answers.push(await compileAnswer(await seedModel(outputs, body), options));
  }
  return answers;
}

/** Asserts one body/option cell answers identically whatever the model outputs. */
async function expectModalityBlind(
  body: DescriptorBody,
  options: CompileOptions,
  answer: string
): Promise<void> {
  expect(await answersByModality(body, options)).toEqual([answer, answer, answer]);
}

const PRICEABLE_REASONER: DescriptorBody = {
  pricing: TOKEN_PRICING,
  limits: { contextLength: 128_000 },
  behaviors: ['streaming', 'tools'],
  reasoning: { supportedEfforts: null },
};

const PRICEABLE_PLAIN: DescriptorBody = {
  pricing: TOKEN_PRICING,
  limits: { contextLength: 128_000 },
  behaviors: ['streaming'],
};

const UNPRICEABLE_REASONER: DescriptorBody = {
  pricing: PER_IMAGE_PRICING,
  limits: {},
  behaviors: ['streaming', 'tools'],
  reasoning: { supportedEfforts: null },
};

/** An exposed image row exactly as the catalog holds one. */
const LIVE_IMAGE_ROW: DescriptorBody = {
  pricing: PER_IMAGE_PRICING,
  limits: {},
  behaviors: [],
};

/** An exposed video row exactly as the catalog holds one. */
const LIVE_VIDEO_ROW: DescriptorBody = {
  pricing: PER_SECOND_PRICING,
  limits: {},
  behaviors: [],
};

/**
 * A funding an answer cap is READABLE at. {@link TRIAL_BUDGET} is not: driven
 * over {@link PRICEABLE_PLAIN}, its per-message ceiling seats all three output
 * modalities on `MINIMUM_OUTPUT_TOKENS`, so a cap read there is the floor
 * whether or not the fit collapsed to it. Only the spendable figure differs from
 * {@link TRIAL_BUDGET} — the prompt, the hooks and the body are held fixed, so a
 * difference between the arms is the modality.
 */
const ABOVE_FLOOR_BUDGET = {
  ...TRIAL_BUDGET,
  funding: { kind: 'free', spendableNanoUsd: 1_000_000_000n },
} as const;

/** The answer node's wire cap, or its absence — the fit writes it as a node param. */
async function answerCap(
  outputs: readonly Modality[],
  body: DescriptorBody
): Promise<number | undefined> {
  const modelId = await seedModel(outputs, body);
  const result = await buildTurnDefinition({ db, telemetry: silentTelemetry }, modelId, {
    hooks: TRIAL_TURN_HOOKS,
    budget: ABOVE_FLOOR_BUDGET,
  });
  const definition = result.match(
    (value) => value,
    (error) => {
      throw new Error(`the compile refused a cap fixture: ${error.message}`);
    }
  );
  const answer = definition.nodes.find((node) => node.type === 'modelCall');
  if (answer?.type !== 'modelCall') throw new Error('the compile produced no answer node');
  const cap = answer.params['maxOutputTokens'];
  if (cap === undefined) return undefined;
  if (typeof cap !== 'number') throw new Error('the answer cap is not a token count');
  return cap;
}

const NO_LEVEL = "does not support reasoning effort 'low'";
const NO_RATES = 'refused: a reasoning turn requires priceable models';
const NO_TOOLS = 'refused: web search requires a tool-capable model';

describe('the single-model compile answers a media model exactly as it answers a text one', () => {
  it('accepts every output modality on the options the trial route compiles with', async () => {
    await expectModalityBlind(PRICEABLE_PLAIN, {}, 'accepted');
  });

  it('accepts a live image row, whose whole pricing object is a per-image rate', async () => {
    await expectModalityBlind(LIVE_IMAGE_ROW, {}, 'accepted');
  });

  it('accepts a live video row, whose whole pricing object is a per-resolution matrix', async () => {
    await expectModalityBlind(LIVE_VIDEO_ROW, {}, 'accepted');
  });

  it('refuses an unoffered effort level for the descriptor, never for the modality', async () => {
    const answers = await answersByModality(PRICEABLE_PLAIN, { effort: 'low' });
    expect(answers.map((answer) => answer.includes(NO_LEVEL))).toEqual([true, true, true]);
  });

  it('accepts an offered effort level on every output modality alike', async () => {
    await expectModalityBlind(PRICEABLE_REASONER, { effort: 'low' }, 'accepted');
  });

  it('refuses a reasoning turn for an absent per-token rate, never for the modality', async () => {
    await expectModalityBlind(UNPRICEABLE_REASONER, { effort: 'low' }, NO_RATES);
  });

  it('refuses web search for an absent tool capability, never for the modality', async () => {
    await expectModalityBlind(LIVE_IMAGE_ROW, { webSearch: true }, NO_TOOLS);
  });

  it('accepts web search on every output modality a tool-capable row declares', async () => {
    await expectModalityBlind(UNPRICEABLE_REASONER, { webSearch: true }, 'accepted');
  });

  /*
   * An `off` selection on a row declaring no `reasoning` is wire silence rather
   * than a hard-off wire — `offEntries`
   * (`apps/api/src/slices/chat/domain/turn/reasoning.ts`) skips a descriptor
   * without one — so this case grades the accept answer alone. The hard-off WIRE
   * on a media row is graded in
   * `apps/api/src/slices/chat/domain/turn/definition.test.ts`, over a synthetic
   * `reasoning` object, because no media row in the seeded catalog carries one.
   */
  it('accepts an off selection on every output modality, for a row with no reasoning to disable', async () => {
    await expectModalityBlind(LIVE_VIDEO_ROW, { effort: 'off' }, 'accepted');
  });

  it('accepts an auto selection on every output modality', async () => {
    await expectModalityBlind(LIVE_IMAGE_ROW, { effort: 'auto' }, 'accepted');
  });
});

describe('the same compile fits a different answer cap to a media model than to a text one', () => {
  /*
   * The body is SYNTHETIC on its two media arms and the disclosure is the point:
   * measured over the live seeded catalog, every row declaring a non-text output
   * carries neither per-token rates nor a context length — and those are exactly
   * the two fields a derivable ceiling needs. A media row that has them is
   * therefore the only shape at which the fit's modality branch is observable at
   * all, which is what this case reads.
   */
  it('fits the answer cap to the output modality at a funding above the floor', async () => {
    expect([
      await answerCap(['text'], PRICEABLE_PLAIN),
      await answerCap(['image'], PRICEABLE_PLAIN),
      await answerCap(['video'], PRICEABLE_PLAIN),
    ]).toEqual([79_999, MINIMUM_OUTPUT_TOKENS, MINIMUM_OUTPUT_TOKENS]);
  });

  /*
   * The other media behaviour, kept apart from the synthetic-body case because
   * reading one as the other is the available mistake: an absent cap is no
   * ceiling DERIVED, a floor cap is a ceiling derived and then collapsed by the
   * fit.
   */
  it('omits the answer cap entirely for a live media row', async () => {
    expect([
      await answerCap(['image'], LIVE_IMAGE_ROW),
      await answerCap(['video'], LIVE_VIDEO_ROW),
    ]).toEqual([undefined, undefined]);
  });
});
