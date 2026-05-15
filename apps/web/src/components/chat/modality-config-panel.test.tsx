import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import {
  ImageAspectRatioControl,
  VideoAspectRatioControl,
  VideoResolutionControl,
  VideoDurationControl,
  AudioFormatControl,
  AudioDurationControl,
  MediaCostLine,
} from './modality-config-panel';

// Mock useModels so panels can look up pricing without a QueryClient.
// Tests that care about pricing override the return value inline.
// The `mockUseModels` ref has to be declared via `vi.hoisted` so it's available
// inside the vi.mock factory (which runs before top-level declarations).
const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(() => ({ data: { models: [], premiumIds: new Set<string>() } })),
}));
vi.mock('@/hooks/models', () => ({
  useModels: mockUseModels,
}));

interface MockModelsPayload {
  models: {
    id: string;
    modality: 'text' | 'image' | 'video' | 'audio';
    pricePerImage?: number;
    pricePerSecond?: number;
    pricePerSecondByResolution?: Record<string, number>;
  }[];
}

function mockModels(payload: MockModelsPayload): void {
  mockUseModels.mockReturnValue({
    data: {
      models: payload.models as never,
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

describe('ImageAspectRatioControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
  });

  it('renders aspect ratio picker with all supported ratios', () => {
    render(<ImageAspectRatioControl />);
    expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '4:3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3:4' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
  });

  it('marks the active aspect ratio with aria-pressed=true', () => {
    resetModelStoreStub({ activeModality: 'image', imageConfig: { aspectRatio: '16:9' } });
    render(<ImageAspectRatioControl />);
    expect(screen.getByRole('button', { name: '16:9' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '1:1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls setImageConfig when an aspect ratio is clicked', () => {
    render(<ImageAspectRatioControl />);
    fireEvent.click(screen.getByRole('button', { name: '16:9' }));
    expect(modelStoreStubRef.current.setImageConfig).toHaveBeenCalledWith({
      aspectRatio: '16:9',
    });
  });

  it('exposes the aspect ratio group with a screen-reader-only legend', () => {
    render(<ImageAspectRatioControl />);
    expect(screen.getByText(/aspect ratio/i)).toBeInTheDocument();
  });

  it('renders all pills at a uniform fixed width', () => {
    render(<ImageAspectRatioControl />);
    for (const ratio of ['1:1', '4:3', '3:4', '16:9', '9:16']) {
      expect(screen.getByRole('button', { name: ratio }).className).toContain('w-28');
    }
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

  it('renders the two Veo-supported ratios', () => {
    render(<VideoAspectRatioControl />);
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
  });

  it('does not render 1:1 or 4:3 (Veo does not support these)', () => {
    render(<VideoAspectRatioControl />);
    expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '4:3' })).not.toBeInTheDocument();
  });

  it('marks the active aspect ratio with aria-pressed=true', () => {
    resetModelStoreStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' },
    });
    render(<VideoAspectRatioControl />);
    expect(screen.getByRole('button', { name: '9:16' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('writes setVideoConfig when aspect ratio changes', () => {
    render(<VideoAspectRatioControl />);
    fireEvent.click(screen.getByRole('button', { name: '9:16' }));
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      aspectRatio: '9:16',
    });
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

  it('labels resolution buttons with per-second prices when the primary model is priced', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.1, '1080p': 0.15 },
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
    expect(screen.getByRole('button', { name: /720p \$0.10\/s/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1080p \$0.15\/s/ })).toBeInTheDocument();
  });

  it('omits resolutions not priced by the primary model', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          modality: 'video',
          pricePerSecondByResolution: { '1080p': 0.15 },
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
          modality: 'video',
          pricePerSecondByResolution: { '720p': 0.1, '1080p': 0.15 },
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
    fireEvent.click(screen.getByRole('button', { name: /1080p\s+\$0\.15\/s/ }));
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      resolution: '1080p',
    });
  });

  it('falls back to the first supported resolution when the current one is unsupported', () => {
    mockModels({
      models: [
        {
          id: 'google/veo-3.1',
          modality: 'video',
          pricePerSecondByResolution: { '1080p': 0.15 },
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
    expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
      resolution: '1080p',
    });
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

  it('renders the slider with min=1, max=8, current=4', () => {
    render(<VideoDurationControl />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '8');
    expect(slider).toHaveValue('4');
  });

  it('writes setVideoConfig when duration changes', () => {
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
        models: [{ id: 'google/imagen-4', modality: 'image', pricePerImage: 0.04 }],
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
            modality: 'video',
            pricePerSecondByResolution: { '720p': 0.1, '1080p': 0.15 },
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
    it('displays an estimated cost for the current config', () => {
      mockUseModels.mockReturnValue({
        data: {
          models: [
            { id: 'openai/tts-1', modality: 'audio', pricePerSecond: 0.015 } as never,
          ] as never,
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
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });
  });
});

describe('AudioFormatControl when FEATURE_FLAGS.AUDIO_ENABLED is on', () => {
  // Save/restore pattern — afterEach runs even when beforeEach throws,
  // so the flag can't leak across tests in this file.
  let originalAudioEnabled: boolean;

  beforeEach(async () => {
    const { FEATURE_FLAGS } = await import('@hushbox/shared');
    originalAudioEnabled = FEATURE_FLAGS.AUDIO_ENABLED;
    FEATURE_FLAGS.AUDIO_ENABLED = true;
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
  });

  afterEach(async () => {
    const { FEATURE_FLAGS } = await import('@hushbox/shared');
    FEATURE_FLAGS.AUDIO_ENABLED = originalAudioEnabled;
  });

  it('renders the format picker independent of the flag (parent handles flag gating)', () => {
    render(<AudioFormatControl />);
    expect(screen.getByRole('button', { name: 'mp3' })).toBeInTheDocument();
  });
});
