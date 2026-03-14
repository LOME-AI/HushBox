import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../hooks/use-conversation-links.js', () => ({
  useCreateLink: vi.fn(),
}));

vi.mock('@hushbox/crypto', () => ({
  createSharedLink: vi.fn(),
}));

const mockRotationResult = {
  params: {
    expectedEpoch: 1,
    epochPublicKey: 'ep',
    confirmationHash: 'ch',
    chainLink: 'cl',
    encryptedTitle: 'et',
    memberWraps: [],
  },
  newEpochPrivateKey: new Uint8Array(32).fill(8),
  newEpochNumber: 2,
};
const mockExecuteWithRotation = vi.fn(
  async (input: { execute: (r: unknown) => Promise<unknown> }) => {
    await input.execute(mockRotationResult.params);
    return mockRotationResult;
  }
);
vi.mock('../../lib/rotation.js', () => ({
  executeWithRotation: (...args: unknown[]) =>
    mockExecuteWithRotation(...(args as [{ execute: (r: unknown) => Promise<unknown> }])),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    toBase64: vi.fn(),
  };
});

import { useCreateLink } from '../../hooks/use-conversation-links.js';
import { createSharedLink } from '@hushbox/crypto';
import { toBase64, MAX_CONVERSATION_MEMBERS } from '@hushbox/shared';
import { InviteLinkModal } from './invite-link-modal.js';

const mockUseCreateLink = vi.mocked(useCreateLink);
const mockCreateSharedLink = vi.mocked(createSharedLink);
const mockToBase64 = vi.mocked(toBase64);

const mockMutateAsync = vi.fn();

describe('InviteLinkModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    conversationId: 'conv-123',
    currentEpochPrivateKey: new Uint8Array([1, 2, 3]),
    currentEpochNumber: 1,
    plaintextTitle: 'Test Chat',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteWithRotation.mockImplementation(
      async (input: { execute: (r: unknown) => Promise<unknown> }) => {
        await input.execute(mockRotationResult.params);
        return mockRotationResult;
      }
    );
    mockUseCreateLink.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateLink>);
    mockMutateAsync.mockResolvedValue({ linkId: 'link-1' });
    mockCreateSharedLink.mockReturnValue({
      linkSecret: new Uint8Array([10, 20, 30]),
      linkPublicKey: new Uint8Array([40, 50, 60]),
      linkWrap: new Uint8Array([70, 80, 90]),
    });
    mockToBase64.mockImplementation((bytes: Uint8Array) => {
      if (bytes[0] === 10) return 'link-secret-b64';
      if (bytes[0] === 40) return 'link-pubkey-b64';
      if (bytes[0] === 70) return 'link-wrap-b64';
      return 'unknown-b64';
    });
  });

  it('renders create phase by default', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-modal')).toBeInTheDocument();
    expect(screen.getByTestId('invite-link-generate-button')).toBeInTheDocument();
  }, 15_000);

  it('shows permission selector with Read as default', () => {
    render(<InviteLinkModal {...defaultProps} />);

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- getByTestId returns HTMLElement, need cast for .value
    const select = screen.getByTestId('invite-link-privilege-select') as HTMLSelectElement;
    expect(select.value).toBe('read');
  });

  it('shows history checkbox unchecked by default', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-history-checkbox')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('has optional guest name input', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-name-input')).toBeInTheDocument();
  });

  it('shows warning text about link security', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-warning')).toHaveTextContent(
      'Anyone with this link can decrypt'
    );
  });

  it('calls createSharedLink and useCreateLink on generate', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockCreateSharedLink).toHaveBeenCalledWith(defaultProps.currentEpochPrivateKey);
    // No-history link goes through executeWithRotation, which calls mutateAsync with rotation
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-123',
        linkPublicKey: 'link-pubkey-b64',
        memberWrap: 'link-wrap-b64',
        privilege: 'read',
        giveFullHistory: false,
        rotation: mockRotationResult.params,
      })
    );
  });

  it('passes giveFullHistory true when history checkbox is checked', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ giveFullHistory: true })
    );
  });

  it('passes selected privilege to mutation', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.selectOptions(screen.getByTestId('invite-link-privilege-select'), 'write');
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ privilege: 'write' }));
  });

  it('switches to generated phase with URL after generation', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(screen.getByTestId('invite-link-url')).toBeInTheDocument();
    expect(screen.getByTestId('invite-link-copy-button')).toBeInTheDocument();
  });

  it('constructs URL with linkSecret in fragment', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    const urlEl = screen.getByTestId('invite-link-url');
    expect(urlEl.textContent).toContain('/share/c/conv-123#link-secret-b64');
  });

  it('closes modal when Cancel is clicked', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-cancel-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows "Copied" text after clicking copy button', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));
    await userEvent.click(screen.getByTestId('invite-link-copy-button'));

    expect(screen.getByTestId('invite-link-copy-button')).toHaveTextContent('Copied');
  });

  it('resets to create phase when reopened', () => {
    const { rerender } = render(<InviteLinkModal {...defaultProps} open={false} />);
    rerender(<InviteLinkModal {...defaultProps} open={true} />);

    expect(screen.getByTestId('invite-link-generate-button')).toBeInTheDocument();
    expect(screen.queryByTestId('invite-link-url')).not.toBeInTheDocument();
  });

  it('shows member limit alert and disables generate when at capacity', () => {
    render(<InviteLinkModal {...defaultProps} memberCount={MAX_CONVERSATION_MEMBERS} />);

    expect(screen.getByText(/reached the maximum of 100 members/)).toBeInTheDocument();
    expect(screen.getByTestId('invite-link-generate-button')).toBeDisabled();
  });

  it('does not show member limit alert when below capacity', () => {
    render(<InviteLinkModal {...defaultProps} memberCount={50} />);

    expect(screen.queryByText(/reached the maximum of 100 members/)).not.toBeInTheDocument();
  });

  it('renders create phase buttons side-by-side with Cancel on left', () => {
    render(<InviteLinkModal {...defaultProps} />);

    const generateButton = screen.getByTestId('invite-link-generate-button');
    const cancelButton = screen.getByTestId('invite-link-cancel-button');

    // Get parent container
    const container = generateButton.parentElement;
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('gap-2');
    expect(container).not.toHaveClass('flex-col');

    // Both buttons should use flex-1
    expect(generateButton).toHaveClass('flex-1');
    expect(cancelButton).toHaveClass('flex-1');

    // Cancel should come before Generate Link in DOM order
    const buttons = [...container!.children];
    expect(buttons.indexOf(cancelButton)).toBeLessThan(buttons.indexOf(generateButton));
  });

  it('Enter on guest name input triggers link generation', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    const nameInput = screen.getByTestId('invite-link-name-input');
    nameInput.focus();

    // Dispatch Enter keydown — the hook intercepts this and calls requestSubmit
    nameInput.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    );

    await waitFor(() => {
      expect(mockCreateSharedLink).toHaveBeenCalledWith(defaultProps.currentEpochPrivateKey);
    });
    expect(mockMutateAsync).toHaveBeenCalled();
  });

  it('uses executeWithRotation for no-history link creation', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    // Default: history unchecked (no history)
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-123',
        currentEpochPrivateKey: defaultProps.currentEpochPrivateKey,
        currentEpochNumber: 1,
        plaintextTitle: 'Test Chat',
        filterMembers: expect.any(Function),
        execute: expect.any(Function),
      })
    );
  });

  it('does not use executeWithRotation when includeHistory is true', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockExecuteWithRotation).not.toHaveBeenCalled();
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ giveFullHistory: true })
    );
  });

  it('renders generated phase buttons side-by-side with Done on left', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    const copyButton = screen.getByTestId('invite-link-copy-button');
    const doneButton = screen.getByText('Done');

    // Get parent container
    const container = copyButton.parentElement;
    expect(container).toHaveClass('flex');
    expect(container).toHaveClass('gap-2');
    expect(container).not.toHaveClass('flex-col');

    // Both buttons should use flex-1
    expect(copyButton).toHaveClass('flex-1');
    expect(doneButton).toHaveClass('flex-1');

    // Done should come before Copy in DOM order
    const buttons = [...container!.children];
    expect(buttons.indexOf(doneButton)).toBeLessThan(buttons.indexOf(copyButton));
  });
});
