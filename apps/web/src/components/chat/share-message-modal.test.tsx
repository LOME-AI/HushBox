import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../hooks/use-message-share.js', () => ({
  useMessageShare: vi.fn(),
}));

import { useMessageShare } from '../../hooks/use-message-share.js';
import { ShareMessageModal } from './share-message-modal.js';

const mockUseMessageShare = vi.mocked(useMessageShare);
const mockMutateAsync = vi.fn();

describe('ShareMessageModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    messageId: 'msg-123',
    messageContent: 'Here is the final API design for the encryption layer.',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseMessageShare.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useMessageShare>);
    mockMutateAsync.mockResolvedValue({
      shareId: 'share-xyz',
      url: 'http://localhost:3000/share/m/share-xyz#secret-key-b64',
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  it('renders the modal with preview phase', () => {
    render(<ShareMessageModal {...defaultProps} />);

    expect(screen.getByTestId('share-message-modal')).toBeInTheDocument();
    expect(screen.getByTestId('share-message-preview')).toBeInTheDocument();
  });

  it('displays message content preview', () => {
    render(<ShareMessageModal {...defaultProps} />);

    const preview = screen.getByTestId('share-message-preview');
    expect(preview).toHaveTextContent('Here is the final API design');
  });

  it('shows cryptographic isolation info in an Alert', () => {
    render(<ShareMessageModal {...defaultProps} />);

    const isolationInfo = screen.getByTestId('share-message-isolation-info');
    expect(isolationInfo).toHaveTextContent('single message only');
    expect(isolationInfo).toHaveAttribute('role', 'alert');
  });

  it('calls useMessageShare on Create Link click', async () => {
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      messageId: 'msg-123',
      plaintextContent: 'Here is the final API design for the encryption layer.',
    });
  });

  it('switches to generated phase after creation', async () => {
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-url')).toBeInTheDocument();
    expect(screen.getByTestId('share-message-copy-button')).toBeInTheDocument();
  });

  it('displays the generated URL', async () => {
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-url')).toHaveTextContent(
      'http://localhost:3000/share/m/share-xyz#secret-key-b64'
    );
  });

  it('closes modal when Cancel is clicked', async () => {
    render(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-cancel-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render when messageId is null', () => {
    render(<ShareMessageModal {...defaultProps} messageId={null} />);

    expect(screen.queryByTestId('share-message-preview')).not.toBeInTheDocument();
  });

  it('resets to preview phase when reopened', () => {
    const { rerender } = render(<ShareMessageModal {...defaultProps} open={false} />);
    rerender(<ShareMessageModal {...defaultProps} open={true} />);

    expect(screen.getByTestId('share-message-create-button')).toBeInTheDocument();
    expect(screen.queryByTestId('share-message-url')).not.toBeInTheDocument();
  });
});
