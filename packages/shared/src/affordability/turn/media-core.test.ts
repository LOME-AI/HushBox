import { describe, expect, it } from 'vitest';

import { perImagePricingFixture, perSecondPricingFixture } from '../../testing/pricing-fixture.ts';

import { evaluateMediaTurn } from './media-core.ts';
import { modelId } from '../model/model-id.ts';
import { EMPTY_PROMPT_BASIS } from './turn-types.ts';
import type { MediaModelEntry, MediaSelection } from './media-core.ts';
import type { NonEmpty, OptionAvailability } from './turn-types.ts';
import type { StoredMediaModality } from '../estimate/output-bytes.ts';
import type { MediaModel } from '../dimensions/media-model.ts';

const SECOND_720P = 100_000_000n;
const SECOND_1080P = 200_000_000n;
const PER_IMAGE = 40_000_000n;

/** One generated image's stored bytes at the media byte rate: 8,000,000 × 18. */
const IMAGE_STORAGE = 144_000_000n;
/** One generated second's stored bytes at the same rate: 5,000,000 × 18. */
const SECOND_STORAGE = 90_000_000n;

/** Four seconds at 720p, generation plus storage — {@link videoModel}'s cheapest turn. */
const VIDEO_FLOOR = 4n * (SECOND_720P + SECOND_STORAGE);
/** Eight seconds at 720p, the same turn at the model's other duration. */
const VIDEO_EIGHT_SECONDS = 8n * (SECOND_720P + SECOND_STORAGE);
/** One image, generation plus storage. */
const IMAGE_TURN = PER_IMAGE + IMAGE_STORAGE;

/** What one video model declares on each of the three media axes. */
interface VideoDomains {
  readonly aspectRatios: readonly string[];
  readonly resolutions: readonly string[];
  readonly durations: readonly number[];
}

/**
 * A video model with every axis domain stated, so a pair of them can be given
 * disjoint domains on one axis while agreeing on the other two.
 */
function videoModelOffering(id: string, domains: VideoDomains): MediaModel {
  return {
    modelId: modelId(id),
    pricing: perSecondPricingFixture({
      anchor: { '720p': SECOND_720P, '1080p': SECOND_1080P },
      dearest: { '720p': SECOND_720P, '1080p': SECOND_1080P },
    }),
    parameters: {
      aspectRatio: { type: 'enum', values: [...domains.aspectRatios], wire: 'providerOptions' },
      resolution: { type: 'enum', values: [...domains.resolutions], wire: 'providerOptions' },
      durationSeconds: { type: 'enum', values: [...domains.durations], wire: 'providerOptions' },
    },
  };
}

function videoModel(id: string, resolutions: readonly string[] = ['720p', '1080p']): MediaModel {
  return videoModelOffering(id, {
    aspectRatios: ['16:9', '9:16'],
    resolutions,
    durations: [4, 8],
  });
}

/**
 * A video model that constrains resolution and declares NO duration domain. The
 * catalog produces this shape: a gateway row with no `supported_durations` mints
 * no duration spec, and normalization excludes a video row for a missing release
 * date, missing token pricing, an unknown unit or a missing aspect ratio —
 * never for missing durations. Such an axis is UNCONSTRAINED, not forbidden: the
 * model runs whatever duration the request carries.
 */
function unconstrainedVideoModel(id: string): MediaModel {
  return {
    modelId: modelId(id),
    pricing: perSecondPricingFixture({
      anchor: { '720p': SECOND_720P, '1080p': SECOND_1080P },
      dearest: { '720p': SECOND_720P, '1080p': SECOND_1080P },
    }),
    parameters: {
      aspectRatio: { type: 'enum', values: ['16:9'], wire: 'providerOptions' },
      resolution: { type: 'enum', values: ['720p', '1080p'], wire: 'providerOptions' },
    },
  };
}

function imageModel(id: string): MediaModel {
  return {
    modelId: modelId(id),
    pricing: perImagePricingFixture({ anchor: PER_IMAGE, dearest: PER_IMAGE }),
    parameters: {
      aspectRatio: { type: 'enum', values: ['1:1', '16:9'], wire: 'providerOptions' },
    },
  };
}

/**
 * An image model that declares NO aspect-ratio domain. The axis is UNCONSTRAINED
 * on it, exactly as an absent duration set is on a video row: the model runs
 * whatever the request carries, and the server's per-model check skips an axis a
 * descriptor does not declare.
 */
function unconstrainedImageModel(id: string): MediaModel {
  return {
    modelId: modelId(id),
    pricing: perImagePricingFixture({ anchor: PER_IMAGE, dearest: PER_IMAGE }),
    parameters: {},
  };
}

function selectionOf(
  modality: StoredMediaModality,
  ids: readonly string[],
  pinned: MediaSelection['pinned'] = {}
): MediaSelection {
  return { modality, selectedIds: ids.map((id) => modelId(id)), pinned };
}

function optionsOf(
  set: ReturnType<typeof evaluateMediaTurn>,
  dimensionId: string
): NonEmpty<OptionAvailability> | undefined {
  return set.turnDimensions.find((dimension) => dimension.dimensionId === dimensionId)?.options;
}

/** Far more than any fixture turn costs, so nothing here is greyed by money. */
const AMPLE_FUNDING = 10n ** 13n;

/** The three pins the composer always carries on a video turn. */
const VIDEO_PINS = { aspectRatio: '16:9', resolution: '720p', durationSeconds: '4' } as const;

/** One model offering exactly the pinned value on all three axes. */
const PINS_EXACTLY: VideoDomains = {
  aspectRatios: ['16:9'],
  resolutions: ['720p'],
  durations: [4],
};

/** Every catalog model selected, at funding no fixture turn can exhaust. */
function turnOf(
  modality: StoredMediaModality,
  catalog: readonly MediaModel[],
  pinned: MediaSelection['pinned']
): ReturnType<typeof evaluateMediaTurn> {
  return evaluateMediaTurn({
    fundingNanoUsd: AMPLE_FUNDING,
    basis: EMPTY_PROMPT_BASIS,
    catalog,
    selection: selectionOf(
      modality,
      catalog.map((model) => model.modelId),
      pinned
    ),
  });
}

function videoTurnOf(
  catalog: readonly MediaModel[],
  pinned: MediaSelection['pinned'] = VIDEO_PINS
): ReturnType<typeof evaluateMediaTurn> {
  return turnOf('video', catalog, pinned);
}

/**
 * Whether the turn's own pins are choosable on every axis that presents options
 * — the question the greyed-versus-sendable agreement is about. An axis no
 * selected model declares presents nothing and constrains nothing.
 */
function pinnedOptionsSelectable(
  set: ReturnType<typeof evaluateMediaTurn>,
  pinned: MediaSelection['pinned']
): boolean {
  return Object.entries(pinned).every(([dimensionId, optionId]) => {
    const options = optionsOf(set, dimensionId);
    if (options === undefined) return true;
    return options.some((option) => option.optionId === optionId && option.availability.available);
  });
}

function rowFor(
  set: ReturnType<typeof evaluateMediaTurn>,
  id: string
): MediaModelEntry | undefined {
  return set.all.find((entry) => entry.modelId === id);
}

describe('evaluateMediaTurn', () => {
  it('leaves an option the payer can afford ungreyed', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_FLOOR,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo']),
    });

    expect(optionsOf(set, 'resolution')).toContainEqual({
      optionId: '720p',
      label: '720p',
      availability: { available: true },
    });
  });

  it('greys an option whose cheapest configuration costs more than the payer has', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_FLOOR,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo']),
    });

    expect(optionsOf(set, 'resolution')).toContainEqual({
      optionId: '1080p',
      label: '1080p',
      availability: { available: false, reason: 'insufficient_funds' },
    });
  });

  it('greys an option the payer is one nano short of', () => {
    const oneNanoShort = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_FLOOR - 1n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo']),
    });

    expect(optionsOf(oneNanoShort, 'resolution')).toContainEqual({
      optionId: '720p',
      label: '720p',
      availability: { available: false, reason: 'insufficient_funds' },
    });
  });

  it('prices a generation at its provider cost plus the bytes its output is stored at', () => {
    // 40,000,000 to generate the image; 144,000,000 to keep it. A verdict on the
    // provider leg alone would send this turn at a quarter of what it costs.
    const funded = evaluateMediaTurn({
      fundingNanoUsd: IMAGE_TURN,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [imageModel('vendor/imagen')],
      selection: selectionOf('image', ['vendor/imagen']),
    });
    const oneNanoShort = evaluateMediaTurn({
      fundingNanoUsd: IMAGE_TURN - 1n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [imageModel('vendor/imagen')],
      selection: selectionOf('image', ['vendor/imagen']),
    });

    expect(IMAGE_TURN).toBe(184_000_000n);
    expect([funded.sendable, oneNanoShort.sendable]).toEqual([true, false]);
  });

  it('stores more bytes for a longer generation', () => {
    // Eight seconds costs twice four seconds on BOTH legs, so the flip point
    // moves by the storage of the extra four seconds as well as their rate.
    const funded = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_EIGHT_SECONDS,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo'], { resolution: '720p', durationSeconds: '8' }),
    });
    const oneNanoShort = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_EIGHT_SECONDS - 1n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo'], { resolution: '720p', durationSeconds: '8' }),
    });

    expect(VIDEO_EIGHT_SECONDS - VIDEO_FLOOR).toBe(4n * (SECOND_720P + SECOND_STORAGE));
    expect([funded.sendable, oneNanoShort.sendable]).toEqual([true, false]);
  });

  it("charges the prompt's own storage once, on top of what the models cost", () => {
    const promptStorage = 300_000n; // 1,000 characters at 300 nano each.
    const funded = evaluateMediaTurn({
      fundingNanoUsd: IMAGE_TURN + promptStorage,
      basis: { ...EMPTY_PROMPT_BASIS, inputChars: 1000 },
      catalog: [imageModel('vendor/imagen')],
      selection: selectionOf('image', ['vendor/imagen']),
    });
    const oneNanoShort = evaluateMediaTurn({
      fundingNanoUsd: IMAGE_TURN + promptStorage - 1n,
      basis: { ...EMPTY_PROMPT_BASIS, inputChars: 1000 },
      catalog: [imageModel('vendor/imagen')],
      selection: selectionOf('image', ['vendor/imagen']),
    });

    expect([funded.sendable, oneNanoShort.sendable]).toEqual([true, false]);
  });

  it('charges the prompt storage once for the turn, not once per generating model', () => {
    const promptStorage = 300_000n;
    const twoModels = evaluateMediaTurn({
      fundingNanoUsd: 2n * IMAGE_TURN + promptStorage,
      basis: { ...EMPTY_PROMPT_BASIS, inputChars: 1000 },
      catalog: [imageModel('vendor/imagen'), imageModel('vendor/flux')],
      selection: selectionOf('image', ['vendor/imagen', 'vendor/flux']),
    });

    expect(twoModels.sendable).toBe(true);
  });

  it('prices an unconstrained axis at the duration the request will carry', () => {
    // The model declares no duration set, so it runs whatever is asked for.
    // Pricing it at one reference unit would price four seconds as one on both
    // legs — a quarter of what the request costs, in the permissive direction.
    const funded = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_FLOOR,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [unconstrainedVideoModel('vendor/anyduration')],
      selection: selectionOf('video', ['vendor/anyduration'], {
        resolution: '720p',
        durationSeconds: '4',
      }),
    });
    const oneNanoShort = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_FLOOR - 1n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [unconstrainedVideoModel('vendor/anyduration')],
      selection: selectionOf('video', ['vendor/anyduration'], {
        resolution: '720p',
        durationSeconds: '4',
      }),
    });

    expect([funded.sendable, oneNanoShort.sendable]).toEqual([true, false]);
  });

  it('refuses a model whose unconstrained axis the turn names no duration for', () => {
    // Nothing says how many seconds this call runs, so there is no price. It is
    // refused rather than priced at one second, which is the only reading that
    // cannot be an under-price.
    const set = evaluateMediaTurn({
      fundingNanoUsd: 10n ** 13n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [unconstrainedVideoModel('vendor/anyduration')],
      selection: selectionOf('video', ['vendor/anyduration'], { resolution: '720p' }),
    });

    expect(set).toMatchObject({ sendable: false, refusal: 'model_not_priceable' });
    expect(rowFor(set, 'vendor/anyduration')?.availability).toEqual({
      available: false,
      reason: 'model_not_priceable',
    });
  });

  it('prices an unconstrained sibling at an option only the other model declares', () => {
    // `vendor/veo` offers 8 seconds and the unconstrained sibling declares no
    // durations at all — it can still run 8, so the option is a money question
    // rather than an unoffered one, and both siblings are charged for it.
    const eightSecondsBoth = 2n * VIDEO_EIGHT_SECONDS;
    const set = evaluateMediaTurn({
      fundingNanoUsd: eightSecondsBoth - 1n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo'), unconstrainedVideoModel('vendor/anyduration')],
      selection: selectionOf('video', ['vendor/veo', 'vendor/anyduration'], {
        resolution: '720p',
        durationSeconds: '4',
      }),
    });

    expect(optionsOf(set, 'durationSeconds')).toContainEqual({
      optionId: '8',
      label: '8s',
      availability: { available: false, reason: 'insufficient_funds' },
    });
  });

  it('leaves that same option available once the payer can fund both siblings at it', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: 2n * VIDEO_EIGHT_SECONDS,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo'), unconstrainedVideoModel('vendor/anyduration')],
      selection: selectionOf('video', ['vendor/veo', 'vendor/anyduration'], {
        resolution: '720p',
        durationSeconds: '4',
      }),
    });

    expect(optionsOf(set, 'durationSeconds')).toContainEqual({
      optionId: '8',
      label: '8s',
      availability: { available: true },
    });
  });

  it('skips affordability entirely for a zero-cost dimension', () => {
    // Aspect ratio changes the shape of the output and nothing about its price,
    // so no balance greys it — not even one that greys the model itself.
    const set = evaluateMediaTurn({
      fundingNanoUsd: 0n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [imageModel('vendor/imagen')],
      selection: selectionOf('image', ['vendor/imagen']),
    });

    expect(optionsOf(set, 'aspectRatio')).toEqual([
      { optionId: '1:1', label: '1:1', availability: { available: true } },
      { optionId: '16:9', label: '16:9', availability: { available: true } },
    ]);
  });

  it('greys an option a selected sibling does not offer', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: 10n ** 13n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo'), videoModel('vendor/sora', ['720p'])],
      selection: selectionOf('video', ['vendor/veo', 'vendor/sora']),
    });

    expect(optionsOf(set, 'resolution')).toContainEqual({
      optionId: '1080p',
      label: '1080p',
      availability: { available: false, reason: 'option_not_offered' },
    });
  });

  it('prices an open dimension at the option pinned on another dimension', () => {
    // Eight seconds at the pinned 1080p is 2,320,000,000n; at the cheapest
    // resolution it would be 1,520,000,000n, which this funding covers exactly.
    const set = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_EIGHT_SECONDS,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo'], { resolution: '1080p' }),
    });

    expect(optionsOf(set, 'durationSeconds')).toContainEqual({
      optionId: '8',
      label: '8s',
      availability: { available: false, reason: 'insufficient_funds' },
    });
  });

  it('greys a model row the payer cannot afford beside what is already selected', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_FLOOR,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo'), videoModel('vendor/sora')],
      selection: selectionOf('video', ['vendor/veo']),
    });

    expect(rowFor(set, 'vendor/sora')?.availability).toEqual({
      available: false,
      reason: 'insufficient_funds',
    });
  });

  it('leaves a model row the payer can afford beside what is already selected ungreyed', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: 2n * VIDEO_FLOOR,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo'), videoModel('vendor/sora')],
      selection: selectionOf('video', ['vendor/veo']),
    });

    expect(rowFor(set, 'vendor/sora')?.availability).toEqual({ available: true });
  });

  it('refuses a turn whose selection nothing prices', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: 10n ** 13n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', []),
    });

    expect(set).toMatchObject({ sendable: false, refusal: 'model_not_priceable' });
  });

  it('renders a row for a selected model the catalog cannot price, carrying its reason', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: 10n ** 13n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo', 'vendor/unpriced']),
    });

    expect(rowFor(set, 'vendor/unpriced')?.availability).toEqual({
      available: false,
      reason: 'model_not_priceable',
    });
  });

  it('refuses a turn naming a selected id its own catalog does not price', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: AMPLE_FUNDING,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo', 'vendor/gone']),
    });

    expect(set).toMatchObject({ sendable: false, refusal: 'model_not_priceable' });
  });

  it('refuses a turn the payer cannot fund at its cheapest configuration', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_FLOOR - 1n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo']),
    });

    expect(set).toMatchObject({ sendable: false, refusal: 'insufficient_funds' });
  });

  it('sends a turn the payer can fund at its cheapest configuration', () => {
    const set = evaluateMediaTurn({
      fundingNanoUsd: VIDEO_FLOOR,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo')],
      selection: selectionOf('video', ['vendor/veo']),
    });

    expect(set.sendable).toBe(true);
  });

  it('refuses a turn whose pinned resolution a selected sibling does not offer', () => {
    // The request carries the pinned resolution to BOTH models, so a sibling
    // that does not declare it refuses the turn at the server. Pricing it at
    // that sibling's own cheapest presents a turn that cannot be sent.
    const set = videoTurnOf([
      videoModelOffering('vendor/veo', PINS_EXACTLY),
      videoModelOffering('vendor/sora', { ...PINS_EXACTLY, resolutions: ['1080p'] }),
    ]);

    expect(set).toMatchObject({ sendable: false, refusal: 'option_not_offered' });
  });

  it('refuses a turn whose pinned aspect ratio a selected sibling does not offer', () => {
    const set = videoTurnOf([
      videoModelOffering('vendor/veo', PINS_EXACTLY),
      videoModelOffering('vendor/sora', { ...PINS_EXACTLY, aspectRatios: ['9:16'] }),
    ]);

    expect(set).toMatchObject({ sendable: false, refusal: 'option_not_offered' });
  });

  it('refuses a turn whose pinned duration a selected sibling does not offer', () => {
    const set = videoTurnOf([
      videoModelOffering('vendor/veo', PINS_EXACTLY),
      videoModelOffering('vendor/sora', { ...PINS_EXACTLY, durations: [8] }),
    ]);

    expect(set).toMatchObject({ sendable: false, refusal: 'option_not_offered' });
  });

  it('greys the row of a selected model that does not offer a pinned option', () => {
    const set = videoTurnOf([
      videoModelOffering('vendor/veo', PINS_EXACTLY),
      videoModelOffering('vendor/sora', { ...PINS_EXACTLY, resolutions: ['1080p'] }),
    ]);

    expect(rowFor(set, 'vendor/sora')?.availability).toEqual({
      available: false,
      reason: 'option_not_offered',
    });
  });

  it('sends a turn every selected sibling offers the pinned options for', () => {
    // Two models at four seconds of 720p, one of which offers more than the pin.
    // The pair fixes the amount: a verdict that refused the pin outright would
    // fail the funded reading, and one that priced nothing would pass both.
    const catalog = [
      videoModel('vendor/veo'),
      videoModelOffering('vendor/sora', { ...PINS_EXACTLY, aspectRatios: ['16:9', '9:16'] }),
    ];
    const selection = selectionOf('video', ['vendor/veo', 'vendor/sora'], VIDEO_PINS);
    const funded = evaluateMediaTurn({
      fundingNanoUsd: 2n * VIDEO_FLOOR,
      basis: EMPTY_PROMPT_BASIS,
      catalog,
      selection,
    });
    const oneNanoShort = evaluateMediaTurn({
      fundingNanoUsd: 2n * VIDEO_FLOOR - 1n,
      basis: EMPTY_PROMPT_BASIS,
      catalog,
      selection,
    });

    expect([funded.sendable, oneNanoShort]).toMatchObject([
      true,
      { sendable: false, refusal: 'insufficient_funds' },
    ]);
  });

  it('never leaves a turn sendable while an option it pins is greyed', () => {
    // The property the picker rests on: a greyed option and an accepted send
    // cannot disagree. Stated over both directions, so neither a blanket refusal
    // nor a blanket send satisfies it.
    const cases = [
      {
        name: 'every sibling offers the pins',
        modality: 'video',
        pinned: VIDEO_PINS,
        catalog: [
          videoModelOffering('vendor/veo', PINS_EXACTLY),
          videoModelOffering('vendor/sora', PINS_EXACTLY),
        ],
        sendable: true,
      },
      {
        name: 'disjoint resolutions',
        modality: 'video',
        pinned: VIDEO_PINS,
        catalog: [
          videoModelOffering('vendor/veo', PINS_EXACTLY),
          videoModelOffering('vendor/sora', { ...PINS_EXACTLY, resolutions: ['1080p'] }),
        ],
        sendable: false,
      },
      {
        name: 'disjoint aspect ratios',
        modality: 'video',
        pinned: VIDEO_PINS,
        catalog: [
          videoModelOffering('vendor/veo', PINS_EXACTLY),
          videoModelOffering('vendor/sora', { ...PINS_EXACTLY, aspectRatios: ['9:16'] }),
        ],
        sendable: false,
      },
      {
        name: 'disjoint durations',
        modality: 'video',
        pinned: VIDEO_PINS,
        catalog: [
          videoModelOffering('vendor/veo', PINS_EXACTLY),
          videoModelOffering('vendor/sora', { ...PINS_EXACTLY, durations: [8] }),
        ],
        sendable: false,
      },
      {
        name: 'a pin no sibling offers',
        modality: 'video',
        pinned: VIDEO_PINS,
        catalog: [
          videoModelOffering('vendor/veo', { ...PINS_EXACTLY, resolutions: ['1080p'] }),
          videoModelOffering('vendor/sora', { ...PINS_EXACTLY, resolutions: ['1080p'] }),
        ],
        sendable: false,
      },
      {
        name: 'an axis neither sibling constrains',
        modality: 'video',
        pinned: VIDEO_PINS,
        catalog: [
          unconstrainedVideoModel('vendor/anyduration'),
          unconstrainedVideoModel('vendor/anysecond'),
        ],
        sendable: true,
      },
      {
        name: 'one sibling declares the axis and the other leaves it unconstrained',
        modality: 'image',
        pinned: { aspectRatio: '1:1' },
        catalog: [imageModel('vendor/imagen'), unconstrainedImageModel('vendor/flux')],
        sendable: true,
      },
    ] as const;

    const verdicts = cases.map(({ name, modality, catalog, pinned }) => {
      const set = turnOf(modality, catalog, pinned);
      return {
        name,
        sendable: set.sendable,
        pinsSelectable: pinnedOptionsSelectable(set, pinned),
      };
    });

    expect(verdicts).toEqual(
      cases.map(({ name, sendable }) => ({ name, sendable, pinsSelectable: sendable }))
    );
  });

  it('leaves a pinned option ungreyed when a sibling declares no domain for its axis', () => {
    // The sibling is UNCONSTRAINED on aspect ratio, not unable: the request's
    // value rides to it and the server accepts it, so greying the option here
    // would lock the whole axis on a turn that sends and name a refusal the
    // server does not make.
    const set = turnOf(
      'image',
      [imageModel('vendor/imagen'), unconstrainedImageModel('vendor/flux')],
      { aspectRatio: '1:1' }
    );

    expect(optionsOf(set, 'aspectRatio')).toEqual([
      { optionId: '1:1', label: '1:1', availability: { available: true } },
      { optionId: '16:9', label: '16:9', availability: { available: true } },
    ]);
  });

  it('answers one refusal whichever order the selection lists its models in', () => {
    // One model cannot be priced at all and the other does not offer the pin.
    // `REFUSAL_CODES` ranks the unoffered option above the unpriceable model, so
    // the order the payer happened to select them in cannot decide the answer.
    const unpriceable = unconstrainedVideoModel('vendor/anyduration');
    const unoffered = videoModelOffering('vendor/sora', {
      ...PINS_EXACTLY,
      resolutions: ['1080p'],
      durations: [4, 8],
    });
    const pins = { aspectRatio: '16:9', resolution: '720p' };

    const forwards = turnOf('video', [unpriceable, unoffered], pins);
    const backwards = turnOf('video', [unoffered, unpriceable], pins);

    expect([forwards, backwards]).toMatchObject([
      { sendable: false, refusal: 'option_not_offered' },
      { sendable: false, refusal: 'option_not_offered' },
    ]);
  });

  it('grades each row on its own defect rather than a sibling’s', () => {
    const unpriceable = unconstrainedVideoModel('vendor/anyduration');
    const unoffered = videoModelOffering('vendor/sora', {
      ...PINS_EXACTLY,
      resolutions: ['1080p'],
      durations: [4, 8],
    });
    const set = turnOf('video', [unpriceable, unoffered], {
      aspectRatio: '16:9',
      resolution: '720p',
    });

    expect([
      rowFor(set, 'vendor/anyduration')?.availability,
      rowFor(set, 'vendor/sora')?.availability,
    ]).toEqual([
      { available: false, reason: 'model_not_priceable' },
      { available: false, reason: 'option_not_offered' },
    ]);
  });

  it('sums the selected siblings rather than pricing the cheapest alone', () => {
    // Both selected models generate, so a turn costs their sum; grading either
    // one alone would present a turn the payer cannot fund as sendable.
    const set = evaluateMediaTurn({
      fundingNanoUsd: 2n * VIDEO_FLOOR - 1n,
      basis: EMPTY_PROMPT_BASIS,
      catalog: [videoModel('vendor/veo'), videoModel('vendor/sora')],
      selection: selectionOf('video', ['vendor/veo', 'vendor/sora']),
    });

    expect(set.sendable).toBe(false);
  });
});
