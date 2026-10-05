import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MOBILE_BREAKPOINT, noticeText } from '@hushbox/shared';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import {
  COMMON_ASPECT_RATIOS,
  GenerationSettingsPopover,
  splitAspectRatios,
} from '@/components/chat/media/generation-settings-popover';
import { RatioChip } from '@/components/chat/media/ratio-chip';
import { VideoSettingsChip } from '@/components/chat/media/video-settings-chip';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';
import type { MediaDimensionAvailability, Model } from '@hushbox/shared';

const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(
    (): UseModelsStub => ({
      data: { models: [], premiumIds: new Set<string>() },
    })
  ),
}));
vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  return { ...actual, useModelStore: store };
});

/** The ratios a Seedream-class model declares: the ten common ones, seven more, and auto. */
const EVERY_RATIO = [
  '1:1',
  '1:2',
  '2:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '9:19.5',
  '19.5:9',
  '9:20',
  '20:9',
  '9:21',
  '21:9',
  'auto',
] as const;

const IMAGE_MODEL_ID = 'fictional/image';

function imageModel(supportedAspectRatios: readonly string[]): Model {
  return {
    id: IMAGE_MODEL_ID,
    name: 'Image',
    provider: 'Fictional',
    description: 'Image generation model.',
    modality: 'image',
    contextLength: 0,
    supportedParameters: [],
    supportedAspectRatios: [...supportedAspectRatios],
    pricing: { perImage: '40000000', dearestPerImage: '40000000' },
  } satisfies Model;
}

function useCatalog(models: readonly Model[]): void {
  mockUseModels.mockReturnValue({
    data: { models: [...models], premiumIds: new Set<string>() },
  });
}

function selectImageModels(ids: readonly string[], aspectRatio = '1:1'): void {
  modelStoreStubRef.current = createModelStoreStub({
    activeModality: 'image',
    imageConfig: { aspectRatio },
    selections: {
      text: [],
      image: ids.map((id) => ({ id, name: id })),
      audio: [],
      video: [],
    },
  });
}

const originalMatchMedia = globalThis.matchMedia;

/** A window one pixel under the desktop band, so the popover presents as a sheet. */
function installPhoneViewport(): void {
  const phoneQuery = `(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`;
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: query === phoneQuery,
        media: query,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      };
      // The band and pointer hooks read only `matches` and the listener pair.
      return list as MediaQueryList;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

interface OpenOptions {
  readonly dimensions?: readonly MediaDimensionAvailability[];
  readonly sendRefusal?: 'send_check_unavailable';
}

async function openPopover(options: OpenOptions = {}): Promise<HTMLElement> {
  render(
    <GenerationSettingsPopover
      modality="image"
      trigger={<RatioChip />}
      anchor={{ current: null }}
      {...(options.dimensions !== undefined && { dimensions: options.dimensions })}
      {...(options.sendRefusal !== undefined && { sendRefusal: options.sendRefusal })}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: /^Aspect ratio:/ }));
  return screen.getByRole('dialog', { name: 'Aspect ratio' });
}

/** The names of the grid's buttons, in reading order. */
function tileNames(popover: HTMLElement): string[] {
  const grid = within(popover).getByRole('group', { name: 'Aspect ratio' });
  return within(grid)
    .getAllByRole('button')
    .map((button) => button.textContent);
}

describe('COMMON_ASPECT_RATIOS', () => {
  it('holds the ten common ratios in the order the grid draws them', () => {
    expect(COMMON_ASPECT_RATIOS).toEqual([
      '1:1',
      '4:5',
      '3:4',
      '2:3',
      '9:16',
      '5:4',
      '4:3',
      '3:2',
      '16:9',
      '21:9',
    ]);
  });
});

describe('splitAspectRatios', () => {
  it('puts the common ratios a model supports first, in the common order', () => {
    expect(splitAspectRatios(['16:9', '1:1', '9:21', '4:3']).common).toEqual([
      '1:1',
      '4:3',
      '16:9',
    ]);
  });

  it('keeps the rest in the order the model declares them', () => {
    expect(splitAspectRatios(EVERY_RATIO).more).toEqual([
      '1:2',
      '2:1',
      '9:19.5',
      '19.5:9',
      '9:20',
      '20:9',
      '9:21',
    ]);
  });

  it('holds auto apart from both groups', () => {
    const split = splitAspectRatios(EVERY_RATIO);
    expect(split.auto).toBe(true);
    expect([...split.common, ...split.more]).not.toContain('auto');
  });

  it('offers no auto when the model declares none', () => {
    expect(splitAspectRatios(['1:1', '16:9']).auto).toBe(false);
  });

  it('leaves nothing more for a model that supports only common ratios', () => {
    expect(splitAspectRatios(['1:1', '16:9', 'auto']).more).toEqual([]);
  });
});

describe('GenerationSettingsPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCatalog([imageModel(EVERY_RATIO)]);
    selectImageModels([IMAGE_MODEL_ID]);
  });

  it('opens from its trigger as a dialog named Aspect ratio', async () => {
    const popover = await openPopover();
    expect(popover).toBeInTheDocument();
  });

  it('marks its trigger open while it is open', async () => {
    await openPopover();
    expect(screen.getByRole('button', { name: /^Aspect ratio:/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('heads the anchored popover with the Aspect ratio title', async () => {
    const popover = await openPopover();
    expect(within(popover).getByRole('heading', { name: 'Aspect ratio' })).toBeInTheDocument();
  });
  it('offers the common ratios, Auto, and the count of the rest', async () => {
    const popover = await openPopover();
    expect(tileNames(popover)).toEqual([...COMMON_ASPECT_RATIOS, 'Auto', '7 more']);
  });

  it('opens the rest in place, Auto last, with no more tile left', async () => {
    const popover = await openPopover();
    await userEvent.click(within(popover).getByRole('button', { name: '7 more' }));
    expect(tileNames(popover)).toEqual([
      ...COMMON_ASPECT_RATIOS,
      '1:2',
      '2:1',
      '9:19.5',
      '19.5:9',
      '9:20',
      '20:9',
      '9:21',
      'Auto',
    ]);
  });

  it('moves focus to the first ratio it opened', async () => {
    const popover = await openPopover();
    await userEvent.click(within(popover).getByRole('button', { name: '7 more' }));
    expect(within(popover).getByRole('button', { name: '1:2' })).toHaveFocus();
  });

  it('opens with every ratio showing when the chosen one is among the rest', async () => {
    selectImageModels([IMAGE_MODEL_ID], '9:21');
    const popover = await openPopover();
    expect(within(popover).getByRole('button', { name: '9:21' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(popover).queryByRole('button', { name: '7 more' })).not.toBeInTheDocument();
  });

  it('draws no more tile for a model that supports only common ratios', async () => {
    useCatalog([imageModel(['1:1', '16:9'])]);
    const popover = await openPopover();
    expect(tileNames(popover)).toEqual(['1:1', '16:9']);
  });

  it('presses the chosen ratio', async () => {
    const popover = await openPopover();
    expect(within(popover).getByRole('button', { name: '1:1' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(popover).getByRole('button', { name: '16:9' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('chooses a ratio for the image turn', async () => {
    const popover = await openPopover();
    await userEvent.click(within(popover).getByRole('button', { name: '16:9' }));
    expect(modelStoreStubRef.current.setImageConfig).toHaveBeenCalledWith({ aspectRatio: '16:9' });
  });

  it('chooses the automatic ratio by its catalog value', async () => {
    const popover = await openPopover();
    await userEvent.click(within(popover).getByRole('button', { name: 'Auto' }));
    expect(modelStoreStubRef.current.setImageConfig).toHaveBeenCalledWith({ aspectRatio: 'auto' });
  });

  it('stays open after a choice, so the price beside it can be read', async () => {
    const popover = await openPopover();
    await userEvent.click(within(popover).getByRole('button', { name: '16:9' }));
    expect(popover).toBeInTheDocument();
  });

  describe('a ratio the payer cannot afford', () => {
    const REFUSED_WIDE: readonly MediaDimensionAvailability[] = [
      {
        dimensionId: 'aspectRatio',
        options: [
          {
            optionId: '16:9',
            label: '16:9',
            availability: { available: false, reason: 'insufficient_funds' },
          },
          ...EVERY_RATIO.filter((ratio) => ratio !== '16:9').map((ratio) => ({
            optionId: ratio,
            label: ratio,
            availability: { available: true } as const,
          })),
        ],
      },
    ];

    it('stays focusable and greyed', async () => {
      const popover = await openPopover({ dimensions: REFUSED_WIDE });
      expect(within(popover).getByRole('button', { name: '16:9' })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
    });

    it('keeps the reason it was refused', async () => {
      const popover = await openPopover({ dimensions: REFUSED_WIDE });
      expect(within(popover).getByRole('button', { name: '16:9' })).toHaveAccessibleDescription(
        noticeText('insufficient_funds')
      );
    });

    it('is not chosen when pressed', async () => {
      const popover = await openPopover({ dimensions: REFUSED_WIDE });
      await userEvent.click(within(popover).getByRole('button', { name: '16:9' }));
      expect(modelStoreStubRef.current.setImageConfig).not.toHaveBeenCalled();
    });
  });

  it('names the conflict when the selected models share no ratio', async () => {
    useCatalog([
      imageModel(['1:1']),
      { ...imageModel(['16:9']), id: 'fictional/other-image' } satisfies Model,
    ]);
    selectImageModels([IMAGE_MODEL_ID, 'fictional/other-image']);
    const popover = await openPopover();
    expect(within(popover).getByText(/share no common aspect ratio/i)).toBeInTheDocument();
  });

  it('says once that the send could not be checked, in place of the grid', async () => {
    const popover = await openPopover({ sendRefusal: 'send_check_unavailable' });
    const spoken = within(popover)
      .getAllByRole('status')
      .filter((region) => region.textContent === noticeText('send_check_unavailable'));
    expect(spoken).toHaveLength(1);
    expect(within(popover).queryByRole('group', { name: 'Aspect ratio' })).not.toBeInTheDocument();
  });

  it('shows the estimated cost with its estimate note', async () => {
    const popover = await openPopover();
    const cost = within(popover).getByText('Cost').parentElement;
    expect(cost).toHaveTextContent(/≈ \$0\.\d{3}\(estimate\)/u);
  });

  describe('below 768px', () => {
    beforeEach(() => {
      installPhoneViewport();
    });

    it('is a sheet titled Aspect ratio, with its own close', async () => {
      const sheet = await openPopover();
      expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    });

    it('still offers the grid', async () => {
      const sheet = await openPopover();
      expect(tileNames(sheet)).toEqual([...COMMON_ASPECT_RATIOS, 'Auto', '7 more']);
    });
  });
});

const VIDEO_MODEL_ID = 'fictional/video';

function videoModel(): Model {
  return {
    id: VIDEO_MODEL_ID,
    name: 'Video',
    provider: 'Fictional',
    description: 'Video generation model.',
    modality: 'video',
    contextLength: 0,
    supportedParameters: [],
    supportedAspectRatios: ['16:9', '9:16'],
    supportedVideoResolutions: ['720p', '1080p'],
    supportedVideoDurationsSeconds: [4, 6, 8],
    pricing: {
      perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
      dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
    },
  } satisfies Model;
}

function selectVideoModel(): void {
  modelStoreStubRef.current = createModelStoreStub({
    activeModality: 'video',
    videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    selections: {
      text: [],
      image: [],
      audio: [],
      video: [{ id: VIDEO_MODEL_ID, name: 'Video' }],
    },
  });
}

async function openVideoPopover(options: OpenOptions = {}): Promise<HTMLElement> {
  render(
    <GenerationSettingsPopover
      modality="video"
      trigger={<VideoSettingsChip />}
      anchor={{ current: null }}
      {...(options.dimensions !== undefined && { dimensions: options.dimensions })}
      {...(options.sendRefusal !== undefined && { sendRefusal: options.sendRefusal })}
    />
  );
  await userEvent.click(screen.getByRole('button', { name: /^Video settings:/ }));
  return screen.getByRole('dialog', { name: 'Video settings' });
}

describe('GenerationSettingsPopover for a video turn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCatalog([videoModel()]);
    selectVideoModel();
  });

  it('opens from its chip as a dialog named Video settings', async () => {
    const popover = await openVideoPopover();
    expect(popover).toBeInTheDocument();
  });

  it('marks its chip open while it is open', async () => {
    await openVideoPopover();
    expect(screen.getByRole('button', { name: /^Video settings:/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('heads the anchored popover with the Video settings title', async () => {
    const popover = await openVideoPopover();
    expect(within(popover).getByRole('heading', { name: 'Video settings' })).toBeInTheDocument();
  });

  it('holds the aspect ratio pills under their heading', async () => {
    const popover = await openVideoPopover();
    expect(within(popover).getByRole('heading', { name: 'Aspect ratio' })).toBeInTheDocument();
    const ratios = within(popover).getByRole('group', { name: 'Aspect ratio' });
    expect(within(ratios).getByRole('button', { name: '16:9' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(ratios).getByRole('button', { name: '9:16' })).toBeInTheDocument();
  });

  it('holds the resolution pills under their heading', async () => {
    const popover = await openVideoPopover();
    expect(within(popover).getByRole('heading', { name: 'Resolution' })).toBeInTheDocument();
    const resolutions = within(popover).getByRole('group', { name: 'Resolution' });
    expect(within(resolutions).getByRole('button', { name: '720p' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(resolutions).getByRole('button', { name: '1080p' })).toBeInTheDocument();
  });

  it('holds the duration slider under its heading, over the durations the model offers', async () => {
    const popover = await openVideoPopover();
    expect(within(popover).getByRole('heading', { name: 'Duration' })).toBeInTheDocument();
    const slider = within(popover).getByRole('slider', { name: 'Video duration in seconds' });
    expect(slider).toHaveAttribute('min', '4');
    expect(slider).toHaveAttribute('max', '8');
    for (const seconds of [4, 6, 8]) {
      expect(
        within(popover).getByRole('button', { name: `Set duration to ${String(seconds)} seconds` })
      ).toBeInTheDocument();
    }
  });

  it('sets the duration from a tick on the slider', async () => {
    const popover = await openVideoPopover();
    await userEvent.click(
      within(popover).getByRole('button', { name: 'Set duration to 6 seconds' })
    );
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({ durationSeconds: 6 });
  });

  it('chooses a ratio for the video turn', async () => {
    const popover = await openVideoPopover();
    await userEvent.click(within(popover).getByRole('button', { name: '9:16' }));
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({ aspectRatio: '9:16' });
  });

  it('chooses a resolution for the video turn', async () => {
    const popover = await openVideoPopover();
    await userEvent.click(within(popover).getByRole('button', { name: '1080p' }));
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({ resolution: '1080p' });
  });

  it('draws no image ratio grid', async () => {
    const popover = await openVideoPopover();
    expect(within(popover).queryByRole('button', { name: /^\d+ more$/u })).not.toBeInTheDocument();
    expect(within(popover).queryByRole('button', { name: 'Auto' })).not.toBeInTheDocument();
  });

  it('greys a duration the payer cannot afford, with its reason', async () => {
    const popover = await openVideoPopover({
      dimensions: [
        {
          dimensionId: 'durationSeconds',
          options: [
            { optionId: '4', label: '4s', availability: { available: true } },
            { optionId: '6', label: '6s', availability: { available: true } },
            {
              optionId: '8',
              label: '8s',
              availability: { available: false, reason: 'insufficient_funds' },
            },
          ],
        },
      ],
    });
    const refused = within(popover).getByRole('button', { name: 'Set duration to 8 seconds' });
    expect(refused).toHaveAttribute('aria-disabled', 'true');
    expect(within(popover).getByText(noticeText('insufficient_funds'))).toBeInTheDocument();
  });

  it('says once that the send could not be checked, in place of the controls', async () => {
    const popover = await openVideoPopover({ sendRefusal: 'send_check_unavailable' });
    const spoken = within(popover)
      .getAllByRole('status')
      .filter((region) => region.textContent === noticeText('send_check_unavailable'));
    expect(spoken).toHaveLength(1);
    expect(within(popover).queryByRole('slider')).not.toBeInTheDocument();
    expect(within(popover).queryByRole('group', { name: 'Resolution' })).not.toBeInTheDocument();
  });

  it('shows the estimated cost with its estimate note', async () => {
    const popover = await openVideoPopover();
    const cost = within(popover).getByText('Cost').parentElement;
    expect(cost).toHaveTextContent(/≈ \$0\.\d{3}\(estimate\)/u);
  });

  describe('below 768px', () => {
    beforeEach(() => {
      installPhoneViewport();
    });

    it('is a sheet titled Video settings, with its own close', async () => {
      const sheet = await openVideoPopover();
      expect(within(sheet).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    });

    it('still holds the ratio, resolution and duration controls', async () => {
      const sheet = await openVideoPopover();
      expect(within(sheet).getByRole('group', { name: 'Aspect ratio' })).toBeInTheDocument();
      expect(within(sheet).getByRole('group', { name: 'Resolution' })).toBeInTheDocument();
      expect(
        within(sheet).getByRole('slider', { name: 'Video duration in seconds' })
      ).toBeInTheDocument();
    });
  });
});
