import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TypingIndicator } from './typing-indicator';

describe('TypingIndicator', () => {
  const members = [
    { userId: 'u1', username: 'alice_smith' },
    { userId: 'u2', username: 'bob' },
    { userId: 'u3', username: 'carol' },
    { userId: 'u4', username: 'dave' },
  ];

  it('renders nothing when typingUserIds is empty', () => {
    const { container } = render(<TypingIndicator typingUserIds={new Set()} members={members} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows single user typing with username', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByText('Alice Smith is typing...')).toBeInTheDocument();
  });

  it('shows two users typing joined with "and"', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2'])} members={members} />);
    expect(screen.getByText('Alice Smith and Bob are typing...')).toBeInTheDocument();
  });

  it('shows "N people are typing..." for 3+ users', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2', 'u3'])} members={members} />);
    expect(screen.getByText('3 people are typing...')).toBeInTheDocument();
  });

  it('shows "N people are typing..." for 4 users', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2', 'u3', 'u4'])} members={members} />);
    expect(screen.getByText('4 people are typing...')).toBeInTheDocument();
  });

  it('falls back to "Someone" if userId not found in members', () => {
    render(<TypingIndicator typingUserIds={new Set(['unknown-id'])} members={members} />);
    expect(screen.getByText('Someone is typing...')).toBeInTheDocument();
  });

  it('falls back to "Someone" for unknown user mixed with known user', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'unknown-id'])} members={members} />);
    expect(screen.getByText('Alice Smith and Someone are typing...')).toBeInTheDocument();
  });

  it('has correct aria-label matching display text for single user', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Alice Smith is typing...');
  });

  it('has correct aria-label matching display text for two users', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2'])} members={members} />);
    expect(screen.getByRole('status')).toHaveAttribute(
      'aria-label',
      'Alice Smith and Bob are typing...'
    );
  });

  it('has correct aria-label for 3+ users', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1', 'u2', 'u3'])} members={members} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', '3 people are typing...');
  });

  it('has role="status" for screen reader live region', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('has data-testid="typing-indicator"', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByTestId('typing-indicator')).toBeInTheDocument();
  });

  it('renders three animated dots with animate-dot-pulse class', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    const dots = screen.getByTestId('typing-indicator').querySelectorAll('.animate-dot-pulse');
    expect(dots).toHaveLength(3);
  });

  it('dots container has aria-hidden="true"', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    const dots = screen.getByTestId('typing-indicator').querySelectorAll('.animate-dot-pulse');
    const dotsContainer = dots[0]!.parentElement!;
    expect(dotsContainer).toHaveAttribute('aria-hidden', 'true');
  });

  it('each dot has staggered animation-delay', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    const dots = screen.getByTestId('typing-indicator').querySelectorAll('.animate-dot-pulse');
    expect(dots[0]).toHaveStyle({ animationDelay: '0s' });
    expect(dots[1]).toHaveStyle({ animationDelay: '0.16s' });
    expect(dots[2]).toHaveStyle({ animationDelay: '0.32s' });
  });

  it('uses foreground text color', () => {
    render(<TypingIndicator typingUserIds={new Set(['u1'])} members={members} />);
    expect(screen.getByTestId('typing-indicator')).toHaveClass('text-foreground');
  });
});
