import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { useMediaAxisSnap, videoResolutionAgreement } from '@/hooks/media/use-media-axis-snap';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';
import type { Model } from '@hushbox/shared';

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

function mockModels(models: readonly Model[]): void {
  mockUseModels.mockReturnValue({
    data: { models: [...models], premiumIds: new Set<string>() },
  });
}

function resetModelStoreStub(overrides: Partial<ModelStoreStub> = {}): void {
  modelStoreStubRef.current = createModelStoreStub(overrides);
}

/** One image row declaring `ratios`, selected, with `activeRatio` stored. */
function selectImageModel(ratios: readonly string[], activeRatio: string): void {
  mockModels([
    {
      id: 'fictional/image',
      modality: 'image',
      name: 'Image',
      provider: 'Fictional',
      description: 'Image generation model.',
      contextLength: 0,
      supportedParameters: [],
      pricing: { perImage: '40000000', dearestPerImage: '40000000' },
      supportedAspectRatios: [...ratios],
    },
  ]);
  // The composer sits in TEXT: the snap must not depend on the media surface
  // being the one on screen.
  resetModelStoreStub({
    activeModality: 'text',
    imageConfig: { aspectRatio: activeRatio },
    selections: {
      text: [],
      image: [{ id: 'fictional/image', name: 'Image' }],
      audio: [],
      video: [],
    },
  });
}

interface VideoRowOptions {
  readonly ratios?: readonly string[];
  readonly resolutions?: readonly string[];
  readonly durations?: readonly number[];
}

/** One video row, selected, with `stored` config held in the store. */
function selectVideoModel(
  row: VideoRowOptions,
  stored: { aspectRatio: string; resolution: string; durationSeconds: number }
): void {
  mockModels([
    {
      id: 'fictional/video',
      modality: 'video',
      name: 'Video',
      provider: 'Fictional',
      description: 'Video generation model.',
      contextLength: 0,
      supportedParameters: [],
      pricing: {
        perSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
        dearestPerSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
      },
      supportedAspectRatios: row.ratios === undefined ? undefined : [...row.ratios],
      supportedVideoResolutions: row.resolutions === undefined ? undefined : [...row.resolutions],
      supportedVideoDurationsSeconds: row.durations === undefined ? undefined : [...row.durations],
    },
  ]);
  resetModelStoreStub({
    activeModality: 'text',
    videoConfig: stored,
    selections: {
      text: [],
      image: [],
      audio: [],
      video: [{ id: 'fictional/video', name: 'Video' }],
    },
  });
}

describe('useMediaAxisSnap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockModels([]);
    resetModelStoreStub();
  });

  it('snaps a stored image aspect ratio the selected model does not offer', () => {
    selectImageModel(['16:9', '9:16'], '1:1');
    renderHook(() => {
      useMediaAxisSnap();
    });
    expect(modelStoreStubRef.current.setImageConfig).toHaveBeenCalledWith({ aspectRatio: '16:9' });
  });

  it('leaves an offered image aspect ratio alone', () => {
    selectImageModel(['1:1', '16:9'], '16:9');
    renderHook(() => {
      useMediaAxisSnap();
    });
    expect(modelStoreStubRef.current.setImageConfig).not.toHaveBeenCalled();
  });

  it('snaps a stored video aspect ratio the selected model does not offer', () => {
    selectVideoModel(
      { ratios: ['1:1', '4:3'] },
      { aspectRatio: '16:9', resolution: '720p', durationSeconds: 4 }
    );
    renderHook(() => {
      useMediaAxisSnap();
    });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({ aspectRatio: '1:1' });
  });

  it('snaps a stored resolution the selected model does not price', () => {
    selectVideoModel(
      { resolutions: ['1080p'] },
      { aspectRatio: '16:9', resolution: '720p', durationSeconds: 4 }
    );
    renderHook(() => {
      useMediaAxisSnap();
    });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({ resolution: '1080p' });
  });

  it('snaps a stored duration to the nearest offered one', () => {
    selectVideoModel(
      { durations: [4, 6, 8] },
      { aspectRatio: '16:9', resolution: '720p', durationSeconds: 5 }
    );
    renderHook(() => {
      useMediaAxisSnap();
    });
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({ durationSeconds: 4 });
  });

  it('leaves an offered duration alone', () => {
    selectVideoModel(
      { durations: [4, 6, 8] },
      { aspectRatio: '16:9', resolution: '720p', durationSeconds: 6 }
    );
    renderHook(() => {
      useMediaAxisSnap();
    });
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });

  it('writes nothing on an axis whose selected models agree on nothing', () => {
    mockModels([
      {
        id: 'fictional/video-a',
        modality: 'video',
        name: 'Video A',
        provider: 'Fictional',
        description: 'Video generation model.',
        contextLength: 0,
        supportedParameters: [],
        pricing: {
          perSecondByResolution: { '720p': '40000000' },
          dearestPerSecondByResolution: { '720p': '40000000' },
        },
        supportedVideoDurationsSeconds: [8, 4, 6],
      },
      {
        id: 'fictional/video-b',
        modality: 'video',
        name: 'Video B',
        provider: 'Fictional',
        description: 'Video generation model.',
        contextLength: 0,
        supportedParameters: [],
        pricing: {
          perSecondByResolution: { '720p': '40000000' },
          dearestPerSecondByResolution: { '720p': '40000000' },
        },
        supportedVideoDurationsSeconds: [5, 10],
      },
    ]);
    resetModelStoreStub({
      activeModality: 'text',
      videoConfig: { aspectRatio: '16:9', resolution: '720p', durationSeconds: 4 },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [
          { id: 'fictional/video-a', name: 'A' },
          { id: 'fictional/video-b', name: 'B' },
        ],
      },
    });
    renderHook(() => {
      useMediaAxisSnap();
    });
    expect(modelStoreStubRef.current.setVideoConfig).not.toHaveBeenCalled();
  });

  it('writes nothing while the catalog is still loading', () => {
    mockUseModels.mockReturnValue({ data: undefined });
    resetModelStoreStub({
      activeModality: 'text',
      imageConfig: { aspectRatio: '1:1' },
      selections: {
        text: [],
        image: [{ id: 'fictional/image', name: 'Image' }],
        audio: [],
        video: [],
      },
    });
    renderHook(() => {
      useMediaAxisSnap();
    });
    expect(modelStoreStubRef.current.setImageConfig).not.toHaveBeenCalled();
  });
});

describe('videoResolutionAgreement', () => {
  /** A video row that declares no resolution list, so its priced resolutions stand in. */
  function undeclaredVideoRow(pricing: Model['pricing']): Model {
    return {
      id: 'fictional/video',
      modality: 'video',
      name: 'Video',
      provider: 'Fictional',
      description: 'Video generation model.',
      contextLength: 0,
      supportedParameters: [],
      pricing,
    };
  }

  it('reads the resolutions a row prices when it declares none', () => {
    const row = undeclaredVideoRow({
      perSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
      dearestPerSecondByResolution: { '720p': '40000000', '1080p': '80000000' },
    });

    expect(videoResolutionAgreement([{ id: row.id }], [row])).toEqual({
      kind: 'agreed',
      options: ['720p', '1080p'],
    });
  });

  it('reads no resolution off a row whose price the catalog cannot parse', () => {
    const row = undeclaredVideoRow({ perSecondByResolution: { '720p': '40000000' } });

    expect(videoResolutionAgreement([{ id: row.id }], [row]).kind).not.toBe('agreed');
  });
});
