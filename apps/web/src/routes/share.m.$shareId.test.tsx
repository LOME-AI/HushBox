import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../hooks/use-shared-message.js', () => ({
  useSharedMessage: vi.fn(),
}));

vi.mock('../components/shared/app-shell.js', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
}));

vi.mock('../components/chat/chat-layout.js', () => ({
  ChatLayout: ({ messages, inputDisabled }: { messages: unknown[]; inputDisabled: boolean }) => (
    <div
      data-testid="chat-layout"
      data-input-disabled={String(inputDisabled)}
      data-message-count={messages.length}
    >
      Chat Layout
    </div>
  ),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => {
    const routeObject = {
      component: undefined as unknown,
      useParams: () => ({ shareId: 'share-from-route' }),
    };
    return (config: { component: unknown }) => {
      routeObject.component = config.component;
      return routeObject;
    };
  },
}));

import { useSharedMessage } from '../hooks/use-shared-message.js';
import { SharedMessagePage } from './share.m.$shareId.js';

const mockUseSharedMessage = vi.mocked(useSharedMessage);

describe('SharedMessagePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'location', {
      value: { hash: '#c2hhcmUta2V5LWI2NA' },
      writable: true,
    });
  });

  it('renders loading state when data is loading', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    expect(screen.getByTestId('shared-message-loading')).toBeInTheDocument();
  });

  it('renders error state wrapped in AppShell', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('shared-message-error')).toBeInTheDocument();
  });

  it('shows AlertTriangle icon in error state', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    const errorContainer = screen.getByTestId('shared-message-error');
    const icon = errorContainer.querySelector('svg');
    expect(icon).toBeInTheDocument();
  });

  it('shows descriptive error messages', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    expect(screen.getByText('Unable to access message')).toBeInTheDocument();
    expect(screen.getByText('This share link may be invalid or expired.')).toBeInTheDocument();
  });

  it('renders AppShell with ChatLayout when data loads', () => {
    mockUseSharedMessage.mockReturnValue({
      data: {
        content: 'Hello world',
        createdAt: '2024-01-15T14:34:00Z',
        author: 'alice',
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('chat-layout')).toBeInTheDocument();
  });

  it('always disables input for shared messages', () => {
    mockUseSharedMessage.mockReturnValue({
      data: {
        content: 'Hello world',
        createdAt: '2024-01-15T14:34:00Z',
        author: 'alice',
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-input-disabled', 'true');
  });

  it('renders single message in chat layout', () => {
    mockUseSharedMessage.mockReturnValue({
      data: {
        content: 'Hello world',
        createdAt: '2024-01-15T14:34:00Z',
        author: 'alice',
      },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-message-count', '1');
  });

  it('passes hash fragment as keyBase64 to hook', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    expect(mockUseSharedMessage).toHaveBeenCalledWith('share-from-route', 'c2hhcmUta2V5LWI2NA');
  });
});
