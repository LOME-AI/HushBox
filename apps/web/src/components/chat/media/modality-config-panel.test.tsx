import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { modelSchema, noticeText } from '@hushbox/shared';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import {
  ImageAspectRatioControl,
  VideoAspectRatioControl,
  VideoResolutionControl,
  VideoDurationControl,
  AudioFormatControl,
  AudioDurationControl,
  MediaCostLine,
  MediaFundingNotice,
} from '@/components/chat/media/modality-config-panel';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';
import type { MediaDimensionAvailability, Model, RefusalCode } from '@hushbox/shared';

// Mock useModels so panels can look up pricing without a QueryClient.
// Tests that care about pricing override the return value inline.
// The `mockUseModels` ref has to be declared via `vi.hoisted` so it's available
// inside the vi.mock factory (which runs before top-level declarations).
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

function mockModels(payload: { models: Model[] }): void {
  mockUseModels.mockReturnValue({
    data: {
      models: payload.models,
      premiumIds: new Set<string>(),
    },
  });
}

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

function resetModelStoreStub(overrides: Partial<ModelStoreStub> = {}): void {
  modelStoreStubRef.current = createModelStoreStub(overrides);
}

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

/**
 * A selected image model whose catalog row declares `ratios`. Since ingestion
 * excludes a media row that declares no aspect ratio, "a model is selected"
 * always implies a declared domain — there is no global list behind it.
 */
function selectImageModelOffering(ratios: readonly string[], activeRatio = '1:1'): void {
  mockModels({
    models: [
      {
        id: 'fictional/image',
        name: 'Image',
        provider: 'Fictional',
        description: 'Image generation model.',
        modality: 'image',
        contextLength: 0,
        supportedParameters: [],
        pricing: { perImage: '40000000', dearestPerImage: '40000000' },
        supportedAspectRatios: [...ratios],
      },
    ],
  });
  resetModelStoreStub({
    activeModality: 'image',
    imageConfig: { aspectRatio: activeRatio },
    selections: {
      text: [],
      image: [{ id: 'fictional/image', name: 'Image' }],
      audio: [],
      video: [],
    },
  });
}

/** The video twin of {@link selectImageModelOffering}. */
function selectVideoModelOffering(ratios: readonly string[], activeRatio = '16:9'): void {
  mockModels({
    models: [
      {
        id: 'fictional/video',
        name: 'Video',
        provider: 'Fictional',
        description: 'Video generation model.',
        modality: 'video',
        contextLength: 0,
        supportedParameters: [],
        pricing: {
          perSecondByResolution: { '720p': '40000000' },
          dearestPerSecondByResolution: { '720p': '40000000' },
        },
        supportedAspectRatios: [...ratios],
      },
    ],
  });
  resetModelStoreStub({
    activeModality: 'video',
    videoConfig: { aspectRatio: activeRatio, durationSeconds: 4, resolution: '720p' },
    selections: {
      text: [],
      image: [],
      audio: [],
      video: [{ id: 'fictional/video', name: 'Video' }],
    },
  });
}

const IMAGE_RATIOS = ['1:1', '4:3', '3:4', '16:9', '9:16'] as const;

describe('ImageAspectRatioControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
  });

  it('renders a pill for every ratio the selected model offers', () => {
    selectImageModelOffering(IMAGE_RATIOS);
    render(<ImageAspectRatioControl />);
    expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4:3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3:4' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
  });

  it('marks the active aspect ratio with aria-pressed=true', () => {
    selectImageModelOffering(IMAGE_RATIOS, '16:9');
    render(<ImageAspectRatioControl />);
    expect(screen.getByRole('button', { name: '16:9' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1:1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls setImageConfig when an aspect ratio is clicked', () => {
    selectImageModelOffering(IMAGE_RATIOS);
    render(<ImageAspectRatioControl />);
    fireEvent.click(screen.getByRole('button', { name: '16:9' }));
    expect(modelStoreStubRef.current.setImageConfig).toHaveBeenCalledWith({
      aspectRatio: '16:9',
    });
  });

  it('exposes the aspect ratio group with a screen-reader-only legend', () => {
    selectImageModelOffering(IMAGE_RATIOS);
    render(<ImageAspectRatioControl />);
    expect(screen.getByText(/aspect ratio/i)).toBeInTheDocument();
  });

  it('renders each ratio as a proportional shape pill with the ratio as label', () => {
    selectImageModelOffering(IMAGE_RATIOS);
    render(<ImageAspectRatioControl />);
    const shapes = screen.getAllByTestId('aspect-ratio-shape');
    expect(shapes).toHaveLength(5);
    const square = screen
      .getByRole('button', { name: '1:1' })
      .querySelector<HTMLElement>('[data-testid="aspect-ratio-shape"]')!;
    expect(square.style.aspectRatio).toBe('1 / 1');
    const wide = screen
      .getByRole('button', { name: '16:9' })
      .querySelector<HTMLElement>('[data-testid="aspect-ratio-shape"]')!;
    expect(wide.style.aspectRatio).toBe('16 / 9');
  });

  it('narrows ratios to the intersection across selected models', () => {
    mockModels({
      models: [
        {
          id: 'fictional/narrow-image',
          name: 'Narrow Image',
          provider: 'Fictional',
          description: 'Image generation model.',
          modality: 'image',
          contextLength: 0,
          supportedParameters: [],
          pricing: { perImage: '40000000', dearestPerImage: '40000000' },
          supportedAspectRatios: ['1:1', '16:9'],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'image',
      imageConfig: { aspectRatio: '1:1' },
      selections: {
        text: [],
        image: [{ id: 'fictional/narrow-image', name: 'Narrow' }],
        audio: [],
        video: [],
      },
    });
    render(<ImageAspectRatioControl />);
    expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '4:3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '3:4' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '9:16' })).not.toBeInTheDocument();
  });
});

describe('VideoAspectRatioControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    });
  });

  it('renders a pill for every ratio the selected model offers', () => {
    selectVideoModelOffering(['16:9', '9:16']);
    render(<VideoAspectRatioControl />);
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
  });

  it('does not render a ratio the selected model does not offer', () => {
    selectVideoModelOffering(['16:9', '9:16']);
    render(<VideoAspectRatioControl />);
    expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '4:3' })).not.toBeInTheDocument();
  });

  it('marks the active aspect ratio with aria-pressed=true', () => {
    selectVideoModelOffering(['16:9', '9:16'], '9:16');
    render(<VideoAspectRatioControl />);
    expect(screen.getByRole('button', { name: '9:16' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes setVideoConfig when aspect ratio changes', () => {
    selectVideoModelOffering(['16:9', '9:16']);
    render(<VideoAspectRatioControl />);
    fireEvent.click(screen.getByRole('button', { name: '9:16' }));
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      aspectRatio: '9:16',
    });
  });

  it('renders each video ratio as a proportional shape pill', () => {
    selectVideoModelOffering(['16:9', '9:16']);
    render(<VideoAspectRatioControl />);
    const wide = screen
      .getByRole('button', { name: '16:9' })
      .querySelector<HTMLElement>('[data-testid="aspect-ratio-shape"]')!;
    expect(wide.style.aspectRatio).toBe('16 / 9');
    const tall = screen
      .getByRole('button', { name: '9:16' })
      .querySelector<HTMLElement>('[data-testid="aspect-ratio-shape"]')!;
    expect(tall.style.aspectRatio).toBe('9 / 16');
  });

  it('narrows ratios to the intersection across selected video models', () => {
    mockModels({
      models: [
        {
          id: 'fictional/landscape-only',
          name: 'Landscape Only',
          provider: 'Fictional',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000' },
            dearestPerSecondByResolution: { '720p': '400000000' },
          },
          supportedAspectRatios: ['16:9'],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'fictional/landscape-only', name: 'Landscape Only' }],
      },
    });
    render(<VideoAspectRatioControl />);
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '9:16' })).not.toBeInTheDocument();
  });
});

describe('VideoResolutionControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an empty-state hint when no model is selected', () => {
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: { text: [], image: [], audio: [], video: [] },
    });
    render(<VideoResolutionControl />);
    expect(screen.getByText(/Select a video model to see resolution options/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /720p/i })).not.toBeInTheDocument();
  });

  it('renders a tier with no consumer label under its own name', () => {
    // The label map is presentation over catalog-minted tier names, not a domain:
    // a tier it does not know still renders, labelled by the catalog's own value.
    mockModels({
      models: [
        {
          id: 'fictional/video',
          name: 'Video',
          provider: 'Fictional',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '1440p': '120000000' },
            dearestPerSecondByResolution: { '1440p': '120000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '1440p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'fictional/video', name: 'Video' }],
      },
    });
    render(<VideoResolutionControl />);
    const pill = screen.getByRole('button', { name: '1440p' });
    expect(pill).toHaveTextContent('1440p');
  });

  it('renders each supported resolution as a button labeled by its raw value', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          name: 'Veo 3.1',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
            dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.getByRole('button', { name: '720p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1080p' })).toBeInTheDocument();
  });

  it('imposes no resolution constraint for a model with empty per-resolution pricing', () => {
    const emptyResolutionPricing: Model = {
      id: 'video/no-pricing',
      name: 'No Pricing',
      provider: 'Video',
      description: 'Video generation model.',
      modality: 'video',
      contextLength: 0,
      supportedParameters: [],
      pricing: { perSecondByResolution: {}, dearestPerSecondByResolution: {} },
    };
    // Parsing the row pins the premise this guard rests on: the wire contract
    // refuses a video row carrying no per-second rate, so no endpoint can emit
    // one and the control is being handed input only a bug could produce. Should
    // the contract ever admit such a row, this fails instead of the guard
    // quietly going idle.
    expect(modelSchema.safeParse(emptyResolutionPricing).success).toBe(false);
    mockModels({ models: [emptyResolutionPricing] });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'video/no-pricing', name: 'No Pricing' }],
      },
    });
    render(<VideoResolutionControl />);
    // A model with no per-resolution pricing contributes no options, so the
    // agreed intersection is empty and no resolution buttons render.
    expect(screen.queryByRole('button', { name: '720p' })).not.toBeInTheDocument();
  });

  it('imposes no resolution constraint for a model with no pricing block at all', () => {
    // The model omits `perSecondByResolution` entirely (undefined, not {}), so
    // the resolution fallback reads no keys and contributes no options.
    const absentPricing: Model = {
      id: 'video/absent-pricing',
      name: 'Absent Pricing',
      provider: 'Video',
      description: 'Video generation model.',
      modality: 'video',
      contextLength: 0,
      supportedParameters: [],
      pricing: {},
    };
    expect(modelSchema.safeParse(absentPricing).success).toBe(false);
    mockModels({ models: [absentPricing] });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'video/absent-pricing', name: 'Absent Pricing' }],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.queryByRole('button', { name: '720p' })).not.toBeInTheDocument();
  });

  it('renders consumer-friendly labels (HD/FHD) above the raw pixel resolution', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          name: 'Veo 3.1',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
            dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    const hdButton = screen.getByRole('button', { name: '720p' });
    expect(hdButton).toHaveTextContent('HD');
    expect(hdButton).toHaveTextContent('720p');
    const fhdButton = screen.getByRole('button', { name: '1080p' });
    expect(fhdButton).toHaveTextContent('FHD');
    expect(fhdButton).toHaveTextContent('1080p');
  });

  it('does not render any per-second price line inside the resolution control', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          name: 'Veo 3.1',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
            dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.queryByTestId('resolution-price')).not.toBeInTheDocument();
    expect(screen.queryByText(/\$\d+\.\d+\/s/)).not.toBeInTheDocument();
  });

  it('omits resolutions not priced by the primary model', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          name: 'Veo 3.1',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '1080p': '150000000' },
            dearestPerSecondByResolution: { '1080p': '150000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.queryByRole('button', { name: /720p/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1080p/ })).toBeInTheDocument();
  });

  it('writes setVideoConfig when a resolution is clicked', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          name: 'Veo 3.1',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
            dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    fireEvent.click(screen.getByRole('button', { name: '1080p' }));
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      resolution: '1080p',
    });
  });

  it('writes no config on mount when the stored resolution is unsupported', () => {
    // Correcting the stored value is the app-wide snap's job (it runs whether or
    // not this control is mounted); the control only renders what is offered.
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          name: 'Veo 3.1',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '1080p': '150000000' },
            dearestPerSecondByResolution: { '1080p': '150000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.getByRole('button', { name: '1080p' })).toBeInTheDocument();
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });
});

describe('VideoDurationControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    });
  });

  it('falls back to the 1-8s legacy bounds when no model is selected', () => {
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '8');
    expect(slider).toHaveValue('4');
  });

  it('writes setVideoConfig when duration changes (no model — no snap)', () => {
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '6' } });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      durationSeconds: 6,
    });
  });

  it('displays the current duration next to the slider', () => {
    render(<VideoDurationControl />);
    expect(screen.getByText(/4s/i)).toBeInTheDocument();
  });

  it('exposes the duration in aria-valuetext for screen readers', () => {
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuetext', '4 seconds');
  });

  it('clamps min and max to the selected Veo 3.1 model durations (4-8)', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          name: 'Veo 3 1 Generate 001',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000' },
            dearestPerSecondByResolution: { '720p': '400000000' },
          },
          supportedVideoDurationsSeconds: [4, 6, 8],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' }],
      },
    });
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '4');
    expect(slider).toHaveAttribute('max', '8');
  });

  it('derives min/max from an unsorted catalog duration set without inverting the range', () => {
    mockModels({
      models: [
        {
          id: 'video/unsorted-durations',
          name: 'Unsorted Durations',
          provider: 'Video',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000' },
            dearestPerSecondByResolution: { '720p': '400000000' },
          },
          supportedVideoDurationsSeconds: [8, 4, 6],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'video/unsorted-durations', name: 'Unsorted Durations' }],
      },
    });
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '4');
    expect(slider).toHaveAttribute('max', '8');
  });

  it('runs the slider freely when the selected models agree on no supported durations', () => {
    mockModels({
      models: [
        {
          id: 'video/no-durations',
          name: 'No Durations',
          provider: 'Video',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000' },
            dearestPerSecondByResolution: { '720p': '400000000' },
          },
          supportedVideoDurationsSeconds: [],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'video/no-durations', name: 'No Durations' }],
      },
    });
    render(<VideoDurationControl />);
    // No snap occurs because there is no supported-duration set.
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });

  it('writes no config on mount when the stored duration is off the supported set', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          name: 'Veo 3 1 Generate 001',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000' },
            dearestPerSecondByResolution: { '720p': '400000000' },
          },
          supportedVideoDurationsSeconds: [4, 6, 8],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' }],
      },
    });
    render(<VideoDurationControl />);
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });

  it('snaps a raw 5 to the nearest supported value (4) when Veo 3.1 is selected', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          name: 'Veo 3 1 Generate 001',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000' },
            dearestPerSecondByResolution: { '720p': '400000000' },
          },
          supportedVideoDurationsSeconds: [4, 6, 8],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' }],
      },
    });
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '5' } });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      durationSeconds: 4,
    });
  });

  it('intersects durations across multiple selected models with disjoint sets', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          name: 'Veo 3 1 Generate 001',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000' },
            dearestPerSecondByResolution: { '720p': '400000000' },
          },
          supportedVideoDurationsSeconds: [4, 6, 8],
        },
        {
          id: 'mock/long-only',
          name: 'Long Only',
          provider: 'Mock',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000' },
            dearestPerSecondByResolution: { '720p': '400000000' },
          },
          supportedVideoDurationsSeconds: [6, 8, 10],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [
          { id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' },
          { id: 'mock/long-only', name: 'Long Only' },
        ],
      },
    });
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '6');
    expect(slider).toHaveAttribute('max', '8');
  });
});

describe('VideoResolutionControl + 4K', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a 4K button when the selected Veo 3.1 model lists it', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1-generate-001',
          name: 'Veo 3 1 Generate 001',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000', '1080p': '400000000', '4k': '600000000' },
            dearestPerSecondByResolution: {
              '720p': '400000000',
              '1080p': '400000000',
              '4k': '600000000',
            },
          },
          supportedVideoResolutions: ['720p', '1080p', '4k'],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl />);
    const fourK = screen.getByRole('button', { name: /^4k$/i });
    expect(fourK).toBeInTheDocument();
    expect(fourK).toHaveTextContent('4K');
    expect(fourK).toHaveTextContent('2160p');
  });

  it('drops 4K from the intersection when Veo 3.0 (no 4K) is co-selected — primary is Veo 3.1', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.0-generate-001',
          name: 'Veo 3 0 Generate 001',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000', '1080p': '400000000' },
            dearestPerSecondByResolution: { '720p': '400000000', '1080p': '400000000' },
          },
          supportedVideoResolutions: ['720p', '1080p'],
        },
        {
          id: 'google/veo-3.1-generate-001',
          name: 'Veo 3 1 Generate 001',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '400000000', '1080p': '400000000', '4k': '600000000' },
            dearestPerSecondByResolution: {
              '720p': '400000000',
              '1080p': '400000000',
              '4k': '600000000',
            },
          },
          supportedVideoResolutions: ['720p', '1080p', '4k'],
        },
      ],
    });
    // Order matters: Veo 3.1 is primary (has 4K). Without cross-model
    // agreement, the picker would expose 4K despite Veo 3.0 not supporting it,
    // which is the exact bug the agreement helper exists to prevent.
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [
          { id: 'google/veo-3.1-generate-001', name: 'Veo 3.1' },
          { id: 'google/veo-3.0-generate-001', name: 'Veo 3.0' },
        ],
      },
    });
    render(<VideoResolutionControl />);
    expect(screen.queryByRole('button', { name: /4k/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /720p/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1080p/i })).toBeInTheDocument();
  });
});

describe('AudioFormatControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({
      activeModality: 'audio',
      audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
    });
  });

  it('renders the format picker with all supported formats', () => {
    render(<AudioFormatControl />);
    expect(screen.getByRole('button', { name: 'mp3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'wav' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ogg' })).toBeInTheDocument();
  });

  it('marks the active format with aria-pressed=true', () => {
    render(<AudioFormatControl />);
    expect(screen.getByRole('button', { name: 'mp3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'wav' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls setAudioConfig when a format is clicked', () => {
    render(<AudioFormatControl />);
    fireEvent.click(screen.getByRole('button', { name: 'wav' }));
    expect(modelStoreStubRef.current.setAudioConfig).toHaveBeenCalledWith({ format: 'wav' });
  });
});

describe('AudioDurationControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({
      activeModality: 'audio',
      audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
    });
  });

  it('renders a max duration slider that reflects audioConfig.maxDurationSeconds', () => {
    render(<AudioDurationControl />);
    const slider = screen.getByRole('slider', { name: /audio max duration/i });
    expect(slider).toHaveValue('60');
  });

  it('calls setAudioConfig when the duration slider changes', () => {
    render(<AudioDurationControl />);
    const slider = screen.getByRole('slider', { name: /audio max duration/i });
    fireEvent.change(slider, { target: { value: '120' } });
    expect(modelStoreStubRef.current.setAudioConfig).toHaveBeenCalledWith({
      maxDurationSeconds: 120,
    });
  });

  it('caps the slider max at MAX_AUDIO_DURATION_SECONDS', () => {
    render(<AudioDurationControl />);
    const slider = screen.getByRole('slider', { name: /audio max duration/i });
    expect(slider).toHaveAttribute('max', '600');
    expect(slider).toHaveAttribute('min', '1');
  });

  it('exposes the audio max duration in aria-valuetext for screen readers', () => {
    render(<AudioDurationControl />);
    const slider = screen.getByRole('slider', { name: /audio max duration/i });
    expect(slider).toHaveAttribute('aria-valuetext', '60 seconds');
  });
});

describe('MediaCostLine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('image modality', () => {
    it('displays an estimated cost when an image model is selected', () => {
      mockModels({
        models: [
          {
            id: 'google/imagen-4',
            name: 'Imagen 4',
            provider: 'Google',
            description: 'Image generation model.',
            modality: 'image',
            contextLength: 0,
            supportedParameters: [],
            pricing: { perImage: '40000000', dearestPerImage: '40000000' },
          },
        ],
      });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
          audio: [],
          video: [],
        },
      });
      render(<MediaCostLine modality="image" />);
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });

    it('renders the estimate through the shared unit-price formatter', () => {
      // The panel already prices per-image rates with `nanoUnitPriceUsd`; the
      // estimate line must round the same way, which a float dollar conversion
      // does not at a half-thousandth tie (145_500_000 nano → $0.146, not
      // $0.145). Positive on the exact string, not a shape regex.
      mockModels({
        models: [
          {
            id: 'google/imagen-4',
            name: 'Imagen 4',
            provider: 'Google',
            description: 'Image generation model.',
            modality: 'image',
            contextLength: 0,
            supportedParameters: [],
            pricing: { perImage: '1500000', dearestPerImage: '1500000' },
          },
        ],
      });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
          audio: [],
          video: [],
        },
      });
      render(<MediaCostLine modality="image" />);
      expect(screen.getByText('≈ $0.146')).toBeInTheDocument();
    });

    it('renders an "(estimate)" sublabel below the dollar amount', () => {
      mockModels({
        models: [
          {
            id: 'google/imagen-4',
            name: 'Imagen 4',
            provider: 'Google',
            description: 'Image generation model.',
            modality: 'image',
            contextLength: 0,
            supportedParameters: [],
            pricing: { perImage: '40000000', dearestPerImage: '40000000' },
          },
        ],
      });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
          audio: [],
          video: [],
        },
      });
      render(<MediaCostLine modality="image" />);
      expect(screen.getByText('(estimate)')).toBeInTheDocument();
    });

    describe('in the kit caption style', () => {
      function renderPricedImage(): void {
        mockModels({
          models: [
            {
              id: 'google/imagen-4',
              name: 'Imagen 4',
              provider: 'Google',
              description: 'Image generation model.',
              modality: 'image',
              contextLength: 0,
              supportedParameters: [],
              pricing: { perImage: '40000000', dearestPerImage: '40000000' },
            },
          ],
        });
        resetModelStoreStub({
          activeModality: 'image',
          imageConfig: { aspectRatio: '1:1' },
          selections: {
            text: [],
            image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
            audio: [],
            video: [],
          },
        });
        render(<MediaCostLine modality="image" />);
      }

      it('sets the caption at the 0.75rem caption step, which scales with text size', () => {
        renderPricedImage();
        const caption = screen.getByText('(estimate)');
        expect(caption).toHaveClass('text-caption');
        expect(caption.className).not.toMatch(/text-\[\d+px\]/u);
      });

      it('draws the caption in full muted ink, with no opacity wash', () => {
        renderPricedImage();
        const caption = screen.getByText('(estimate)');
        expect(caption).toHaveClass('text-muted-foreground');
        expect(caption.className).not.toMatch(/opacity-/u);
      });

      it('draws the figure in mono at ink', () => {
        renderPricedImage();
        const figure = screen.getByText(/^≈ \$/u);
        expect(figure).toHaveClass('font-mono');
        expect(figure).toHaveClass('text-foreground');
      });
    });

    it('renders null when no image model is selected', () => {
      mockModels({ models: [] });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: { text: [], image: [], audio: [], video: [] },
      });
      const { container } = render(<MediaCostLine modality="image" />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('video modality', () => {
    it('displays an estimated cost for the current config', () => {
      mockModels({
        models: [
          {
            id: 'google/veo-3.1',
            name: 'Veo 3.1',
            provider: 'Google',
            description: 'Video generation model.',
            modality: 'video',
            contextLength: 0,
            supportedParameters: [],
            pricing: {
              perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
              dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
            },
          },
        ],
      });
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
        selections: {
          text: [],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
      render(<MediaCostLine modality="video" />);
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });
  });

  describe('audio modality', () => {
    it('displays no estimate, because no price kind represents audio', () => {
      mockUseModels.mockReturnValue({
        data: {
          models: [
            {
              id: 'openai/tts-1',
              name: 'TTS 1',
              provider: 'OpenAI',
              description: 'Audio generation model.',
              modality: 'audio',
              contextLength: 0,
              supportedParameters: [],
              pricing: {},
            },
          ],
          premiumIds: new Set<string>(),
        },
      });
      resetModelStoreStub({
        activeModality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
        selections: {
          text: [],
          image: [],
          audio: [{ id: 'openai/tts-1', name: 'TTS-1' }],
          video: [],
        },
      });
      render(<MediaCostLine modality="audio" />);
      expect(screen.queryByText(/^≈ \$/)).not.toBeInTheDocument();
    });
  });

  describe('a selected model the catalog carries no rate for', () => {
    // The old contract priced the unknown model at zero and showed a figure.
    // That figure is the turn's DECISION domain as well as its display: the
    // funding resolver compares it, any headroom clears a short one, and the
    // composer read FUNDED for a turn nobody could price. No rate now means no
    // price, and no price shows nothing.
    it('shows no image estimate at all', () => {
      mockModels({
        models: [
          {
            id: 'google/imagen-4',
            name: 'Imagen 4',
            provider: 'Google',
            description: 'Image generation model.',
            modality: 'image',
            contextLength: 0,
            supportedParameters: [],
            pricing: { perImage: '40000000', dearestPerImage: '40000000' },
          },
        ],
      });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [],
          image: [
            { id: 'google/imagen-4', name: 'Imagen 4' },
            { id: 'ghost/model', name: 'Ghost' },
          ],
          audio: [],
          video: [],
        },
      });
      render(<MediaCostLine modality="image" />);
      expect(screen.queryByText(/^≈ \$/)).not.toBeInTheDocument();
    });

    it('shows no video estimate at all', () => {
      mockModels({
        models: [
          {
            id: 'google/veo-3.1',
            name: 'Veo 3.1',
            provider: 'Google',
            description: 'Video generation model.',
            modality: 'video',
            contextLength: 0,
            supportedParameters: [],
            pricing: {
              perSecondByResolution: { '720p': '200000000' },
              dearestPerSecondByResolution: { '720p': '200000000' },
            },
          },
        ],
      });
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 4 },
        selections: {
          text: [],
          image: [],
          audio: [],
          video: [
            { id: 'google/veo-3.1', name: 'Veo 3.1' },
            { id: 'ghost/model', name: 'Ghost' },
          ],
        },
      });
      render(<MediaCostLine modality="video" />);
      expect(screen.queryByText(/^≈ \$/)).not.toBeInTheDocument();
    });

    it('shows no audio estimate at all', () => {
      mockModels({
        models: [
          {
            id: 'openai/tts-1',
            name: 'TTS 1',
            provider: 'OpenAI',
            description: 'Audio generation model.',
            modality: 'audio',
            contextLength: 0,
            supportedParameters: [],
            pricing: {},
          },
        ],
      });
      resetModelStoreStub({
        activeModality: 'audio',
        audioConfig: { format: 'mp3', maxDurationSeconds: 60 },
        selections: {
          text: [],
          image: [],
          audio: [
            { id: 'openai/tts-1', name: 'TTS-1' },
            { id: 'ghost/model', name: 'Ghost' },
          ],
          video: [],
        },
      });
      render(<MediaCostLine modality="audio" />);
      expect(screen.queryByText(/^≈ \$/)).not.toBeInTheDocument();
    });
  });
});

/**
 * Two video models whose declared domains on one axis share nothing. The pair
 * mirrors the live catalog collision (`[8, 4, 6]` against `[5, 10]`) that let a
 * turn be composed which no request could satisfy.
 */
function selectCollidingVideoModels(axis: 'aspectRatio' | 'resolution' | 'durationSeconds'): void {
  const first: Model = {
    id: 'fictional/video-a',
    name: 'Video A',
    provider: 'Fictional',
    description: 'Video generation model.',
    modality: 'video',
    contextLength: 0,
    supportedParameters: [],
    pricing: {
      perSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
      dearestPerSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
    },
    supportedAspectRatios: axis === 'aspectRatio' ? ['16:9'] : ['16:9', '9:16'],
    supportedVideoResolutions: axis === 'resolution' ? ['720p'] : ['720p', '1080p'],
    supportedVideoDurationsSeconds: axis === 'durationSeconds' ? [8, 4, 6] : [4, 6],
  };
  const second: Model = {
    ...first,
    id: 'fictional/video-b',
    supportedAspectRatios: axis === 'aspectRatio' ? ['9:16'] : ['16:9', '9:16'],
    supportedVideoResolutions: axis === 'resolution' ? ['1080p'] : ['720p', '1080p'],
    supportedVideoDurationsSeconds: axis === 'durationSeconds' ? [5, 10] : [4, 6],
  };
  mockModels({ models: [first, second] });
  resetModelStoreStub({
    activeModality: 'video',
    videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    selections: {
      text: [],
      image: [],
      audio: [],
      video: [
        { id: 'fictional/video-a', name: 'Video A' },
        { id: 'fictional/video-b', name: 'Video B' },
      ],
    },
  });
}

describe('a media axis the selected models cannot agree on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces the duration slider with a reason the user can act on', () => {
    selectCollidingVideoModels('durationSeconds');
    render(<VideoDurationControl />);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.getByText(/share no common duration/i)).toBeInTheDocument();
  });

  it('replaces the resolution pills with a reason the user can act on', () => {
    selectCollidingVideoModels('resolution');
    render(<VideoResolutionControl />);
    expect(screen.queryByRole('button', { name: '720p' })).not.toBeInTheDocument();
    expect(screen.getByText(/share no common resolution/i)).toBeInTheDocument();
  });

  it('distinguishes an unsendable resolution combination from having selected no model', () => {
    selectCollidingVideoModels('resolution');
    render(<VideoResolutionControl />);
    expect(screen.queryByText(/select a video model/i)).not.toBeInTheDocument();
  });

  it('replaces the video aspect ratio pills with a reason the user can act on', () => {
    selectCollidingVideoModels('aspectRatio');
    render(<VideoAspectRatioControl />);
    expect(screen.queryByRole('button', { name: '16:9' })).not.toBeInTheDocument();
    expect(screen.getByText(/share no common aspect ratio/i)).toBeInTheDocument();
  });

  it('replaces the image aspect ratio pills with a reason the user can act on', () => {
    mockModels({
      models: [
        {
          id: 'fictional/image-a',
          name: 'Image A',
          provider: 'Fictional',
          description: 'Image generation model.',
          modality: 'image',
          contextLength: 0,
          supportedParameters: [],
          pricing: { perImage: '40000000', dearestPerImage: '40000000' },
          supportedAspectRatios: ['1:1'],
        },
        {
          id: 'fictional/image-b',
          name: 'Image B',
          provider: 'Fictional',
          description: 'Image generation model.',
          modality: 'image',
          contextLength: 0,
          supportedParameters: [],
          pricing: { perImage: '40000000', dearestPerImage: '40000000' },
          supportedAspectRatios: ['16:9'],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'image',
      imageConfig: { aspectRatio: '1:1' },
      selections: {
        text: [],
        image: [
          { id: 'fictional/image-a', name: 'Image A' },
          { id: 'fictional/image-b', name: 'Image B' },
        ],
        audio: [],
        video: [],
      },
    });
    render(<ImageAspectRatioControl />);
    expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
    expect(screen.getByText(/share no common aspect ratio/i)).toBeInTheDocument();
  });
});

describe('the greying verdict the producer hands the panel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** One axis verdict as the money layer produces it, for `optionId` alone. */
  function refusedOption(
    dimensionId: 'aspectRatio' | 'resolution',
    optionId: string,
    offered: readonly string[],
    reason: RefusalCode
  ): readonly MediaDimensionAvailability[] {
    const [first, ...rest] = offered.map((option) => ({
      optionId: option,
      label: option,
      availability:
        option === optionId
          ? ({ available: false, reason } as const)
          : ({ available: true } as const),
    }));
    if (first === undefined) throw new Error('offered must not be empty');
    return [{ dimensionId, options: [first, ...rest] }];
  }

  it('greys a resolution the payer cannot afford, with the reason the send gate would give', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          name: 'Veo 3.1',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
            dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(
      <VideoResolutionControl
        dimensions={refusedOption('resolution', '1080p', ['720p', '1080p'], 'insufficient_funds')}
      />
    );
    const refused = screen.getByRole('button', { name: '1080p' });
    expect(refused).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(noticeText('insufficient_funds'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '720p' })).not.toHaveAttribute('aria-disabled');
  });

  it('refuses to select a greyed resolution', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          name: 'Veo 3.1',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
            dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(
      <VideoResolutionControl
        dimensions={refusedOption('resolution', '1080p', ['720p', '1080p'], 'insufficient_funds')}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '1080p' }));
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });

  it('greys an aspect ratio no selected model can be priced at', () => {
    selectImageModelOffering(IMAGE_RATIOS);
    render(
      <ImageAspectRatioControl
        dimensions={refusedOption('aspectRatio', '4:3', [...IMAGE_RATIOS], 'model_not_priceable')}
      />
    );
    expect(screen.getByRole('button', { name: '4:3' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(noticeText('model_not_priceable'))).toBeInTheDocument();
  });

  /** A produced axis that grades only the options listed, as the money layer does. */
  function gradedOnly(
    dimensionId: 'aspectRatio' | 'resolution',
    graded: readonly string[]
  ): readonly MediaDimensionAvailability[] {
    const [first, ...rest] = graded.map((option) => ({
      optionId: option,
      label: option,
      availability: { available: true } as const,
    }));
    if (first === undefined) throw new Error('graded must not be empty');
    return [{ dimensionId, options: [first, ...rest] }];
  }

  it('greys a resolution the produced verdict does not grade', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          name: 'Veo 3.1',
          provider: 'Google',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
            dearestPerSecondByResolution: { '720p': '100000000', '1080p': '150000000' },
          },
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
      },
    });
    render(<VideoResolutionControl dimensions={gradedOnly('resolution', ['720p'])} />);
    expect(screen.getByRole('button', { name: '1080p' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(noticeText('option_not_offered'))).toBeInTheDocument();
  });

  it('greys every option of an axis the produced verdict does not carry', () => {
    selectImageModelOffering(IMAGE_RATIOS);
    render(<ImageAspectRatioControl dimensions={gradedOnly('resolution', ['720p'])} />);
    for (const ratio of IMAGE_RATIOS) {
      expect(screen.getByRole('button', { name: ratio })).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('renders every option ungreyed while no verdict exists', () => {
    // A pending funding or catalog read has no verdict to render, and greying
    // rows against an absent one refuses options the payer can in fact afford.
    selectImageModelOffering(IMAGE_RATIOS);
    render(<ImageAspectRatioControl />);
    for (const ratio of IMAGE_RATIOS) {
      expect(screen.getByRole('button', { name: ratio })).not.toHaveAttribute('aria-disabled');
    }
  });
});

describe('an aspect ratio the selected model does not offer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Pulling the stored ratio back onto the offered set belongs to the app-wide
  // snap, which runs whether or not any of these controls is mounted; a control
  // that corrected the store itself only did so on the surfaces the user opened.
  it('leaves the stored image aspect ratio to the app-wide snap', () => {
    selectImageModelOffering(['16:9', '9:16'], '1:1');
    render(<ImageAspectRatioControl />);
    expect(modelStoreStubRef.current.setImageConfig).not.toHaveBeenCalled();
  });

  it('leaves the stored video aspect ratio to the app-wide snap', () => {
    selectVideoModelOffering(['1:1', '4:3'], '16:9');
    render(<VideoAspectRatioControl />);
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });
});

describe('the duration axis reading the same verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * A selected video model declaring a discrete duration domain — the only state
   * in which the slider offers durations to grade.
   */
  function selectVideoModelOfferingDurations(seconds: readonly number[], active = 4): void {
    mockModels({
      models: [
        {
          id: 'fictional/video',
          name: 'Video',
          provider: 'Fictional',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '40000000' },
            dearestPerSecondByResolution: { '720p': '40000000' },
          },
          supportedVideoDurationsSeconds: [...seconds],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: active, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'fictional/video', name: 'Video' }],
      },
    });
  }

  /**
   * A produced verdict carrying all three media axes, with the duration axis
   * LAST and the other two graded available. The neighbours are the point: an
   * axis read positionally, or under a sibling's id, answers from a row that
   * grades no duration at all and would look green against a one-axis fixture.
   */
  function videoVerdict(
    gradedSeconds: readonly number[],
    refusals: Readonly<Record<number, RefusalCode>> = {}
  ): readonly MediaDimensionAvailability[] {
    const [first, ...rest] = gradedSeconds.map((seconds) => {
      const reason = refusals[seconds];
      return {
        optionId: String(seconds),
        label: `${String(seconds)}s`,
        availability:
          reason === undefined
            ? ({ available: true } as const)
            : ({ available: false, reason } as const),
      };
    });
    if (first === undefined) throw new Error('the duration axis grades at least one option');
    return [
      {
        dimensionId: 'aspectRatio',
        options: [{ optionId: '16:9', label: '16:9', availability: { available: true } }],
      },
      {
        dimensionId: 'resolution',
        options: [{ optionId: '720p', label: '720p', availability: { available: true } }],
      },
      { dimensionId: 'durationSeconds', options: [first, ...rest] },
    ];
  }

  function durationTick(seconds: number): HTMLElement {
    return screen.getByRole('button', { name: `Set duration to ${String(seconds)} seconds` });
  }

  it('greys a duration the payer cannot afford, with the reason the send gate would give', () => {
    selectVideoModelOfferingDurations([4, 6, 8]);
    render(
      <VideoDurationControl dimensions={videoVerdict([4, 6, 8], { 8: 'insufficient_funds' })} />
    );
    expect(durationTick(8)).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(noticeText('insufficient_funds'))).toBeInTheDocument();
  });

  it('leaves a duration the payer can afford selectable', () => {
    selectVideoModelOfferingDurations([4, 6, 8]);
    render(
      <VideoDurationControl dimensions={videoVerdict([4, 6, 8], { 8: 'insufficient_funds' })} />
    );
    expect(durationTick(6)).not.toHaveAttribute('aria-disabled');
  });

  it('refuses to select a greyed duration', () => {
    selectVideoModelOfferingDurations([4, 6, 8]);
    render(
      <VideoDurationControl dimensions={videoVerdict([4, 6, 8], { 8: 'insufficient_funds' })} />
    );
    fireEvent.click(durationTick(8));
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });

  it('refuses a drag that lands on a greyed duration', () => {
    selectVideoModelOfferingDurations([4, 6, 8]);
    render(
      <VideoDurationControl dimensions={videoVerdict([4, 6, 8], { 8: 'insufficient_funds' })} />
    );
    fireEvent.change(screen.getByRole('slider'), { target: { value: '8' } });
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });

  it('writes a drag that lands on an affordable duration', () => {
    selectVideoModelOfferingDurations([4, 6, 8]);
    render(
      <VideoDurationControl dimensions={videoVerdict([4, 6, 8], { 8: 'insufficient_funds' })} />
    );
    fireEvent.change(screen.getByRole('slider'), { target: { value: '6' } });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({ durationSeconds: 6 });
  });

  it('greys a duration the produced verdict does not grade', () => {
    selectVideoModelOfferingDurations([4, 6, 8]);
    render(<VideoDurationControl dimensions={videoVerdict([4, 6])} />);
    expect(durationTick(8)).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(noticeText('option_not_offered'))).toBeInTheDocument();
  });

  it('leaves every duration ungreyed while no verdict exists', () => {
    selectVideoModelOfferingDurations([4, 6, 8]);
    render(<VideoDurationControl />);
    for (const seconds of [4, 6, 8]) {
      expect(durationTick(seconds)).not.toHaveAttribute('aria-disabled');
    }
  });

  it('writes a dragged duration while no verdict exists', () => {
    selectVideoModelOfferingDurations([4, 6, 8]);
    render(<VideoDurationControl />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '8' } });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({ durationSeconds: 8 });
  });

  it('writes a dragged duration on an axis no selected model constrains', () => {
    // Nothing declares a duration domain, so the slider runs its presentation
    // range and offers no option to grade: a verdict that grades the axis
    // elsewhere must not freeze a control the send gate does not refuse.
    mockModels({ models: [] });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
    });
    render(<VideoDurationControl dimensions={videoVerdict([4, 6])} />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '8' } });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({ durationSeconds: 8 });
  });
});

describe('a send refused because no funding figure was read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const FUNDING_NOTICE = noticeText('send_check_unavailable');

  /**
   * One video model declaring ALL THREE axes, so each control below renders
   * against the same catalog row rather than one shaped for its own axis: a
   * replacement proven on a fixture only that axis has is proven of nothing.
   */
  function selectVideoModelDeclaringEveryAxis(): void {
    mockModels({
      models: [
        {
          id: 'fictional/video',
          name: 'Video',
          provider: 'Fictional',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
            dearestPerSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
          },
          supportedAspectRatios: ['16:9', '9:16'],
          supportedVideoResolutions: ['720p', '1080p'],
          supportedVideoDurationsSeconds: [4, 6, 8],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'fictional/video', name: 'Video' }],
      },
    });
  }

  /**
   * A produced verdict grading every option of every axis affordable. It is the
   * fixture the funding cases carry so that an implementation keyed on the
   * ABSENCE of a verdict — which is what the failed read and the read still in
   * flight look alike as — cannot answer these tests correctly.
   */
  function everyOptionAffordable(): readonly MediaDimensionAvailability[] {
    const available = { available: true } as const;
    return [
      {
        dimensionId: 'aspectRatio',
        options: [
          { optionId: '16:9', label: '16:9', availability: available },
          { optionId: '9:16', label: '9:16', availability: available },
        ],
      },
      {
        dimensionId: 'resolution',
        options: [
          { optionId: '720p', label: '720p', availability: available },
          { optionId: '1080p', label: '1080p', availability: available },
        ],
      },
      {
        dimensionId: 'durationSeconds',
        options: [
          { optionId: '4', label: '4s', availability: available },
          { optionId: '6', label: '6s', availability: available },
          { optionId: '8', label: '8s', availability: available },
        ],
      },
    ];
  }

  it('takes down the image aspect ratio pills and says nothing itself', () => {
    selectImageModelOffering(IMAGE_RATIOS);
    render(<ImageAspectRatioControl sendRefusal="send_check_unavailable" />);
    expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
    expect(screen.queryByText(FUNDING_NOTICE)).not.toBeInTheDocument();
  });

  it('takes down the video aspect ratio pills and says nothing itself', () => {
    selectVideoModelDeclaringEveryAxis();
    render(<VideoAspectRatioControl sendRefusal="send_check_unavailable" />);
    expect(screen.queryByRole('button', { name: '16:9' })).not.toBeInTheDocument();
    expect(screen.queryByText(FUNDING_NOTICE)).not.toBeInTheDocument();
  });

  it('takes down the resolution pills and says nothing itself', () => {
    selectVideoModelDeclaringEveryAxis();
    render(<VideoResolutionControl sendRefusal="send_check_unavailable" />);
    expect(screen.queryByRole('button', { name: '720p' })).not.toBeInTheDocument();
    expect(screen.queryByText(FUNDING_NOTICE)).not.toBeInTheDocument();
  });

  it('takes down the duration slider and says nothing itself', () => {
    selectVideoModelDeclaringEveryAxis();
    render(<VideoDurationControl sendRefusal="send_check_unavailable" />);
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByText(FUNDING_NOTICE)).not.toBeInTheDocument();
  });

  it('takes down the duration slider even while a produced verdict is on screen', () => {
    selectVideoModelDeclaringEveryAxis();
    render(
      <VideoDurationControl
        sendRefusal="send_check_unavailable"
        dimensions={everyOptionAffordable()}
      />
    );
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('takes down the resolution pills even while a produced verdict is on screen', () => {
    selectVideoModelDeclaringEveryAxis();
    render(
      <VideoResolutionControl
        sendRefusal="send_check_unavailable"
        dimensions={everyOptionAffordable()}
      />
    );
    expect(screen.queryByRole('button', { name: '720p' })).not.toBeInTheDocument();
  });

  it('says the sentence once, in one live region, where the sheet mounts it', () => {
    render(<MediaFundingNotice sendRefusal="send_check_unavailable" />);
    const spoken = screen.getAllByRole('status');
    expect(spoken).toHaveLength(1);
    expect(spoken[0]).toHaveTextContent(FUNDING_NOTICE);
  });

  it('says nothing while the funding read is in flight', () => {
    render(<MediaFundingNotice />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('says nothing for a refusal the options themselves carry', () => {
    render(<MediaFundingNotice sendRefusal="insufficient_funds" />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('leaves the image aspect ratio pills in place while the funding read is in flight', () => {
    selectImageModelOffering(IMAGE_RATIOS);
    render(<ImageAspectRatioControl />);
    expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
    expect(screen.queryByText(FUNDING_NOTICE)).not.toBeInTheDocument();
  });

  it('leaves the duration slider in place while the funding read is in flight', () => {
    selectVideoModelDeclaringEveryAxis();
    render(<VideoDurationControl />);
    expect(screen.getByRole('slider')).toBeInTheDocument();
    expect(screen.queryByText(FUNDING_NOTICE)).not.toBeInTheDocument();
  });

  it('leaves the resolution pills in place when the refusal is one the options carry', () => {
    selectVideoModelDeclaringEveryAxis();
    render(
      <VideoResolutionControl
        sendRefusal="insufficient_funds"
        dimensions={everyOptionAffordable()}
      />
    );
    expect(screen.getByRole('button', { name: '720p' })).toBeInTheDocument();
    expect(screen.queryByText(FUNDING_NOTICE)).not.toBeInTheDocument();
  });

  it('names the model conflict rather than the funding read when both hold', () => {
    mockModels({
      models: [
        {
          id: 'fictional/video-a',
          name: 'Video A',
          provider: 'Fictional',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '40000000' },
            dearestPerSecondByResolution: { '720p': '40000000' },
          },
          supportedAspectRatios: ['16:9'],
        },
        {
          id: 'fictional/video-b',
          name: 'Video B',
          provider: 'Fictional',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '40000000' },
            dearestPerSecondByResolution: { '720p': '40000000' },
          },
          supportedAspectRatios: ['9:16'],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [
          { id: 'fictional/video-a', name: 'Video A' },
          { id: 'fictional/video-b', name: 'Video B' },
        ],
      },
    });
    render(<VideoAspectRatioControl sendRefusal="send_check_unavailable" />);
    expect(screen.getByText(/share no common aspect ratio/i)).toBeInTheDocument();
    expect(screen.queryByText(FUNDING_NOTICE)).not.toBeInTheDocument();
  });
});

describe('a control the caller lays out as a titled section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** A model declaring the two axes the sheet gives a heading of their own. */
  function selectVideoModelDeclaringResolutionAndDuration(): void {
    mockModels({
      models: [
        {
          id: 'fictional/video',
          name: 'Video',
          provider: 'Fictional',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
            dearestPerSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
          },
          supportedVideoResolutions: ['720p', '1080p'],
          supportedVideoDurationsSeconds: [4, 6, 8],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'fictional/video', name: 'Video' }],
      },
    });
  }

  it('heads its options with the title the caller gave it', () => {
    selectVideoModelDeclaringResolutionAndDuration();
    render(<VideoResolutionControl heading="Resolution" />);
    expect(screen.getByRole('heading', { name: 'Resolution' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '720p' })).toBeInTheDocument();
  });

  it('takes its heading down with itself when no funding figure was read', () => {
    selectVideoModelDeclaringResolutionAndDuration();
    render(<VideoResolutionControl heading="Resolution" sendRefusal="send_check_unavailable" />);
    expect(screen.queryByRole('heading', { name: 'Resolution' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '720p' })).not.toBeInTheDocument();
  });

  it('renders no heading where the caller lays the axis out without one', () => {
    selectVideoModelDeclaringResolutionAndDuration();
    render(<VideoResolutionControl />);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '720p' })).toBeInTheDocument();
  });

  it('keeps its heading above the axis conflict that replaces its options', () => {
    mockModels({
      models: [
        {
          id: 'fictional/video-a',
          name: 'Video A',
          provider: 'Fictional',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '720p': '40000000' },
            dearestPerSecondByResolution: { '720p': '40000000' },
          },
          supportedVideoResolutions: ['720p'],
        },
        {
          id: 'fictional/video-b',
          name: 'Video B',
          provider: 'Fictional',
          description: 'Video generation model.',
          modality: 'video',
          contextLength: 0,
          supportedParameters: [],
          pricing: {
            perSecondByResolution: { '1080p': '80000000' },
            dearestPerSecondByResolution: { '1080p': '80000000' },
          },
          supportedVideoResolutions: ['1080p'],
        },
      ],
    });
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [
          { id: 'fictional/video-a', name: 'Video A' },
          { id: 'fictional/video-b', name: 'Video B' },
        ],
      },
    });
    render(<VideoResolutionControl heading="Resolution" />);
    expect(screen.getByRole('heading', { name: 'Resolution' })).toBeInTheDocument();
    expect(screen.getByText(/share no common resolution/i)).toBeInTheDocument();
  });

  it('says "Duration" once when it heads its own section', () => {
    selectVideoModelDeclaringResolutionAndDuration();
    render(<VideoDurationControl heading="Duration" />);
    expect(screen.getAllByText(/^Duration$/)).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Duration' })).toBeInTheDocument();
  });

  it('keeps its inline duration label where the caller heads nothing', () => {
    selectVideoModelDeclaringResolutionAndDuration();
    render(<VideoDurationControl />);
    expect(screen.getByText(/^Duration$/)).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
