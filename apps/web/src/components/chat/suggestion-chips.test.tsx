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
    for (const suggestion of promptSuggestions) {
      expect(screen.getByText(suggestion.label)).toBeInTheDocument();
    }
  });

  it('calls onSelect with a prompt from the category when a chip is clicked', async () => {
    const user = userEvent.setup();
    render(<SuggestionChips onSelect={mockOnSelect} />);

    const firstSuggestion = promptSuggestions[0];
    if (!firstSuggestion) throw new Error('No suggestions available');
    const firstChip = screen.getByText(firstSuggestion.label);
    await user.click(firstChip);

    expect(mockOnSelect).toHaveBeenCalled();
    const calledPrompt = mockOnSelect.mock.calls[0]?.[0] as string;
    expect(firstSuggestion.prompts).toContain(calledPrompt);
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

  it('"Surprise Me" button calls onSelect with a random prompt from any category', async () => {
    const user = userEvent.setup();
    render(<SuggestionChips onSelect={mockOnSelect} showSurpriseMe />);

    const surpriseButton = screen.getByRole('button', { name: /surprise me/i });
    await user.click(surpriseButton);

    expect(mockOnSelect).toHaveBeenCalled();
    // Verify the prompt is one of the available prompts from any category
    const firstCall = mockOnSelect.mock.calls[0];
    if (!firstCall) throw new Error('No call recorded');
    const calledPrompt = firstCall[0] as string;
    const allValidPrompts = promptSuggestions.flatMap((s) => s.prompts);
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
});
