/**
 * The media adapter hook: the single place `apps/web` calls the money layer's
 * per-unit producer. These tests assert what the ADAPTER feeds that producer and
 * how it behaves while its inputs load. The verdicts themselves belong to the
 * producer and are pinned in `packages/shared`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { EMPTY_PROMPT_BASIS, modelSchema } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { useMediaTurnOptions } from '@/hooks/billing/use-media-turn-options';
import type { MediaModelEntry, MediaOptionSet, Model } from '@hushbox/shared';
import type { UseMediaTurnOptionsResult } from '@/hooks/billing/use-media-turn-options';

const mockFundingCalls: (string | null)[] = [];

const { mockFundingRead, mockModelsData, mockSelection, mockModality } = vi.hoisted(() => ({
  mockFundingRead: { current: undefined as unknown },
  mockModelsData: { current: undefined as unknown },
  mockSelection: { current: [] as { id: string; name: string }[] },
  mockModality: { current: 'image' as string },
}));

vi.mock('@/hooks/billing/use-spendable', () => ({
  useFundingRead: (_isAuthenticated: boolean, conversationId: string | null) => {
    mockFundingCalls.push(conversationId);
    return mockFundingRead.current;
  },
}));
vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({ data: mockModelsData.current }),
}));
vi.mock('@/stores/model', () => ({
  useModelStore: (selector: (s: unknown) => unknown) =>
    selector({
      activeModality: mockModality.current,
      selections: { [mockModality.current]: mockSelection.current },
      imageConfig: { aspectRatio: '1:1' },
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    }),
}));

const PER_IMAGE_NANO = '40000000';
/** One image turn: 40,000,000 to generate plus 8,000,000 bytes × 18 to keep. */
const IMAGE_TURN_NANO = '184000000';

function imageRow(overrides: Partial<Model> & { id: string }): Model {
  return {
    name: overrides.id,
    provider: 'Test',
    modality: 'image',
    contextLength: 0,
    pricing: { perImage: PER_IMAGE_NANO, dearestPerImage: PER_IMAGE_NANO },
    description: 'A test image model',
    supportedParameters: [],
    created: OLD_RELEASE_SECONDS,
    supportedAspectRatios: ['1:1', '16:9'],
    ...overrides,
  };
}

const SECOND_720P_NANO = '100000000';
const SECOND_1080P_NANO = '200000000';

function videoRow(overrides: Partial<Model> & { id: string }): Model {
  return {
    name: overrides.id,
    provider: 'Test',
    modality: 'video',
    contextLength: 0,
    pricing: {
      perSecondByResolution: { '720p': SECOND_720P_NANO, '1080p': SECOND_1080P_NANO },
      dearestPerSecondByResolution: { '720p': SECOND_720P_NANO, '1080p': SECOND_1080P_NANO },
    },
    description: 'A test video model',
    supportedParameters: [],
    created: OLD_RELEASE_SECONDS,
    supportedAspectRatios: ['16:9'],
    supportedVideoResolutions: ['720p', '1080p'],
    supportedVideoDurationsSeconds: [4, 8],
    ...overrides,
  };
}

function videoOptionsFor(spendableNanoUsd: string): UseMediaTurnOptionsResult {
  mockModality.current = 'video';
  mockFundingRead.current = served(spendableNanoUsd);
  mockModelsData.current = { models: [videoRow({ id: 'vendor/veo' })] };
  mockSelection.current = [{ id: 'vendor/veo', name: 'Veo' }];
  return renderHook(() => useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS }))
    .result.current;
}

function videoOptionIds(
  result: ReturnType<typeof videoOptionsFor>,
  dimensionId: string
): readonly string[] {
  const dimension = result.options?.affordable.turnDimensions.find(
    (candidate) => candidate.dimensionId === dimensionId
  );
  return (dimension?.options ?? [])
    .filter((option) => option.availability.available)
    .map((option) => option.optionId);
}

function served(spendableNanoUsd: string): unknown {
  return {
    status: 'served',
    snapshot: { spendableNanoUsd, heldNanoUsd: '0', payerTier: 'paid', payer: 'self' },
  };
}

function optionsFor(spendableNanoUsd: string): UseMediaTurnOptionsResult {
  mockFundingRead.current = served(spendableNanoUsd);
  mockModelsData.current = { models: [imageRow({ id: 'vendor/imagen' })] };
  mockSelection.current = [{ id: 'vendor/imagen', name: 'Imagen' }];
  return renderHook(() => useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS }))
    .result.current;
}

const CHEAP_PER_IMAGE_NANO = '46000000';
const DEAR_PER_IMAGE_NANO = '500000000';

/**
 * The send gate for a 1,000-character prompt, where `listed` names the catalog
 * rows the client currently holds and `selected` the ids the store has
 * persisted. The two diverge exactly when a stored selection outlives the row it
 * named, which the store cannot prune because it holds no catalog.
 */
function mediaGate(
  spendableNanoUsd: string,
  listed: readonly string[],
  selected: readonly string[]
): MediaOptionSet | undefined {
  mockFundingRead.current = served(spendableNanoUsd);
  mockModelsData.current = {
    models: [
      imageRow({
        id: 'vendor/cheap',
        pricing: { perImage: CHEAP_PER_IMAGE_NANO, dearestPerImage: CHEAP_PER_IMAGE_NANO },
      }),
      imageRow({
        id: 'vendor/dear',
        pricing: { perImage: DEAR_PER_IMAGE_NANO, dearestPerImage: DEAR_PER_IMAGE_NANO },
      }),
    ].filter((row) => listed.includes(row.id)),
  };
  mockSelection.current = selected.map((id) => ({ id, name: id }));
  return renderHook(() =>
    useMediaTurnOptions({
      isAuthenticated: true,
      basis: { ...EMPTY_PROMPT_BASIS, inputChars: 1000 },
    })
  ).result.current.options?.admissible;
}

beforeEach(() => {
  mockFundingCalls.length = 0;
  mockModality.current = 'image';
  mockSelection.current = [];
  mockModelsData.current = { models: [] };
  mockFundingRead.current = served('1000000000');
});

describe('useMediaTurnOptions', () => {
  it('withholds the verdict while the payer funding read is still outstanding', () => {
    mockFundingRead.current = { status: 'awaiting', snapshot: undefined };

    const { result } = renderHook(() =>
      useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
    );

    expect(result.current).toMatchObject({ isPending: true, options: undefined });
  });

  it('reports an exhausted funding read rather than waiting on it', () => {
    mockFundingRead.current = { status: 'unavailable', snapshot: undefined };

    const { result } = renderHook(() =>
      useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
    );

    expect(result.current).toMatchObject({
      isPending: false,
      isFundingUnavailable: true,
      options: undefined,
    });
  });

  it('greys a model row the payer cannot afford', () => {
    expect(optionsFor('183999999').options?.affordable.all).toEqual([
      {
        modelId: 'vendor/imagen',
        availability: { available: false, reason: 'insufficient_funds' },
      },
    ]);
  });

  it('leaves a model row the payer can afford ungreyed', () => {
    expect(optionsFor(IMAGE_TURN_NANO).options?.affordable.all).toEqual([
      { modelId: 'vendor/imagen', availability: { available: true } },
    ]);
  });

  it('reads each option domain off the catalog row rather than a global list', () => {
    mockModelsData.current = {
      models: [imageRow({ id: 'vendor/imagen', supportedAspectRatios: ['21:9'] })],
    };
    mockSelection.current = [{ id: 'vendor/imagen', name: 'Imagen' }];

    const { result } = renderHook(() =>
      useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
    );

    expect(result.current.options?.affordable.turnDimensions).toEqual([
      {
        dimensionId: 'aspectRatio',
        options: [{ optionId: '21:9', label: '21:9', availability: { available: true } }],
      },
    ]);
  });

  it('renders a selected row the wire cannot price rather than dropping it', () => {
    const ratelessImage = imageRow({ id: 'vendor/unpriced', pricing: {} });
    // Parsing both rows pins the premise this guard rests on: the wire contract
    // refuses an image row carrying no per-image rate, so no endpoint can emit
    // one and the hook is being handed input only a bug could produce. The row
    // that differs only by keeping its rate is the control that keeps the check
    // from passing vacuously; should the contract ever admit the rateless one,
    // this fails instead of the guard quietly going idle.
    expect(
      [imageRow({ id: 'vendor/unpriced' }), ratelessImage].map(
        (m) => modelSchema.safeParse(m).success
      )
    ).toEqual([true, false]);

    mockModelsData.current = { models: [ratelessImage] };
    mockSelection.current = [{ id: 'vendor/unpriced', name: 'Unpriced' }];

    const { result } = renderHook(() =>
      useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
    );

    expect(result.current.options?.affordable.all).toEqual([
      {
        modelId: 'vendor/unpriced',
        availability: { available: false, reason: 'model_not_priceable' },
      },
    ]);
  });

  it('projects a per-second video row so its priced axis carries a verdict', () => {
    // 4s at 720p is the floor: 400,000,000n to generate and 360,000,000n to
    // keep. 1080p generates at twice the rate and stores the same bytes.
    expect(videoOptionIds(videoOptionsFor('760000000'), 'resolution')).toEqual(['720p']);
  });

  it('leaves every offered resolution ungreyed for a payer who can afford them', () => {
    expect(videoOptionIds(videoOptionsFor('1160000000'), 'resolution')).toEqual(['720p', '1080p']);
  });

  it('prices the open duration axis at the resolution the store has pinned', () => {
    // The store pins 720p, so 8 seconds costs 1,520,000,000n and this payer can
    // reach it; priced at 1080p it would cost 2,320,000,000n and be greyed.
    expect(videoOptionIds(videoOptionsFor('1520000000'), 'durationSeconds')).toEqual(['4', '8']);
  });

  it('prices a video row declaring no durations at the duration the store has pinned', () => {
    // A catalog row with no supported-duration set mints no duration spec, so the
    // axis is unconstrained — the row runs whatever the request carries, and the
    // store pins 4 seconds. Priced at one second the row would show ungreyed at a
    // quarter of what the request costs.
    const rowAt = (spendableNanoUsd: string): readonly MediaModelEntry[] | undefined => {
      mockModality.current = 'video';
      mockFundingRead.current = served(spendableNanoUsd);
      mockModelsData.current = {
        models: [videoRow({ id: 'vendor/anyduration', supportedVideoDurationsSeconds: undefined })],
      };
      mockSelection.current = [{ id: 'vendor/anyduration', name: 'Any duration' }];
      return renderHook(() =>
        useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
      ).result.current.options?.affordable.all;
    };

    expect([rowAt('760000000'), rowAt('759999999')]).toEqual([
      [{ modelId: 'vendor/anyduration', availability: { available: true } }],
      [
        {
          modelId: 'vendor/anyduration',
          availability: { available: false, reason: 'insufficient_funds' },
        },
      ],
    ]);
  });

  it('refuses a modality nothing per-unit prices rather than inventing options for it', () => {
    mockModality.current = 'audio';
    mockModelsData.current = {
      models: [imageRow({ id: 'vendor/speech', modality: 'audio', pricing: {} })],
    };
    mockSelection.current = [{ id: 'vendor/speech', name: 'Speech' }];

    const { result } = renderHook(() =>
      useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
    );

    expect(result.current.options?.affordable).toEqual({
      sendable: false,
      refusal: 'model_not_priceable',
      all: [
        {
          modelId: 'vendor/speech',
          availability: { available: false, reason: 'model_not_priceable' },
        },
      ],
      turnDimensions: [],
    });
  });

  it('refuses a video row carrying no per-second rate rather than pricing it as free', () => {
    const ratelessVideo = videoRow({
      id: 'vendor/unpriced-video',
      pricing: {},
      supportedAspectRatios: undefined,
    });
    const pricedVideo = videoRow({
      id: 'vendor/unpriced-video',
      supportedAspectRatios: undefined,
    });
    expect([pricedVideo, ratelessVideo].map((m) => modelSchema.safeParse(m).success)).toEqual([
      true,
      false,
    ]);

    mockModality.current = 'video';
    mockModelsData.current = { models: [ratelessVideo] };
    mockSelection.current = [{ id: 'vendor/unpriced-video', name: 'Unpriced' }];

    const { result } = renderHook(() =>
      useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
    );

    expect(result.current.options?.affordable.all).toEqual([
      {
        modelId: 'vendor/unpriced-video',
        availability: { available: false, reason: 'model_not_priceable' },
      },
    ]);
  });

  it('produces no verdict for a text turn, which has no per-unit price', () => {
    mockModality.current = 'text';

    const { result } = renderHook(() =>
      useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
    );

    expect(result.current).toEqual({
      isPending: false,
      isFundingUnavailable: false,
      options: undefined,
    });
  });

  it("prices the send gate with the prompt's own storage, and the greying without it", () => {
    mockFundingRead.current = served(IMAGE_TURN_NANO);
    mockModelsData.current = { models: [imageRow({ id: 'vendor/imagen' })] };
    mockSelection.current = [{ id: 'vendor/imagen', name: 'Imagen' }];

    const { result } = renderHook(() =>
      useMediaTurnOptions({
        isAuthenticated: true,
        basis: { ...EMPTY_PROMPT_BASIS, inputChars: 1000 },
      })
    );

    expect([
      result.current.options?.affordable.sendable,
      result.current.options?.admissible.sendable,
    ]).toEqual([true, false]);
  });

  it('produces a verdict for a row declaring a resolution its price matrix does not carry', () => {
    // The wire carries the declared resolution domain and the price matrix as
    // separate members, so the two may disagree. The producer runs inside a
    // `useMemo` with no error boundary above it, so an unpriceable option has to
    // come back as a verdict this hook can hand on.
    mockModality.current = 'video';
    mockFundingRead.current = served('1000000000000');
    mockModelsData.current = {
      models: [videoRow({ id: 'vendor/veo', supportedVideoResolutions: ['720p', '4k'] })],
    };
    mockSelection.current = [{ id: 'vendor/veo', name: 'Veo' }];

    const { result } = renderHook(() =>
      useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
    );

    expect(videoOptionIds(result.current, 'resolution')).toEqual(['720p']);
  });

  it('prices the pair 644,000,000 nano above the half a shrunken catalog still lists', () => {
    // 46,000,000 and 500,000,000 to generate, 8,000,000 bytes × 18 each to keep,
    // and 300,000 for the prompt's own storage: 190,300,000 for the cheap row
    // alone, 834,300,000 for both. That gap is what a send priced from the
    // surviving half alone would leave unpriced.
    const both = ['vendor/cheap', 'vendor/dear'];

    expect([
      mediaGate('190299999', ['vendor/cheap'], ['vendor/cheap'])?.sendable,
      mediaGate('190300000', ['vendor/cheap'], ['vendor/cheap'])?.sendable,
      mediaGate('834299999', both, both)?.sendable,
      mediaGate('834300000', both, both)?.sendable,
    ]).toEqual([false, true, false, true]);
  });

  it('refuses a send whose stored selection names a model the catalog no longer lists', () => {
    // The request body carries every stored id, so an id the catalog dropped is
    // still generated and still charged. Pricing only the ids the catalog still
    // lists would clear this send at the cheap row's own 190,300,000.
    const admissible = mediaGate('190300000', ['vendor/cheap'], ['vendor/cheap', 'vendor/dear']);

    expect(admissible).toMatchObject({
      sendable: false,
      refusal: 'model_not_priceable',
      all: [
        { modelId: 'vendor/cheap', availability: { available: true } },
        {
          modelId: 'vendor/dear',
          availability: { available: false, reason: 'model_not_priceable' },
        },
      ],
    });
  });

  it('refuses a send whose stored selection names a row of another modality', () => {
    // Reachable by catalog reclassification: the stored id still names a listed
    // row, just not one the modality being composed can price. The body carries
    // it regardless, so the verdict has to fail closed on it exactly as it does
    // on an id the catalog dropped outright.
    mockModelsData.current = {
      models: [imageRow({ id: 'vendor/imagen' }), videoRow({ id: 'vendor/veo' })],
    };
    mockSelection.current = [
      { id: 'vendor/imagen', name: 'Imagen' },
      { id: 'vendor/veo', name: 'Veo' },
    ];

    const { result } = renderHook(() =>
      useMediaTurnOptions({ isAuthenticated: true, basis: EMPTY_PROMPT_BASIS })
    );

    expect(result.current.options?.admissible).toMatchObject({
      sendable: false,
      refusal: 'model_not_priceable',
      all: [
        { modelId: 'vendor/imagen', availability: { available: true } },
        {
          modelId: 'vendor/veo',
          availability: { available: false, reason: 'model_not_priceable' },
        },
      ],
    });
  });

  it('scopes the funding read to the conversation, which is what names the payer', () => {
    renderHook(() =>
      useMediaTurnOptions({
        isAuthenticated: true,
        basis: EMPTY_PROMPT_BASIS,
        conversationId: 'conv-1',
      })
    );

    expect(mockFundingCalls).toEqual(['conv-1']);
  });
});
