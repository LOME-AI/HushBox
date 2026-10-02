import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageMediaList } from '@/components/chat/message/message-media-list';
import type { RenderableMedia } from '@/components/chat/media/media-content-item';

vi.mock('@/components/chat/media/media-content-item', () => ({
  MediaContentItem: ({
    item,
    contentKeyError,
    ariaPrefix,
  }: {
    item: RenderableMedia;
    contentKeyError?: Error | null;
    ariaPrefix: string;
  }) => (
    <div
      data-testid={`media-${item.contentItemId}`}
      data-aria-prefix={ariaPrefix}
      data-key-error={contentKeyError ? contentKeyError.message : 'none'}
    />
  ),
}));

function media(contentItemId: string, overrides: Partial<RenderableMedia> = {}): RenderableMedia {
  return {
    contentItemId,
    contentType: 'image',
    mimeType: 'image/png',
    width: 256,
    height: 256,
    ...overrides,
  };
}

describe('MessageMediaList', () => {
  it('renders nothing when there are no media items', () => {
    const { container } = render(<MessageMediaList media={[]} ariaPrefix="Generated" />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders one MediaContentItem per media item, preserving order', () => {
    render(
      <MessageMediaList media={[media('a'), media('b'), media('c')]} ariaPrefix="Generated" />
    );

    const ids = [...document.querySelectorAll<HTMLElement>('[data-testid^="media-"]')].map(
      (el) => el.dataset['testid']
    );
    expect(ids).toEqual(['media-a', 'media-b', 'media-c']);
  });

  it('stacks items in the same spacing container the chat bubble uses', () => {
    render(<MessageMediaList media={[media('a')]} ariaPrefix="Generated" />);

    const wrapper = screen.getByTestId('media-a').parentElement;
    expect(wrapper).toHaveClass('mt-2', 'flex', 'flex-col', 'gap-2');
  });

  it('forwards the aria prefix to each item', () => {
    render(<MessageMediaList media={[media('a')]} ariaPrefix="Shared" />);

    const item = screen.getByTestId('media-a');
    expect(item).toHaveAttribute('data-aria-prefix', 'Shared');
    expect(item).toHaveAttribute('data-key-error', 'none');
  });

  it('forwards a content-key error to each item so undecryptable media shows an error', () => {
    render(
      <MessageMediaList
        media={[media('a'), media('b')]}
        contentKeyError={new Error('Epoch key not available')}
        ariaPrefix="Generated"
      />
    );

    expect(screen.getByTestId('media-a')).toHaveAttribute(
      'data-key-error',
      'Epoch key not available'
    );
    expect(screen.getByTestId('media-b')).toHaveAttribute(
      'data-key-error',
      'Epoch key not available'
    );
  });
});
