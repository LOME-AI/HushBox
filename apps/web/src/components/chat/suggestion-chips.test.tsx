import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  textSuggestions,
  imageSuggestions,
  videoSuggestions,
  audioSuggestions,
} from '@/lib/prompt-suggestions';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { SuggestionChips } from './suggestion-chips';

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

const reducedMotionRef = { current: false };

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useReducedMotion: () => reducedMotionRef.current,
  };
});

describe('SuggestionChips', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    modelStoreStubRef.current = createModelStoreStub();
    reducedMotionRef.current = false;
  });

  it('renders suggestion chips container', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    expect(screen.getByTestId('suggestion-chips')).toBeInTheDocument();
  });

  it('renders all suggestion chips by default', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    for (const suggestion of textSuggestions) {
      expect(screen.getByText(suggestion.label)).toBeInTheDocument();
    }
  });

  it('calls onSelect with a prompt from the category when a chip is clicked', async () => {
    const user = userEvent.setup();
    render(<SuggestionChips onSelect={mockOnSelect} />);

    const firstSuggestion = textSuggestions[0];
    if (!firstSuggestion) throw new Error('No suggestions available');
    const firstChip = screen.getByText(firstSuggestion.label);
    await user.click(firstChip);

    expect(mockOnSelect).toHaveBeenCalled();
    const calledPrompt = mockOnSelect.mock.calls[0]?.[0] as string;
    expect(firstSuggestion.prompts).toContain(calledPrompt);
  });

  it('renders chips with icons', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    const chips = screen.getAllByRole('button');
    expect(chips.length).toBeGreaterThanOrEqual(textSuggestions.length);
  });

  it('chips have chip styling (rounded, interactive)', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    const firstSuggestion = textSuggestions[0];
    if (!firstSuggestion) throw new Error('No suggestions available');
    const chip = screen.getByText(firstSuggestion.label).closest('button');
    expect(chip).toBeInTheDocument();
  });

  it('renders "Surprise Me" button', () => {
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);
    expect(screen.getByRole('button', { name: /surprise me/i })).toBeInTheDocument();
  });

  it('"Surprise Me" button calls onSelect with a random prompt from any category', async () => {
    const user = userEvent.setup();
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

    const surpriseButton = screen.getByRole('button', { name: /surprise me/i });
    await user.click(surpriseButton);

    expect(mockOnSelect).toHaveBeenCalled();
    const firstCall = mockOnSelect.mock.calls[0];
    if (!firstCall) throw new Error('No call recorded');
    const calledPrompt = firstCall[0] as string;
    const allValidPrompts = textSuggestions.flatMap((s) => s.prompts);
    expect(allValidPrompts).toContain(calledPrompt);
  });

  it('does not render "Surprise Me" when showSurpriseMe is false', () => {
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe={false} />);
    expect(screen.queryByRole('button', { name: /surprise me/i })).not.toBeInTheDocument();
  });

  it('renders with custom className', () => {
    render(<SuggestionChips onSelect={mockOnSelect} className="custom-class" />);
    expect(screen.getByTestId('suggestion-chips')).toHaveClass('custom-class');
  });

  describe('modality-aware chips', () => {
    it('renders 4 category chips in text modality', () => {
      modelStoreStubRef.current.activeModality = 'text';
      render(<SuggestionChips onSelect={mockOnSelect} />);
      for (const suggestion of textSuggestions) {
        expect(screen.getByText(suggestion.label)).toBeInTheDocument();
      }
    });

    it('renders single Image ideas chip in image modality', () => {
      modelStoreStubRef.current.activeModality = 'image';
      render(<SuggestionChips onSelect={mockOnSelect} />);

      expect(screen.getByText('Image ideas')).toBeInTheDocument();
      for (const suggestion of textSuggestions) {
        expect(screen.queryByText(suggestion.label)).not.toBeInTheDocument();
      }
    });

    it('renders single Video ideas chip in video modality', () => {
      modelStoreStubRef.current.activeModality = 'video';
      render(<SuggestionChips onSelect={mockOnSelect} />);

      expect(screen.getByText('Video ideas')).toBeInTheDocument();
    });

    it('renders single Audio ideas chip in audio modality', () => {
      modelStoreStubRef.current.activeModality = 'audio';
      render(<SuggestionChips onSelect={mockOnSelect} />);

      expect(screen.getByText('Audio ideas')).toBeInTheDocument();
    });

    it('clicking the image chip selects a prompt from the imageSuggestions pool', async () => {
      const user = userEvent.setup();
      modelStoreStubRef.current.activeModality = 'image';
      render(<SuggestionChips onSelect={mockOnSelect} />);

      await user.click(screen.getByText('Image ideas'));

      expect(mockOnSelect).toHaveBeenCalled();
      const calledPrompt = mockOnSelect.mock.calls[0]?.[0] as string;
      const imagePool = imageSuggestions[0]?.prompts ?? [];
      expect(imagePool).toContain(calledPrompt);
    });

    it('Surprise Me in image modality selects from imageSuggestions pool', async () => {
      const user = userEvent.setup();
      modelStoreStubRef.current.activeModality = 'image';
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

      await user.click(screen.getByRole('button', { name: /surprise me/i }));

      expect(mockOnSelect).toHaveBeenCalled();
      const calledPrompt = mockOnSelect.mock.calls[0]?.[0] as string;
      const imagePool = imageSuggestions.flatMap((s) => s.prompts);
      expect(imagePool).toContain(calledPrompt);
    });

    it('Surprise Me in video modality selects from videoSuggestions pool', async () => {
      const user = userEvent.setup();
      modelStoreStubRef.current.activeModality = 'video';
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

      await user.click(screen.getByRole('button', { name: /surprise me/i }));

      expect(mockOnSelect).toHaveBeenCalled();
      const calledPrompt = mockOnSelect.mock.calls[0]?.[0] as string;
      const videoPool = videoSuggestions.flatMap((s) => s.prompts);
      expect(videoPool).toContain(calledPrompt);
    });

    it('Surprise Me in audio modality selects from audioSuggestions pool', async () => {
      const user = userEvent.setup();
      modelStoreStubRef.current.activeModality = 'audio';
      render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

      await user.click(screen.getByRole('button', { name: /surprise me/i }));

      expect(mockOnSelect).toHaveBeenCalled();
      const calledPrompt = mockOnSelect.mock.calls[0]?.[0] as string;
      const audioPool = audioSuggestions.flatMap((s) => s.prompts);
      expect(audioPool).toContain(calledPrompt);
    });
  });
});
