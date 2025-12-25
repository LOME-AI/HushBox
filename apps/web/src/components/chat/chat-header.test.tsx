import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatHeader } from './chat-header';

// Mock the theme provider
vi.mock('../providers/theme-provider', () => ({
  useTheme: () => ({
    mode: 'light',
    triggerTransition: vi.fn(),
  }),
}));

describe('ChatHeader', () => {
  it('renders conversation title', () => {
    render(<ChatHeader title="Test Conversation" />);
    expect(screen.getByText('Test Conversation')).toBeInTheDocument();
  });

  it('renders default title when none provided', () => {
    render(<ChatHeader />);
    expect(screen.getByText('New Chat')).toBeInTheDocument();
  });

  it('renders theme toggle', () => {
    render(<ChatHeader title="Test" />);
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it('has sticky positioning', () => {
    render(<ChatHeader title="Test" />);
    const header = screen.getByTestId('chat-header');
    expect(header).toHaveClass('sticky');
    expect(header).toHaveClass('top-0');
  });

  it('has border bottom', () => {
    render(<ChatHeader title="Test" />);
    const header = screen.getByTestId('chat-header');
    expect(header).toHaveClass('border-b');
  });

  it('has proper padding', () => {
    render(<ChatHeader title="Test" />);
    const header = screen.getByTestId('chat-header');
    expect(header).toHaveClass('px-4');
    expect(header).toHaveClass('py-3');
  });
});
