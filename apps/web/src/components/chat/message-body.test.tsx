import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ContentKey } from '@hushbox/crypto';
import type { RenderableMedia } from './media-content-item';

vi.mock('./message-media-list', () => ({
  MessageMediaList: ({
    media,
    contentKey,
    ariaPrefix,
  }: {
    media: RenderableMedia[];
    contentKey: ContentKey | null;
    ariaPrefix: string;
  }) => (
    <div
      data-testid="media-list"
      data-count={media.length}
      data-aria-prefix={ariaPrefix}
      data-has-key={contentKey === null ? 'no' : 'yes'}
    />
  ),
}));

import { MessageBody } from './message-body';

const key = new Uint8Array([1, 2, 3]) as ContentKey;

function media(contentItemId: string): RenderableMedia {
  return {
    contentItemId,
    contentType: 'image',
    mimeType: 'image/png',
    width: 256,
    height: 256,
  };
}

describe('MessageBody', () => {
  it('applies the assistant bubble styling (no background)', () => {
    const { container } = render(
      <MessageBody variant="assistant" media={[]} contentKey={key} ariaPrefix="Generated" />
    );

    const bubble = container.firstElementChild;
    expect(bubble).toHaveClass('px-4', 'py-2', 'text-foreground', 'overflow-hidden');
    expect(bubble).not.toHaveClass('bg-message-user');
    expect(bubble).not.toHaveClass('bg-muted');
  });

  it('applies own-user bubble styling', () => {
    const { container } = render(
      <MessageBody variant="user-own" media={[]} contentKey={key} ariaPrefix="Generated" />
    );

    expect(container.firstElementChild).toHaveClass(
      'px-4',
      'py-2',
      'bg-message-user',
      'text-foreground',
      'rounded-lg'
    );
  });

  it('applies other-member bubble styling', () => {
    const { container } = render(
      <MessageBody variant="user-other" media={[]} contentKey={key} ariaPrefix="Generated" />
    );

    expect(container.firstElementChild).toHaveClass(
      'px-4',
      'py-2',
      'bg-muted',
      'text-foreground',
      'rounded-lg'
    );
  });

  it('renders the text region (children) before the media list', () => {
    render(
      <MessageBody variant="assistant" media={[media('a')]} contentKey={key} ariaPrefix="Generated">
        <p data-testid="text-region">hello</p>
      </MessageBody>
    );

    const text = screen.getByTestId('text-region');
    const list = screen.getByTestId('media-list');
    expect(text).toBeInTheDocument();
    // DOM order: text region precedes media list.
    expect(text.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('forwards media, content key, and aria prefix to the media list', () => {
    render(
      <MessageBody
        variant="assistant"
        media={[media('a'), media('b')]}
        contentKey={key}
        ariaPrefix="Shared"
      />
    );

    const list = screen.getByTestId('media-list');
    expect(list).toHaveAttribute('data-count', '2');
    expect(list).toHaveAttribute('data-aria-prefix', 'Shared');
    expect(list).toHaveAttribute('data-has-key', 'yes');
  });

  it('forwards an extra className onto the bubble', () => {
    const { container } = render(
      <MessageBody
        variant="assistant"
        media={[]}
        contentKey={key}
        ariaPrefix="Generated"
        className="custom-x"
      />
    );

    expect(container.firstElementChild).toHaveClass('custom-x');
  });
});
