import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/hooks/realtime/use-conversation-links.js', () => ({
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
const runRotation: typeof executeWithRotation = async (input) => {
  await input.execute(mockRotationResult.params);
  return mockRotationResult;
};
const mockExecuteWithRotation = vi.fn<typeof executeWithRotation>(runRotation);
vi.mock(import('@/lib/crypto/rotation.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  executeWithRotation: (...args: Parameters<typeof executeWithRotation>) =>
    mockExecuteWithRotation(...args),
}));

const mockGetEpochVerdict = vi.fn<typeof getEpochVerdict>();
vi.mock(import('@/lib/crypto/epoch-key-cache.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  getEpochVerdict: (...args: Parameters<typeof getEpochVerdict>) => mockGetEpochVerdict(...args),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    toBase64: vi.fn(),
  };
});

import { createSharedLink } from '@hushbox/crypto';
import { toBase64, friendlyErrorMessage, MAX_CONVERSATION_MEMBERS } from '@hushbox/shared';
import { useCreateLink } from '@/hooks/realtime/use-conversation-links.js';
import { InviteLinkModal } from '@/components/chat/member/invite-link-modal.js';
import type { executeWithRotation } from '@/lib/crypto/rotation.js';
import type { EpochVerdict, getEpochVerdict } from '@/lib/crypto/epoch-key-cache.js';

const mockUseCreateLink = vi.mocked(useCreateLink);
const mockCreateSharedLink = vi.mocked(createSharedLink);
const mockToBase64 = vi.mocked(toBase64);

const mockMutateAsync = vi.fn();

function verdictOf(rotation: EpochVerdict['rotation']): EpochVerdict {
  return {
    currentEpoch: 1,
    rotationPending: false,
    rotation,
    lastGoodEpoch: rotation === 'ok' ? 1 : null,
    badEpochs: new Set(),
  };
}

describe('InviteLinkModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    conversationId: 'conv-123',
    currentEpochKey: { epochNumber: 1, privateKey: new Uint8Array([1, 2, 3]) },
    plaintextTitle: 'Test Chat',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteWithRotation.mockImplementation(runRotation);
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument for the EpochVerdict|undefined return
    mockGetEpochVerdict.mockReturnValue(undefined);
    mockUseCreateLink.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateLink>);
    mockMutateAsync.mockResolvedValue({ linkId: 'link-1' });
    mockCreateSharedLink.mockReturnValue({
      linkSecret: new Uint8Array([10, 20, 30]),
      linkPublicKey: new Uint8Array([40, 50, 60]),
      linkWrap: new Uint8Array([70, 80, 90]),
      linkAuthHash: new Uint8Array([100, 110, 120]),
    });
    mockToBase64.mockImplementation((bytes: Uint8Array) => {
      if (bytes[0] === 10) return 'link-secret-b64';
      if (bytes[0] === 40) return 'link-pubkey-b64';
      if (bytes[0] === 70) return 'link-wrap-b64';
      if (bytes[0] === 100) return 'link-auth-hash-b64';
      return 'unknown-b64';
    });
  });

  describe('the create-link request and the link it produces', () => {
    async function choosePrivilege(privilege: 'read' | 'write'): Promise<void> {
      if (privilege === 'write') {
        await userEvent.click(screen.getByTestId('invite-link-privilege-write'));
      }
    }

    const baseRequest = {
      conversationId: 'conv-123',
      linkPublicKey: 'link-pubkey-b64',
      linkAuthHash: 'link-auth-hash-b64',
      memberWrap: 'link-wrap-b64',
      displayName: 'Guest Bob',
    };

    it.each(['read', 'write'] as const)(
      'sends the %s link with history as one request against the current epoch',
      async (privilege) => {
        render(<InviteLinkModal {...defaultProps} />);

        await choosePrivilege(privilege);
        await userEvent.click(screen.getByRole('checkbox'));
        await userEvent.type(screen.getByTestId('invite-link-name-input'), 'Guest Bob');
        await userEvent.click(screen.getByTestId('invite-link-generate-button'));

        await screen.findByTestId('invite-link-url');
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
        expect(mockMutateAsync).toHaveBeenCalledWith({
          ...baseRequest,
          privilege,
          giveFullHistory: true,
          expectedEpoch: 1,
        });
      }
    );

    it.each(['read', 'write'] as const)(
      'sends the %s link without history inside a rotation',
      async (privilege) => {
        render(<InviteLinkModal {...defaultProps} />);

        await choosePrivilege(privilege);
        await userEvent.type(screen.getByTestId('invite-link-name-input'), 'Guest Bob');
        await userEvent.click(screen.getByTestId('invite-link-generate-button'));

        await screen.findByTestId('invite-link-url');
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
        expect(mockMutateAsync).toHaveBeenCalledWith({
          ...baseRequest,
          privilege,
          giveFullHistory: false,
          rotation: mockRotationResult.params,
        });
      }
    );

    it('produces the share URL with the link secret as its fragment', async () => {
      render(<InviteLinkModal {...defaultProps} />);

      await userEvent.click(screen.getByTestId('invite-link-generate-button'));

      const url = await screen.findByTestId('invite-link-url');
      expect(url.textContent).toBe(
        `${globalThis.location.origin}/share/c/conv-123#link-secret-b64`
      );
    });
  });

  it('renders create phase by default', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-modal')).toBeInTheDocument();
    expect(screen.getByTestId('invite-link-generate-button')).toBeInTheDocument();
  }, 15_000);

  it('describes the dialog under its title', () => {
    render(<InviteLinkModal {...defaultProps} />);

    const heading = screen.getByRole('heading', { name: 'Invite via Link' });
    expect(heading.parentElement).toContainElement(
      screen.getByText(
        'Create a link for someone without a HushBox account to access this conversation.'
      )
    );
  });

  it('offers Read and Write in a group labelled Permission', () => {
    render(<InviteLinkModal {...defaultProps} />);

    const group = screen.getByRole('group', { name: 'Permission' });
    expect(group).toContainElement(screen.getByTestId('invite-link-privilege-read'));
    expect(group).toContainElement(screen.getByTestId('invite-link-privilege-write'));
  });

  it('chooses Read by default', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-privilege-read')).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByTestId('invite-link-privilege-write')).toHaveAttribute(
      'aria-checked',
      'false'
    );
  });

  it('keeps Write chosen when it is pressed again', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-privilege-write'));
    await userEvent.click(screen.getByTestId('invite-link-privilege-write'));

    expect(screen.getByTestId('invite-link-privilege-write')).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('shows history checkbox unchecked by default', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-history-checkbox')).not.toBeChecked();
  });

  it('draws the history checkbox at the large size', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-history-checkbox')).toHaveClass('size-6');
  });

  it('labels the guest name field, with its help line as its description', () => {
    render(<InviteLinkModal {...defaultProps} />);

    const field = screen.getByTestId('invite-link-name-input');
    expect(field).toHaveAccessibleName('Guest name (optional)');
    expect(field).toHaveAccessibleDescription('This can be changed later');
  });

  it('shows no budget caption while Read is chosen', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.queryByText(/allocate them a budget/)).not.toBeInTheDocument();
  });

  it('shows the budget caption once Write is chosen', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-privilege-write'));

    expect(
      screen.getByText('To let link guests send messages, allocate them a budget in Budgets.')
    ).toBeInTheDocument();
  });

  it('shows warning text about link security', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-warning')).toHaveTextContent(
      'Anyone with this link can decrypt'
    );
  });

  it('renders the link-security warning on a raised surface, not as a muted hint', () => {
    render(<InviteLinkModal {...defaultProps} />);

    const warning = screen.getByTestId('invite-link-warning');
    expect(warning).toHaveClass('bg-muted');
    expect(warning).not.toHaveClass('text-muted-foreground');
  });

  it('announces the link-security warning politely rather than interrupting', () => {
    render(<InviteLinkModal {...defaultProps} />);

    expect(screen.getByTestId('invite-link-warning')).toHaveAttribute('role', 'status');
  });

  it('calls createSharedLink and useCreateLink on generate', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockCreateSharedLink).toHaveBeenCalledWith(defaultProps.currentEpochKey.privateKey, {
      conversationId: defaultProps.conversationId,
      epochNumber: defaultProps.currentEpochKey.epochNumber,
    });
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

  it("submits the new link's auth hash on the no-history mutation", async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ linkAuthHash: 'link-auth-hash-b64', giveFullHistory: false })
    );
  });

  it("submits the new link's auth hash on the full-history mutation", async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ linkAuthHash: 'link-auth-hash-b64', giveFullHistory: true })
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

    await userEvent.click(screen.getByTestId('invite-link-privilege-write'));
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(expect.objectContaining({ privilege: 'write' }));
  });

  it('includes a trimmed display name on the no-history mutation when a guest name is entered', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.type(screen.getByTestId('invite-link-name-input'), '  Guest Bob  ');
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Guest Bob', giveFullHistory: false })
    );
  });

  it('includes a trimmed display name on the full-history mutation when a guest name is entered', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.type(screen.getByTestId('invite-link-name-input'), 'Guest Bob');
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Guest Bob', giveFullHistory: true })
    );
  });

  it('builds the rotation member set including the new link public key', async () => {
    let capturedMembers: unknown;
    mockExecuteWithRotation.mockImplementationOnce((async (input: {
      execute: (r: unknown) => Promise<unknown>;
      filterMembers: (keys: { publicKey: string }[]) => unknown;
    }) => {
      capturedMembers = input.filterMembers([{ publicKey: 'AQID' }]);
      await input.execute(mockRotationResult.params);
      return mockRotationResult;
    }) as unknown as Parameters<typeof mockExecuteWithRotation.mockImplementationOnce>[0]);

    render(<InviteLinkModal {...defaultProps} />);
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    // One existing member's key plus the freshly-generated link key.
    expect(Array.isArray(capturedMembers)).toBe(true);
    expect(capturedMembers as unknown[]).toHaveLength(2);
  });

  it('closes the modal from the generated phase Done button', async () => {
    const onOpenChange = vi.fn();
    render(<InviteLinkModal {...defaultProps} onOpenChange={onOpenChange} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));
    await screen.findByRole('button', { name: 'Done' });
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
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

    expect(screen.getByTestId('invite-link-copy-button')).toHaveAccessibleName('Copied');
  });

  it('does not acknowledge the copy when the clipboard write fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard refused')) },
      writable: true,
      configurable: true,
    });

    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));
    await userEvent.click(screen.getByTestId('invite-link-copy-button'));

    expect(screen.getByTestId('invite-link-copy-button')).not.toHaveAccessibleName('Copied');
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

  it('puts Cancel before Generate Link', () => {
    render(<InviteLinkModal {...defaultProps} />);

    const generateButton = screen.getByTestId('invite-link-generate-button');
    const cancelButton = screen.getByTestId('invite-link-cancel-button');

    expect(generateButton.parentElement).toBe(cancelButton.parentElement);
    expect(cancelButton.compareDocumentPosition(generateButton)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  describe('pressing Enter in the guest name field', () => {
    function pressEnter(): void {
      const nameInput = screen.getByTestId('invite-link-name-input');
      nameInput.focus();
      act(() => {
        nameInput.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
      });
    }

    it('creates one link when pressed twice while the create is pending', async () => {
      mockMutateAsync.mockReturnValue(
        new Promise(() => {
          // Never settles: the create stays pending for the whole test.
        })
      );
      render(<InviteLinkModal {...defaultProps} />);

      pressEnter();
      await waitFor(() => {
        expect(screen.getByTestId('invite-link-generate-button')).toBeDisabled();
      });
      pressEnter();

      await waitFor(() => {
        expect(mockMutateAsync).toHaveBeenCalledTimes(1);
      });
      expect(mockCreateSharedLink).toHaveBeenCalledTimes(1);
    });

    it('creates no link at the member cap', async () => {
      render(<InviteLinkModal {...defaultProps} memberCount={MAX_CONVERSATION_MEMBERS} />);

      pressEnter();

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockCreateSharedLink).not.toHaveBeenCalled();
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });
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
      expect(mockCreateSharedLink).toHaveBeenCalledWith(defaultProps.currentEpochKey.privateKey, {
        conversationId: defaultProps.conversationId,
        epochNumber: defaultProps.currentEpochKey.epochNumber,
      });
    });
    expect(mockMutateAsync).toHaveBeenCalled();
  });

  describe('with no verified current-epoch key', () => {
    const keylessProps = { ...defaultProps, currentEpochKey: undefined };

    it('explains that link changes wait on verified keys', async () => {
      render(<InviteLinkModal {...keylessProps} />);

      await userEvent.click(screen.getByTestId('invite-link-generate-button'));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        friendlyErrorMessage('EPOCH_KEYS_RESTORING')
      );
    });

    it('creates no link', async () => {
      render(<InviteLinkModal {...keylessProps} />);

      await userEvent.click(screen.getByTestId('invite-link-generate-button'));

      await screen.findByRole('alert');
      expect(mockCreateSharedLink).not.toHaveBeenCalled();
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });

    it('creates no link when full history is chosen', async () => {
      render(<InviteLinkModal {...keylessProps} />);

      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByTestId('invite-link-generate-button'));

      await screen.findByRole('alert');
      expect(mockCreateSharedLink).not.toHaveBeenCalled();
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });
  });

  describe('with a verified current-epoch key under a bad verdict', () => {
    beforeEach(() => {
      mockGetEpochVerdict.mockReturnValue(verdictOf('bad'));
    });

    it('explains that link changes wait on verified keys', async () => {
      render(<InviteLinkModal {...defaultProps} />);

      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByTestId('invite-link-generate-button'));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        friendlyErrorMessage('EPOCH_KEYS_RESTORING')
      );
    });

    it('creates no link when full history is chosen', async () => {
      render(<InviteLinkModal {...defaultProps} />);

      await userEvent.click(screen.getByRole('checkbox'));
      await userEvent.click(screen.getByTestId('invite-link-generate-button'));

      await screen.findByRole('alert');
      expect(mockCreateSharedLink).not.toHaveBeenCalled();
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });
  });

  it('creates a full-history link under an ok verdict', async () => {
    mockGetEpochVerdict.mockReturnValue(verdictOf('ok'));
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ giveFullHistory: true, expectedEpoch: 1 })
      );
    });
  });

  it('uses executeWithRotation for no-history link creation', async () => {
    render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(mockExecuteWithRotation).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-123',
        currentEpochPrivateKey: defaultProps.currentEpochKey.privateKey,
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

  it('shows fresh Copy state when reopened after a prior copy', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });

    const { rerender } = render(<InviteLinkModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));
    await userEvent.click(screen.getByTestId('invite-link-copy-button'));
    expect(screen.getByTestId('invite-link-copy-button')).toHaveAccessibleName('Copied');

    rerender(<InviteLinkModal {...defaultProps} open={false} />);
    rerender(<InviteLinkModal {...defaultProps} open={true} />);

    await userEvent.click(screen.getByTestId('invite-link-generate-button'));

    expect(screen.getByTestId('invite-link-copy-button')).toHaveAccessibleName('Copy link');
    expect(screen.getByTestId('invite-link-copy-button')).not.toHaveAccessibleName('Copied');
  });

  it('reverts to Copy after the reset timeout elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<InviteLinkModal {...defaultProps} />);

    await user.click(screen.getByTestId('invite-link-generate-button'));
    await user.click(screen.getByTestId('invite-link-copy-button'));
    expect(screen.getByTestId('invite-link-copy-button')).toHaveAccessibleName('Copied');

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId('invite-link-copy-button')).toHaveAccessibleName('Copy link');
    expect(screen.getByTestId('invite-link-copy-button')).not.toHaveAccessibleName('Copied');

    vi.useRealTimers();
  });

  it('clears the copy-reset timer on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = render(<InviteLinkModal {...defaultProps} />);

    await user.click(screen.getByTestId('invite-link-generate-button'));
    setSpy.mockClear();
    await user.click(screen.getByTestId('invite-link-copy-button'));

    const copyTimerResult = setSpy.mock.results[
      setSpy.mock.calls.findIndex((args) => args[1] === 3000)
    ] as { value: ReturnType<typeof setTimeout> } | undefined;
    expect(copyTimerResult).toBeDefined();

    unmount();

    expect(clearSpy).toHaveBeenCalledWith(copyTimerResult!.value);

    vi.useRealTimers();
  });

  describe('once the link is created', () => {
    async function createLink(choices: { write?: boolean; history?: boolean } = {}): Promise<void> {
      render(<InviteLinkModal {...defaultProps} />);
      if (choices.write === true) {
        await userEvent.click(screen.getByTestId('invite-link-privilege-write'));
      }
      if (choices.history === true) {
        await userEvent.click(screen.getByTestId('invite-link-history-checkbox'));
      }
      await userEvent.click(screen.getByTestId('invite-link-generate-button'));
      await screen.findByTestId('invite-link-url');
    }

    it('is titled Link created', async () => {
      await createLink();

      expect(screen.getByRole('dialog')).toHaveAccessibleName('Link created');
    });

    it.each([
      [{}, 'Anyone who opens it can read Test Chat from now on.'],
      [{ write: true }, 'Anyone who opens it can read and send messages in Test Chat from now on.'],
      [{ history: true }, 'Anyone who opens it can read Test Chat, including its history.'],
      [
        { write: true, history: true },
        'Anyone who opens it can read and send messages in Test Chat, including its history.',
      ],
    ])('describes what the link allows for %o', async (choices, description) => {
      await createLink(choices);

      expect(screen.getByText(description)).toBeInTheDocument();
    });

    it('labels the link Invite link', async () => {
      await createLink();

      expect(screen.getByRole('group', { name: 'Invite link' })).toContainElement(
        screen.getByTestId('invite-link-url')
      );
    });

    it('sets the link in the mono face', async () => {
      await createLink();

      expect(screen.getByTestId('invite-link-url')).toHaveClass('font-mono');
    });

    it('says the link must be sent whole', async () => {
      await createLink();

      expect(screen.getByRole('group', { name: 'Invite link' })).toHaveAccessibleDescription(
        'Send it whole. Everything after the # is the key; a shortened or edited link will not open.'
      );
    });

    it('says where the link is managed', async () => {
      await createLink();

      expect(
        screen.getByText('You can change what it allows, or revoke it, from the member list.')
      ).toBeInTheDocument();
    });

    it('copies with an icon button named Copy link', async () => {
      await createLink();

      const copyButton = screen.getByTestId('invite-link-copy-button');
      expect(copyButton).toHaveAccessibleName('Copy link');
      expect(copyButton).toHaveTextContent('');
    });

    it('copies the whole URL', async () => {
      const writeText = vi.fn((): Promise<void> => Promise.resolve());
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        writable: true,
        configurable: true,
      });
      await createLink();

      await userEvent.click(screen.getByTestId('invite-link-copy-button'));

      expect(writeText).toHaveBeenCalledWith(
        `${globalThis.location.origin}/share/c/conv-123#link-secret-b64`
      );
    });

    it('ends with Done as its one action', async () => {
      await createLink();

      const doneButton = screen.getByRole('button', { name: 'Done' });
      const actions = [...doneButton.parentElement!.querySelectorAll('button')];
      expect(actions).toEqual([doneButton]);
    });
  });
});
