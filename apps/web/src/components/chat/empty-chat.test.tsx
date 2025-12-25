import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmptyChat } from './empty-chat';

describe('EmptyChat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders greeting with typing animation', () => {
    render(<EmptyChat />);
    expect(screen.getByTestId('typing-animation')).toBeInTheDocument();
  });

  it('renders subtitle text', () => {
    render(<EmptyChat />);
    expect(screen.getByTestId('greeting-subtitle')).toBeInTheDocument();
  });

  it('renders suggestion prompts in a Card', () => {
    render(<EmptyChat />);
    expect(screen.getByTestId('suggestions-card')).toBeInTheDocument();
  });

  it('renders at least 3 suggestion prompts', () => {
    render(<EmptyChat />);
    const suggestions = screen.getAllByRole('button');
    expect(suggestions.length).toBeGreaterThanOrEqual(3);
  });

  it('centers content vertically', () => {
    render(<EmptyChat />);
    const container = screen.getByTestId('empty-chat');
    expect(container).toHaveClass('items-center');
    expect(container).toHaveClass('justify-center');
  });

  it('calls onSuggestionClick when suggestion is clicked', async () => {
    // Use real timers for this test since userEvent needs real time
    vi.useRealTimers();
    const user = userEvent.setup();
    const mockOnClick = vi.fn();
    render(<EmptyChat onSuggestionClick={mockOnClick} />);

    await user.click(screen.getByText('Help me write code'));
    expect(mockOnClick).toHaveBeenCalledWith('Help me write a function that...');
  });

  it('renders Card with border styling', () => {
    render(<EmptyChat />);
    const card = screen.getByTestId('suggestions-card');
    expect(card).toHaveClass('border');
  });
});
