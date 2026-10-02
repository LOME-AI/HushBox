import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// MediaPreview and MediaPlaceholder are spied so each test asserts the shell
// chose the right child + forwarded the right props. The shell itself is a
// pure conditional renderer; mocking the leaves keeps these tests focused on
// the branching logic that this file owns.

const mockMediaPlaceholder = vi.fn();
const mockMediaPreview = vi.fn();

vi.mock('@/components/chat/media/media-preview', () => ({
  MediaPlaceholder: (props: Record<string, unknown>) => {
    mockMediaPlaceholder(props);
    return <div data-testid="placeholder" />;
  },
  MediaPreview: (props: Record<string, unknown>) => {
    mockMediaPreview(props);
    return <div data-testid="preview" />;
  },
}));

import { MediaItemShell } from '@/components/chat/media/media-item-shell';

interface ShellProps {
  blobUrl: string | null;
  isLoading: boolean;
  error: Error | null;
  mimeType: string;
  contentType: 'image' | 'audio' | 'video';
  width: number | null | undefined;
  height: number | null | undefined;
  ariaPrefix: string;
  className?: string;
}

function defaultProps(overrides: Partial<ShellProps> = {}): ShellProps {
  return {
    blobUrl: 'blob:resolved',
    isLoading: false,
    error: null,
    mimeType: 'image/png',
    contentType: 'image',
    width: 512,
    height: 512,
    ariaPrefix: 'Generated',
    ...overrides,
  };
}

describe('MediaItemShell', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('error branch', () => {
    it('renders an error placeholder and never calls MediaPreview when error is non-null', () => {
      const { getByTestId, queryByTestId } = render(
        <MediaItemShell {...defaultProps({ error: new Error('decrypt failed') })} />
      );

      expect(getByTestId('placeholder')).toBeInTheDocument();
      expect(queryByTestId('preview')).toBeNull();
      expect(mockMediaPlaceholder).toHaveBeenCalledTimes(1);
      expect(mockMediaPlaceholder.mock.calls[0]?.[0]).toMatchObject({
        status: 'error',
        width: 512,
        height: 512,
      });
      expect(mockMediaPreview).not.toHaveBeenCalled();
    });

    it('shows error placeholder even while still loading and with a resolved blobUrl (error wins)', () => {
      render(
        <MediaItemShell
          {...defaultProps({
            error: new Error('decrypt failed'),
            isLoading: true,
            blobUrl: 'blob:still-loading',
          })}
        />
      );

      expect(mockMediaPlaceholder).toHaveBeenCalledTimes(1);
      expect(mockMediaPlaceholder.mock.calls[0]?.[0]).toMatchObject({ status: 'error' });
      expect(mockMediaPreview).not.toHaveBeenCalled();
    });
  });

  describe('loading branch', () => {
    it('renders a loading placeholder when isLoading is true', () => {
      render(<MediaItemShell {...defaultProps({ isLoading: true, blobUrl: null })} />);

      expect(mockMediaPlaceholder).toHaveBeenCalledTimes(1);
      expect(mockMediaPlaceholder.mock.calls[0]?.[0]).toMatchObject({
        status: 'loading',
        width: 512,
        height: 512,
      });
      expect(mockMediaPreview).not.toHaveBeenCalled();
    });

    it('renders a loading placeholder when blobUrl is null even if isLoading is false', () => {
      // The hook can briefly return { isLoading: false, blobUrl: null, error: null }
      // between cache invalidations. The shell must treat the missing blob as
      // a loading state, not crash on a null URL.
      render(<MediaItemShell {...defaultProps({ isLoading: false, blobUrl: null })} />);

      expect(mockMediaPlaceholder).toHaveBeenCalledTimes(1);
      expect(mockMediaPlaceholder.mock.calls[0]?.[0]).toMatchObject({ status: 'loading' });
      expect(mockMediaPreview).not.toHaveBeenCalled();
    });

    it('forwards null width/height to the placeholder when dimensions are unknown', () => {
      render(
        <MediaItemShell
          {...defaultProps({ isLoading: true, blobUrl: null, width: null, height: null })}
        />
      );

      expect(mockMediaPlaceholder.mock.calls[0]?.[0]).toMatchObject({
        status: 'loading',
        width: null,
        height: null,
      });
    });
  });

  describe('happy path', () => {
    it('renders MediaPreview with all forwarded props when blobUrl is resolved and not erroring', () => {
      render(<MediaItemShell {...defaultProps()} />);

      expect(mockMediaPreview).toHaveBeenCalledTimes(1);
      expect(mockMediaPlaceholder).not.toHaveBeenCalled();
      expect(mockMediaPreview.mock.calls[0]?.[0]).toMatchObject({
        blobUrl: 'blob:resolved',
        mimeType: 'image/png',
        contentType: 'image',
        ariaPrefix: 'Generated',
      });
    });

    it('omits className from MediaPreview props when className is undefined', () => {
      // The conditional spread `...(className !== undefined && { className })`
      // must not pass className=undefined; it must omit the key entirely so
      // MediaPreview's own default merging is not interfered with.
      render(<MediaItemShell {...defaultProps()} />);

      expect(mockMediaPreview).toHaveBeenCalledTimes(1);
      const props = mockMediaPreview.mock.calls[0]?.[0] as Record<string, unknown>;
      expect('className' in props).toBe(false);
    });

    it('forwards className to MediaPreview when className is provided', () => {
      render(<MediaItemShell {...defaultProps({ className: 'extra-class' })} />);

      expect(mockMediaPreview.mock.calls[0]?.[0]).toMatchObject({ className: 'extra-class' });
    });

    it('forwards video contentType + ariaPrefix unchanged', () => {
      render(
        <MediaItemShell
          {...defaultProps({
            contentType: 'video',
            mimeType: 'video/mp4',
            ariaPrefix: 'Shared',
          })}
        />
      );

      expect(mockMediaPreview.mock.calls[0]?.[0]).toMatchObject({
        contentType: 'video',
        mimeType: 'video/mp4',
        ariaPrefix: 'Shared',
      });
    });
  });
});
