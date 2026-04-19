import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { ModalityConfigPanel } from './modality-config-panel';

// Mock useModels so the panel can look up pricing without a QueryClient.
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

describe('ModalityConfigPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetModelStoreStub();
  });

  it('renders nothing for text modality', () => {
    resetModelStoreStub({ activeModality: 'text' });
    const { container } = render(<ModalityConfigPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for audio modality (flag-off)', () => {
    resetModelStoreStub({ activeModality: 'audio' });
    const { container } = render(<ModalityConfigPanel />);
    expect(container.firstChild).toBeNull();
  });

  describe('image modality', () => {
    beforeEach(() => {
      resetModelStoreStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
    });

    it('renders aspect ratio picker with all supported ratios', () => {
      render(<ModalityConfigPanel />);
      expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '3:2' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '4:3' })).toBeInTheDocument();
    });

    it('marks the active aspect ratio with aria-pressed=true', () => {
      resetModelStoreStub({ activeModality: 'image', imageConfig: { aspectRatio: '16:9' } });
      render(<ModalityConfigPanel />);
      expect(screen.getByRole('button', { name: '16:9' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: '1:1' })).toHaveAttribute('aria-pressed', 'false');
    });

    it('calls setImageConfig when an aspect ratio is clicked', () => {
      render(<ModalityConfigPanel />);
      fireEvent.click(screen.getByRole('button', { name: '16:9' }));
      expect(modelStoreStubRef.current.setImageConfig).toHaveBeenCalledWith({
        aspectRatio: '16:9',
      });
    });

    it('does not render duration slider or resolution picker', () => {
      render(<ModalityConfigPanel />);
      expect(screen.queryByRole('slider')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '720p' })).not.toBeInTheDocument();
    });
  });

  describe('video modality', () => {
    beforeEach(() => {
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      });
    });

    it('renders aspect ratio picker with video-supported ratios', () => {
      render(<ModalityConfigPanel />);
      expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '4:3' })).toBeInTheDocument();
    });

    it('does not render 3:2 aspect (video does not support it)', () => {
      render(<ModalityConfigPanel />);
      expect(screen.queryByRole('button', { name: '3:2' })).not.toBeInTheDocument();
    });

    it('shows an empty-state hint for resolution when no video model is selected', () => {
      render(<ModalityConfigPanel />);
      expect(
        screen.getByText(/Select a video model to see resolution options/i)
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /720p/i })).not.toBeInTheDocument();
    });

    it('renders duration slider with min=1, max=8, current=4', () => {
      render(<ModalityConfigPanel />);
      const slider = screen.getByRole('slider');
      expect(slider).toHaveAttribute('min', '1');
      expect(slider).toHaveAttribute('max', '8');
      expect(slider).toHaveValue('4');
    });

    it('writes setVideoConfig when aspect ratio changes', () => {
      render(<ModalityConfigPanel />);
      fireEvent.click(screen.getByRole('button', { name: '9:16' }));
      expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
        aspectRatio: '9:16',
      });
    });

    it('writes setVideoConfig when resolution changes (with a selected video model)', () => {
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
          text: [{ id: 'text-model', name: 'Text' }],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
      render(<ModalityConfigPanel />);
      fireEvent.click(screen.getByRole('button', { name: /1080p\s+\$0\.15\/s/ }));
      expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
        resolution: '1080p',
      });
    });

    it('writes setVideoConfig when duration changes', () => {
      render(<ModalityConfigPanel />);
      const slider = screen.getByRole('slider');
      fireEvent.change(slider, { target: { value: '6' } });
      expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
        durationSeconds: 6,
      });
    });

    it('marks the active aspect ratio with aria-pressed=true', () => {
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' },
      });
      render(<ModalityConfigPanel />);
      expect(screen.getByRole('button', { name: '9:16' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('displays the current duration next to the slider', () => {
      render(<ModalityConfigPanel />);
      expect(screen.getByText(/4s/i)).toBeInTheDocument();
    });
  });

  describe('video pricing UI', () => {
    beforeEach(() => {
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
        selections: {
          text: [{ id: 'text-model', name: 'Text' }],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
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
      render(<ModalityConfigPanel />);
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
      render(<ModalityConfigPanel />);
      expect(screen.queryByRole('button', { name: /720p/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /1080p/ })).toBeInTheDocument();
    });

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
      render(<ModalityConfigPanel />);
      // 4s × $0.10/s × 1.15 fee + storage ≈ $0.56 order of magnitude, just assert presence
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });

    it('falls back to the first supported resolution when the current one is unsupported', () => {
      resetModelStoreStub({
        activeModality: 'video',
        videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
        selections: {
          text: [{ id: 'text-model', name: 'Text' }],
          image: [],
          audio: [],
          video: [{ id: 'google/veo-3.1', name: 'Veo 3.1' }],
        },
      });
      mockModels({
        models: [
          {
            id: 'google/veo-3.1',
            modality: 'video',
            pricePerSecondByResolution: { '1080p': 0.15 },
          },
        ],
      });
      render(<ModalityConfigPanel />);
      expect(modelStoreStubRef.current.setVideoConfig).toHaveBeenCalledWith({
        resolution: '1080p',
      });
    });
  });

  describe('image pricing UI', () => {
    beforeEach(() => {
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: {
          text: [{ id: 'text-model', name: 'Text' }],
          image: [{ id: 'google/imagen-4', name: 'Imagen 4' }],
          audio: [],
          video: [],
        },
      });
    });

    it('displays estimated cost for the primary selected image model', () => {
      mockModels({
        models: [{ id: 'google/imagen-4', modality: 'image', pricePerImage: 0.04 }],
      });
      render(<ModalityConfigPanel />);
      expect(screen.getByText(/^≈ \$\d+\.\d+/)).toBeInTheDocument();
    });

    it('shows no cost line when no image model is selected', () => {
      mockModels({
        models: [],
      });
      resetModelStoreStub({
        activeModality: 'image',
        imageConfig: { aspectRatio: '1:1' },
        selections: { text: [], image: [], audio: [], video: [] },
      });
      render(<ModalityConfigPanel />);
      expect(screen.queryByText(/^≈ \$/)).not.toBeInTheDocument();
    });
  });
});
