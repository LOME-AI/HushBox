import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { noticeText, TEST_IDS } from '@hushbox/shared';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';

const { mockUseIsMobile, mockUseModels } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(),
  mockUseModels: vi.fn(
    (): UseModelsStub => ({
      data: { models: [], premiumIds: new Set<string>() },
    })
  ),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: mockUseIsMobile,
  };
});

vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

// Lighten the budget hook: the real one pulls in TanStack Query.
vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: () => ({
    hasContent: false,
    isOverCapacity: false,
    hasBlockingError: false,
    capacityCurrentUsage: 0,
    capacityMaxCapacity: 0,
    fundingSource: 'free',
    notifications: [],
  }),
}));

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };
function resetStub(overrides: Partial<ModelStoreStub> = {}): void {
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

import {
  drawsTextRow,
  ImageBottomRow,
  TextBottomRow,
  VideoBottomRow,
} from '@/components/chat/input/bottom-rows';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';
import type { MediaDimensionAvailability } from '@hushbox/shared';

const TOOLBAR = <div data-testid="test-toolbar">toolbar</div>;
const SEND = <button data-testid="test-send">send</button>;

describe('TextBottomRow', () => {
  it('draws no context meter, which the composer seats on its top edge', () => {
    const { container } = render(<TextBottomRow toolbar={TOOLBAR} sendButton={SEND} />);

    expect(screen.queryByTestId(TEST_IDS.capacityBar)).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="meter"]')).toBeNull();
  });

  it('keeps the toolbar and send button at the right edge', () => {
    render(<TextBottomRow toolbar={TOOLBAR} sendButton={SEND} />);

    const row = screen.getByTestId('test-toolbar').parentElement;
    expect(row).toHaveClass('justify-end');
    expect(row).toContainElement(screen.getByTestId('test-send'));
  });

  it('takes no room when it is handed nothing to hold', () => {
    const { container } = render(<TextBottomRow toolbar={null} sendButton={null} />);

    const row = container.firstElementChild;
    expect(row).toBeEmptyDOMElement();
    expect(row).toHaveClass('empty:hidden');
  });
});

describe('drawsTextRow', () => {
  it.each([undefined, 'text'] as const)('draws the text row for %s', (modality) => {
    expect(drawsTextRow(modality, true)).toBe(true);
  });

  it('draws the text row for audio when audio is not offered', () => {
    expect(drawsTextRow('audio', false)).toBe(true);
  });

  it('draws the audio row, not the text row, when audio is offered', () => {
    expect(drawsTextRow('audio', true)).toBe(false);
  });

  it.each(['image', 'video'] as const)('draws its own row for %s', (modality) => {
    expect(drawsTextRow(modality, false)).toBe(false);
  });
});

describe('ImageBottomRow', () => {
  // The offered ratios are the selected model's own catalog domain — the inline
  // pills render nothing until a model is selected, so the row is set up the way
  // production reaches it rather than relying on a global default list.
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseModels.mockReturnValue({
      data: {
        models: [
          {
            id: 'fictional/image',
            name: 'Image',
            provider: 'Fictional',
            description: 'Image generation model.',
            modality: 'image',
            contextLength: 0,
            supportedParameters: [],
            supportedAspectRatios: ['1:1', '16:9'],
            pricing: { perImage: '40000000', dearestPerImage: '40000000' },
          },
        ],
        premiumIds: new Set<string>(),
      },
    });
    resetStub({
      activeModality: 'image',
      imageConfig: { aspectRatio: '1:1' },
      selections: {
        text: [],
        image: [{ id: 'fictional/image', name: 'Image' }],
        audio: [],
        video: [],
      },
    });
  });

  it('draws no ratio control, which the composer bar carries as its ratio chip', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Aspect ratio' })).not.toBeInTheDocument();
  });

  it('draws the same row on a phone, with no summary chip', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.queryByRole('button', { name: /image settings/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '1:1' })).not.toBeInTheDocument();
  });

  it('shows the image estimate', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByText(/^≈ \$0\.\d{3}$/u)).toBeInTheDocument();
    expect(screen.getByText('(estimate)')).toBeInTheDocument();
  });

  it('takes no room when it has no estimate and is handed nothing to hold', () => {
    resetStub({ activeModality: 'image', imageConfig: { aspectRatio: '1:1' } });
    const { container } = render(<ImageBottomRow toolbar={null} sendButton={null} />);
    const row = container.firstElementChild;
    expect(row).toBeEmptyDOMElement();
    expect(row).toHaveClass('empty:hidden');
  });

  it('renders the toolbar and send button on both desktop and mobile', () => {
    mockUseIsMobile.mockReturnValue(false);
    const { unmount } = render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByTestId('test-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('test-send')).toBeInTheDocument();
    unmount();

    mockUseIsMobile.mockReturnValue(true);
    render(<ImageBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByTestId('test-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('test-send')).toBeInTheDocument();
  });
});

describe('VideoBottomRow', () => {
  // Ratios, resolutions and durations all come from the selected model's catalog
  // row (see {@link ImageBottomRow}'s note).
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseModels.mockReturnValue({
      data: {
        models: [
          {
            id: 'fictional/video',
            name: 'Video',
            provider: 'Fictional',
            description: 'Video generation model.',
            modality: 'video',
            contextLength: 0,
            supportedParameters: [],
            supportedAspectRatios: ['16:9', '9:16'],
            supportedVideoResolutions: ['720p', '1080p'],
            supportedVideoDurationsSeconds: [4, 6, 8],
            pricing: { perSecondByResolution: { '720p': '100000000', '1080p': '150000000' } },
          },
        ],
        premiumIds: new Set<string>(),
      },
    });
    resetStub({
      activeModality: 'video',
      videoConfig: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' },
      selections: {
        text: [],
        image: [],
        audio: [],
        video: [{ id: 'fictional/video', name: 'Video' }],
      },
    });
  });

  it('on desktop renders the duration slider, aspect-ratio pills, and resolution chips', () => {
    mockUseIsMobile.mockReturnValue(false);
    render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByRole('slider')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '16:9' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '9:16' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /720p/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1080p/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /video settings/i })).not.toBeInTheDocument();
  });

  it('on mobile renders the summary chip, hiding the inline controls', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByRole('button', { name: /video settings/i })).toBeInTheDocument();
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('on mobile opens the bottom sheet when the chip is tapped', () => {
    mockUseIsMobile.mockReturnValue(true);
    render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /video settings/i }));
    expect(screen.getByRole('dialog', { name: /video generation settings/i })).toBeInTheDocument();
  });

  it('on desktop hands the duration slider the turn verdict', () => {
    // The duration axis sits LAST behind a resolution row that grades nothing
    // about duration, so a row read positionally or by a sibling's id answers
    // for an axis it knows nothing about.
    const mediaDimensions: readonly MediaDimensionAvailability[] = [
      {
        dimensionId: 'resolution',
        options: [{ optionId: '720p', label: '720p', availability: { available: true } }],
      },
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
    ];
    mockUseIsMobile.mockReturnValue(false);
    render(
      <VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} mediaDimensions={mediaDimensions} />
    );
    expect(screen.getByRole('button', { name: 'Set duration to 8 seconds' })).toHaveAttribute(
      'aria-disabled',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Set duration to 6 seconds' })).not.toHaveAttribute(
      'aria-disabled'
    );
  });

  it('renders the toolbar and send button on both desktop and mobile', () => {
    mockUseIsMobile.mockReturnValue(false);
    const { unmount } = render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByTestId('test-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('test-send')).toBeInTheDocument();
    unmount();

    mockUseIsMobile.mockReturnValue(true);
    render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByTestId('test-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('test-send')).toBeInTheDocument();
  });
});

/**
 * The refusal reaches every axis control on BOTH layouts. The desktop row and
 * the mobile sheet mount the same controls by different routes, so a value
 * threaded down one of them is threaded down neither until both are pinned.
 */
describe('the composer handing its send refusal to the generation controls', () => {
  const FUNDING_NOTICE = noticeText('send_check_unavailable');

  /**
   * What a screen reader would announce from what this file renders: the live
   * regions carrying the funding sentence. These renders mount a row WITHOUT the
   * composer's notice list, which is the state that separates the two owners —
   * a desktop row announces nothing of its own, while the mobile sheet, which
   * the list cannot reach, still says it once for all of its axes.
   */
  function spokenFundingNotices(): readonly HTMLElement[] {
    return screen
      .queryAllByRole('status')
      .filter((region) => region.textContent === FUNDING_NOTICE);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseModels.mockReturnValue({
      data: {
        models: [
          {
            id: 'fictional/video',
            name: 'Video',
            provider: 'Fictional',
            description: 'Video generation model.',
            modality: 'video',
            contextLength: 0,
            supportedParameters: [],
            supportedAspectRatios: ['16:9', '9:16'],
            supportedVideoResolutions: ['720p', '1080p'],
            supportedVideoDurationsSeconds: [4, 6],
            pricing: { perSecondByResolution: { '720p': '40000000', '1080p': '80000000' } },
          },
          {
            id: 'fictional/image',
            name: 'Image',
            provider: 'Fictional',
            description: 'Image generation model.',
            modality: 'image',
            contextLength: 0,
            supportedParameters: [],
            supportedAspectRatios: ['1:1', '16:9'],
            pricing: { perImage: '40000000' },
          },
        ],
        premiumIds: new Set<string>(),
      },
    });
  });

  function selectVideo(): void {
    resetStub({
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

  /** Two video models sharing every axis but duration, where they share nothing. */
  function selectVideoModelsDisagreeingOnDuration(): void {
    mockUseModels.mockReturnValue({
      data: {
        models: [
          {
            id: 'fictional/video-a',
            name: 'Video A',
            provider: 'Fictional',
            description: 'Video generation model.',
            modality: 'video',
            contextLength: 0,
            supportedParameters: [],
            supportedAspectRatios: ['16:9'],
            supportedVideoResolutions: ['720p'],
            supportedVideoDurationsSeconds: [4],
            pricing: { perSecondByResolution: { '720p': '40000000' } },
          },
          {
            id: 'fictional/video-b',
            name: 'Video B',
            provider: 'Fictional',
            description: 'Video generation model.',
            modality: 'video',
            contextLength: 0,
            supportedParameters: [],
            supportedAspectRatios: ['16:9'],
            supportedVideoResolutions: ['720p'],
            supportedVideoDurationsSeconds: [6],
            pricing: { perSecondByResolution: { '720p': '40000000' } },
          },
        ],
        premiumIds: new Set<string>(),
      },
    });
    resetStub({
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

  /** A produced verdict grading every option of every video axis affordable. */
  function everyVideoOptionAffordable(): readonly MediaDimensionAvailability[] {
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
        ],
      },
    ];
  }

  it('takes every inline video control down without saying anything of its own', () => {
    selectVideo();
    mockUseIsMobile.mockReturnValue(false);
    render(
      <VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} sendRefusal="send_check_unavailable" />
    );
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '16:9' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /720p/i })).not.toBeInTheDocument();
    expect(spokenFundingNotices()).toHaveLength(0);
  });

  it('replaces the controls inside the mobile sheet with one sentence, said by the sheet', () => {
    selectVideo();
    mockUseIsMobile.mockReturnValue(true);
    render(
      <VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} sendRefusal="send_check_unavailable" />
    );
    fireEvent.click(screen.getByRole('button', { name: /video settings/i }));
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    const spoken = spokenFundingNotices();
    expect(spoken).toHaveLength(1);
    // WHICH surface said it. The composer's list is under the sheet's backdrop
    // here, so a count that found the sentence anywhere else would describe an
    // announcement nobody on this layout can read.
    expect(screen.getByRole('dialog')).toContainElement(spoken[0] ?? null);
  });

  it('stays silent on a video row whose every axis was graded before the read failed', () => {
    // A produced verdict is on screen and every option in it is affordable: an
    // implementation keyed on the ABSENCE of that verdict rather than on the
    // refusal leaves the controls up here.
    selectVideo();
    mockUseIsMobile.mockReturnValue(false);
    render(
      <VideoBottomRow
        toolbar={TOOLBAR}
        sendButton={SEND}
        mediaDimensions={everyVideoOptionAffordable()}
        sendRefusal="send_check_unavailable"
      />
    );
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    expect(spokenFundingNotices()).toHaveLength(0);
  });

  it('leaves an axis that names its own block saying it, and adds nothing beside it', () => {
    // The FIRST control in this row is the one axis holding a conflict, so it
    // speaks its own sentence. That block is what the user can act on, and the
    // funding refusal beside it must not displace it or double it.
    selectVideoModelsDisagreeingOnDuration();
    mockUseIsMobile.mockReturnValue(false);
    render(
      <VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} sendRefusal="send_check_unavailable" />
    );
    expect(screen.getByText(/share no common duration/i)).toBeInTheDocument();
    expect(spokenFundingNotices()).toHaveLength(0);
  });

  it('leaves the inline video controls in place while the funding read is in flight', () => {
    selectVideo();
    mockUseIsMobile.mockReturnValue(false);
    render(<VideoBottomRow toolbar={TOOLBAR} sendButton={SEND} />);
    expect(screen.getByRole('slider')).toBeInTheDocument();
    expect(screen.queryByText(FUNDING_NOTICE)).not.toBeInTheDocument();
  });
});
