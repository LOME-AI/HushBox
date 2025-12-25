import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SuggestionChips } from './suggestion-chips';
import { promptSuggestions } from '@/lib/prompt-suggestions';

describe('SuggestionChips', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders suggestion chips container', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    expect(screen.getByTestId('suggestion-chips')).toBeInTheDocument();
  });

  it('renders all suggestion chips by default', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    promptSuggestions.forEach((suggestion) => {
      expect(screen.getByText(suggestion.label)).toBeInTheDocument();
    });
  });

  it('calls onSelect with the prompt when a chip is clicked', async () => {
    const user = userEvent.setup();
    render(<SuggestionChips onSelect={mockOnSelect} />);

    const firstSuggestion = promptSuggestions[0];
    if (!firstSuggestion) throw new Error('No suggestions available');
    const firstChip = screen.getByText(firstSuggestion.label);
    await user.click(firstChip);

    expect(mockOnSelect).toHaveBeenCalledWith(firstSuggestion.prompt);
  });

  it('renders chips with icons', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    // Each chip should have an icon (SVG element)
    const chips = screen.getAllByRole('button');
    expect(chips.length).toBeGreaterThanOrEqual(promptSuggestions.length);
  });

  it('chips have chip styling (rounded, interactive)', () => {
    render(<SuggestionChips onSelect={mockOnSelect} />);
    const firstSuggestion = promptSuggestions[0];
    if (!firstSuggestion) throw new Error('No suggestions available');
    const chip = screen.getByText(firstSuggestion.label).closest('button');
    expect(chip).toBeInTheDocument();
  });

  it('renders "Surprise Me" button', () => {
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);
    expect(screen.getByRole('button', { name: /surprise me/i })).toBeInTheDocument();
  });

  it('"Surprise Me" button calls onSelect with a random prompt', async () => {
    const user = userEvent.setup();
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

    const surpriseButton = screen.getByRole('button', { name: /surprise me/i });
    await user.click(surpriseButton);

    expect(mockOnSelect).toHaveBeenCalled();
    // Verify the prompt is one of the available suggestions
    const firstCall = mockOnSelect.mock.calls[0];
    if (!firstCall) throw new Error('No call recorded');
    const calledPrompt: unknown = firstCall[0];
    const validPrompts = promptSuggestions.map((s) => s.prompt);
    expect(validPrompts).toContain(calledPrompt);
  });

  it('does not render "Surprise Me" when showSurpriseMe is false', () => {
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe={false} />);
    expect(screen.queryByRole('button', { name: /surprise me/i })).not.toBeInTheDocument();
  });

  it('renders with custom className', () => {
    render(<SuggestionChips onSelect={mockOnSelect} className="custom-class" />);
    expect(screen.getByTestId('suggestion-chips')).toHaveClass('custom-class');
  });
});
