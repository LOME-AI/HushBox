import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, cleanup } from '@testing-library/react';
import { MAX_MEDIA_OBJECT_BYTES } from '@hushbox/shared';
import { renderWithProviders } from '@/test-utils/render';
import { MediaContentItem, type RenderableMedia } from '@/components/chat/media/media-content-item';
import type { ContentKey, WrappedSecret } from '@hushbox/crypto';

// End-to-end proof that the client size guard fires through the real render
// chain: MediaContentItem -> useDecryptedMedia -> useDecryptBlob. Nothing here
// is mocked except the network `fetch`, so an over-cap item must be rejected
// from its declared `sizeBytes` before any byte is requested.
describe('MediaContentItem client size guard', () => {
  const fetchSpy = vi.fn<(input: RequestInfo | URL) => Promise<Response>>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function overCapItem(): RenderableMedia {
    return {
      contentItemId: 'huge-1',
      contentType: 'image',
      mimeType: 'image/png',
      width: 512,
      height: 512,
      // A pre-signed URL is on hand and the envelope decryptor is resolved, so
      // the only thing standing between this render and a fetch is the guard.
      downloadUrl: 'https://signed.example/huge',
      sizeBytes: MAX_MEDIA_OBJECT_BYTES + 1,
      envelope: {
        contentKey: new Uint8Array([1, 2, 3]) as ContentKey,
        wrappedContentKey: new Uint8Array([4, 5, 6]) as WrappedSecret,
        conversationId: 'conv-1',
        messageId: 'msg-1',
        epochNumber: 1,
        senderId: 'sender-1',
        position: 0,
      },
    };
  }

  it('rejects an over-cap item before any fetch and surfaces the error', async () => {
    renderWithProviders(<MediaContentItem item={overCapItem()} ariaPrefix="Generated" />);

    await waitFor(() => {
      expect(
        screen.getByRole('status', { name: /couldn['’]t load this media.+refresh the page/i })
      ).toBeInTheDocument();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
