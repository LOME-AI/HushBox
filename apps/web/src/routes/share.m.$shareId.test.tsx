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

// ChatLayout is mocked for safety: the page no longer uses it after Step 9, but
// if a stale reference slips through, we want the test to fail on the assertion,
// not on a cascade of env-parsing side effects from the real ChatLayout tree.
vi.mock('../components/chat/chat-layout.js', () => ({
  ChatLayout: () => <div data-testid="chat-layout-should-not-render" />,
}));

vi.mock('../components/chat/markdown-renderer.js', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

vi.mock('../components/chat/shared-media-content-item.js', () => ({
  SharedMediaContentItem: ({
    item,
  }: {
    item: {
      contentItemId: string;
      contentType: string;
      downloadUrl: string;
    };
  }) => (
    <div
      data-testid={`shared-media-${item.contentItemId}`}
      data-content-type={item.contentType}
      data-download-url={item.downloadUrl}
    >
      Shared media: {item.contentItemId}
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

type SharedMessageData = NonNullable<ReturnType<typeof useSharedMessage>['data']>;

function mockData(overrides: Partial<SharedMessageData> = {}): SharedMessageData {
  return {
    createdAt: '2024-01-15T14:34:00Z',
    contentKey: new Uint8Array([1, 2, 3]),
    contentItems: [{ type: 'text', position: 0, content: 'Hello world' }],
    ...overrides,
  };
}

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

  it('renders AppShell with shared message content when data loads', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData(),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    expect(screen.getByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByTestId('shared-message-content')).toBeInTheDocument();
  });

  it('renders text content items via MarkdownRenderer', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          { type: 'text', position: 0, content: 'First paragraph' },
          { type: 'text', position: 1, content: 'Second paragraph' },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    const renderers = screen.getAllByTestId('markdown-renderer');
    expect(renderers).toHaveLength(2);
    expect(renderers[0]).toHaveTextContent('First paragraph');
    expect(renderers[1]).toHaveTextContent('Second paragraph');
  });

  it('renders media content items via SharedMediaContentItem', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          {
            type: 'media',
            position: 0,
            contentItemId: 'img-1',
            contentType: 'image',
            mimeType: 'image/png',
            sizeBytes: 1024,
            width: 512,
            height: 512,
            durationMs: null,
            downloadUrl: 'https://signed.example/a',
            expiresAt: '2026-04-19T00:05:00.000Z',
          },
          {
            type: 'media',
            position: 1,
            contentItemId: 'vid-1',
            contentType: 'video',
            mimeType: 'video/mp4',
            sizeBytes: 4096,
            width: 1920,
            height: 1080,
            durationMs: 5000,
            downloadUrl: 'https://signed.example/b',
            expiresAt: '2026-04-19T00:05:00.000Z',
          },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    const img = screen.getByTestId('shared-media-img-1');
    expect(img).toHaveAttribute('data-content-type', 'image');
    expect(img).toHaveAttribute('data-download-url', 'https://signed.example/a');
    const vid = screen.getByTestId('shared-media-vid-1');
    expect(vid).toHaveAttribute('data-content-type', 'video');
  });

  it('renders interleaved text and media in position order', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          { type: 'text', position: 0, content: 'before' },
          {
            type: 'media',
            position: 1,
            contentItemId: 'img-mid',
            contentType: 'image',
            mimeType: 'image/png',
            sizeBytes: 1,
            width: 1,
            height: 1,
            durationMs: null,
            downloadUrl: 'https://signed.example/mid',
            expiresAt: '2026-04-19T00:05:00.000Z',
          },
          { type: 'text', position: 2, content: 'after' },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    render(<SharedMessagePage />);

    const container = screen.getByTestId('shared-message-content');
    const children = [...container.children];
    expect(children).toHaveLength(3);
    expect(children[0]!.querySelector('[data-testid="markdown-renderer"]')?.textContent).toBe(
      'before'
    );
    expect(children[1]!.querySelector('[data-testid="shared-media-img-mid"]')).not.toBeNull();
    expect(children[2]!.querySelector('[data-testid="markdown-renderer"]')?.textContent).toBe(
      'after'
    );
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
