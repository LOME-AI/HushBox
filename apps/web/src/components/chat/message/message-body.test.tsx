import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { MessageBody } from '@/components/chat/message/message-body';
import type { RenderableMedia } from '@/components/chat/media/media-content-item';

vi.mock('@/components/chat/message/message-media-list', () => ({
  MessageMediaList: ({
    media,
    contentKeyError,
    ariaPrefix,
  }: {
    media: RenderableMedia[];
    contentKeyError: Error | null;
    ariaPrefix: string;
  }) => (
    <div
      data-testid="media-list"
      data-count={media.length}
      data-aria-prefix={ariaPrefix}
      data-key-error={contentKeyError === null ? 'none' : contentKeyError.message}
    />
  ),
}));

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
      <MessageBody variant="assistant" media={[]} ariaPrefix="Generated" />
    );

    const bubble = container.firstElementChild;
    expect(bubble).toHaveClass('py-2', 'text-foreground', 'overflow-hidden');
    expect(bubble).not.toHaveClass('bg-message-user');
    expect(bubble).not.toHaveClass('bg-muted');
  });

  it('sets the assistant body flush with its column, with no inline padding of its own', () => {
    const { container } = render(
      <MessageBody variant="assistant" media={[]} ariaPrefix="Generated" />
    );
    expect(container.firstElementChild).not.toHaveClass('px-4');
  });

  it('applies own-user bubble styling', () => {
    const { container } = render(
      <MessageBody variant="user-own" media={[]} ariaPrefix="Generated" />
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
      <MessageBody variant="user-other" media={[]} ariaPrefix="Generated" />
    );

    expect(container.firstElementChild).toHaveClass(
      'px-4',
      'py-2',
      'bg-muted',
      'text-foreground',
      'rounded-lg'
    );
  });

  it('marks the bubble as a reading surface so message text renders in the serif', () => {
    const { container } = render(
      <MessageBody variant="assistant" media={[]} ariaPrefix="Generated" />
    );

    // data-reading is the twin of data-chrome: it flips the subtree to the serif
    // reading font. One tag here covers chat (MessageItem) and the public share view.
    expect(container.firstElementChild).toHaveAttribute('data-reading');
  });

  it('renders the text region (children) before the media list', () => {
    render(
      <MessageBody variant="assistant" media={[media('a')]} ariaPrefix="Generated">
        <p data-testid="text-region">hello</p>
      </MessageBody>
    );

    const text = screen.getByTestId('text-region');
    const list = screen.getByTestId('media-list');
    expect(text).toBeInTheDocument();
    // DOM order: text region precedes media list.
    expect(text.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('forwards media and aria prefix to the media list', () => {
    render(
      <MessageBody variant="assistant" media={[media('a'), media('b')]} ariaPrefix="Shared" />
    );

    const list = screen.getByTestId('media-list');
    expect(list).toHaveAttribute('data-count', '2');
    expect(list).toHaveAttribute('data-aria-prefix', 'Shared');
  });

  it('forwards a content-key error to the media list', () => {
    render(
      <MessageBody
        variant="assistant"
        media={[media('a')]}
        contentKeyError={new Error('Epoch key not available')}
        ariaPrefix="Generated"
      />
    );

    expect(screen.getByTestId('media-list')).toHaveAttribute(
      'data-key-error',
      'Epoch key not available'
    );
  });

  it('passes a null content-key error to the media list when none is supplied', () => {
    render(<MessageBody variant="assistant" media={[media('a')]} ariaPrefix="Generated" />);

    expect(screen.getByTestId('media-list')).toHaveAttribute('data-key-error', 'none');
  });

  it('renders Message deleted with its test id for a deleted message', () => {
    render(<MessageBody variant="user-other" media={[]} ariaPrefix="Generated" deleted />);

    expect(screen.getByTestId(TEST_IDS.messageDeleted)).toHaveTextContent('Message deleted');
  });

  it('renders neither the text region nor media for a deleted message', () => {
    render(
      <MessageBody variant="user-other" media={[media('a')]} ariaPrefix="Generated" deleted>
        <p data-testid="text-region">hello</p>
      </MessageBody>
    );

    expect(screen.queryByTestId('text-region')).not.toBeInTheDocument();
    expect(screen.queryByTestId('media-list')).not.toBeInTheDocument();
  });

  it('renders no deleted notice for a live message', () => {
    render(
      <MessageBody variant="assistant" media={[]} ariaPrefix="Generated">
        <p data-testid="text-region">hello</p>
      </MessageBody>
    );

    expect(screen.getByTestId('text-region')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.messageDeleted)).not.toBeInTheDocument();
  });

  it('renders the invalid-keys placeholder for a message written under invalid keys', () => {
    render(<MessageBody variant="assistant" media={[]} ariaPrefix="Generated" invalidKeys />);

    const placeholder = screen.getByTestId(TEST_IDS.messageInvalidKeys);
    expect(placeholder).toHaveTextContent('Unreadable: written under invalid keys');
    expect(placeholder).toHaveAttribute(TEST_SIGNALS.epochState, 'bad');
  });

  it('renders neither the text region nor media for a message written under invalid keys', () => {
    render(
      <MessageBody variant="assistant" media={[media('a')]} ariaPrefix="Generated" invalidKeys>
        <p data-testid="text-region">[decryption failed]</p>
      </MessageBody>
    );

    expect(screen.queryByTestId('text-region')).not.toBeInTheDocument();
    expect(screen.queryByTestId('media-list')).not.toBeInTheDocument();
  });

  it('renders no invalid-keys placeholder for a readable message', () => {
    render(
      <MessageBody variant="assistant" media={[]} ariaPrefix="Generated">
        <p data-testid="text-region">hello</p>
      </MessageBody>
    );

    expect(screen.queryByTestId(TEST_IDS.messageInvalidKeys)).not.toBeInTheDocument();
  });

  it('forwards an extra className onto the bubble', () => {
    const { container } = render(
      <MessageBody variant="assistant" media={[]} ariaPrefix="Generated" className="custom-x" />
    );

    expect(container.firstElementChild).toHaveClass('custom-x');
  });
});
