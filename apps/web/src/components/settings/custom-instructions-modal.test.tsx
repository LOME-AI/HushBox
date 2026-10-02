import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { friendlyErrorMessage } from '@hushbox/shared';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { client } from '@/lib/api-client';
import { CustomInstructionsModal } from './custom-instructions-modal';

const { mockGetState, mockEncryptMessageForStorage, mockGetPublicKeyFromPrivate, mockFetchJson } =
  vi.hoisted(() => ({
    mockGetState: vi.fn(),
    mockEncryptMessageForStorage: vi.fn(() => new Uint8Array([1, 2, 3])),
    mockGetPublicKeyFromPrivate: vi.fn(() => new Uint8Array([10, 20, 30])),
    mockFetchJson: vi.fn(),
  }));

// The predicate comes from the real module rather than a second copy here: a
// mock that re-implemented it would agree with production only until one of
// them changed.
vi.mock('@/lib/auth/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth')>();
  return {
    selectInstructionsReadUnresolved: actual.selectInstructionsReadUnresolved,
    useAuthStore: Object.assign(
      (selector: (s: Record<string, unknown>) => unknown) => selector(mockGetState()),
      { getState: mockGetState }
    ),
  };
});

vi.mock('@hushbox/crypto', () => ({
  encryptCustomInstructions: (...args: unknown[]) =>
    (mockEncryptMessageForStorage as (...a: unknown[]) => unknown)(...args),
  getPublicKeyFromPrivate: (...args: unknown[]) =>
    (mockGetPublicKeyFromPrivate as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('@/lib/api-client', () => ({
  client: {
    account: {
      instructions: {
        $put: vi.fn(() => Promise.resolve(new Response())),
        $delete: vi.fn(() => Promise.resolve(new Response())),
      },
    },
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

vi.mock('@hushbox/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/shared')>()),
  toBase64: (bytes: Uint8Array) => Buffer.from(bytes).toString('base64'),
}));

const DEMO_USER_ID = testUuidV7(1);

describe('CustomInstructionsModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onSuccess: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetState.mockReturnValue({
      customInstructions: null,
      customInstructionsStatus: 'absent',
      privateKey: new Uint8Array([99, 100, 101]),
      user: { id: DEMO_USER_ID },
      setCustomInstructions: vi.fn(),
    });
    mockFetchJson.mockResolvedValue({ success: true });
  });

  describe('rendering', () => {
    it('renders nothing when open is false', () => {
      render(<CustomInstructionsModal {...defaultProps} open={false} />);

      expect(screen.queryByRole('heading', { name: 'Custom instructions' })).toBeNull();
    });

    it('titles the dialog "Custom instructions"', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('heading', { name: 'Custom instructions' })).toBeInTheDocument();
    });

    it('carries no intro paragraph', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.queryByText(/included in every conversation/i)).toBeNull();
    });

    it('labels the textarea with the question it answers', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(
        screen.getByRole('textbox', { name: 'What should every model know?' })
      ).toBeInTheDocument();
    });

    it('grows the textarea between 8rem and 18rem, then scrolls it', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('textbox')).toHaveClass(
        'min-h-32',
        'max-h-72',
        'overflow-y-auto',
        'resize-none'
      );
    });

    it('shows no placeholder in the textarea', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('textbox')).not.toHaveAttribute('placeholder');
    });

    it('describes the textarea with its help line', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('textbox')).toHaveAccessibleDescription(
        expect.stringContaining('For example, your work, your tone, units, or languages.')
      );
    });

    it('renders character counter showing 0 / 5,000 when empty', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByText('0 / 5,000')).toBeTruthy();
    });

    it('describes the textarea with its count', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('textbox')).toHaveAccessibleDescription(
        expect.stringContaining('0 / 5,000')
      );
    });

    it('states where the instructions are kept, led by a lock', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      const line = screen.getByText(
        'Saved encrypted with a key only your devices hold. AI providers retain nothing.'
      );
      expect(line.querySelector('svg.lucide-lock')).not.toBeNull();
    });

    it('starts the trust line at the line start, not centred', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      const line = screen.getByText(
        'Saved encrypted with a key only your devices hold. AI providers retain nothing.'
      );
      expect(line).toHaveClass('text-start');
      expect(line).not.toHaveClass('text-center');
    });

    it('loads existing custom instructions from auth store', () => {
      mockGetState.mockReturnValue({
        customInstructions: 'Be concise',
        customInstructionsStatus: 'present',
        privateKey: new Uint8Array([99, 100, 101]),
        user: { id: DEMO_USER_ID },
        setCustomInstructions: vi.fn(),
      });

      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('textbox')).toHaveValue('Be concise');
      expect(screen.getByText('10 / 5,000')).toBeTruthy();
    });

    it('renders a Save button', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    });

    it('renders a Cancel button', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });
  });

  describe('cancel', () => {
    it('closes the dialog', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      await userEvent.type(screen.getByRole('textbox'), 'Be helpful');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
    });

    it('sends nothing', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      await userEvent.type(screen.getByRole('textbox'), 'Be helpful');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it('encrypts nothing', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      await userEvent.type(screen.getByRole('textbox'), 'Be helpful');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockEncryptMessageForStorage).not.toHaveBeenCalled();
    });

    it('leaves the stored instructions untouched', async () => {
      const mockSetCustomInstructions = vi.fn();
      mockGetState.mockReturnValue({
        customInstructions: null,
        customInstructionsStatus: 'absent',
        privateKey: new Uint8Array([99, 100, 101]),
        user: { id: DEMO_USER_ID },
        setCustomInstructions: mockSetCustomInstructions,
      });
      render(<CustomInstructionsModal {...defaultProps} />);

      await userEvent.type(screen.getByRole('textbox'), 'Be helpful');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(mockSetCustomInstructions).not.toHaveBeenCalled();
      expect(defaultProps.onSuccess).not.toHaveBeenCalled();
    });
  });

  describe('character limit', () => {
    it('updates character count as user types', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.type(textarea, 'Hello');

      expect(screen.getByText('5 / 5,000')).toBeTruthy();
    });

    it('does not block typing past the limit with a native maxLength', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      expect(textarea).not.toHaveAttribute('maxLength');
    });

    it('keeps every character typed past the limit', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5001) } });

      expect(screen.getByRole('textbox')).toHaveValue('x'.repeat(5001));
    });

    it('reports the field invalid over the limit', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5001) } });

      expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
    });

    it('reports the field valid at the limit', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5000) } });

      expect(screen.getByRole('textbox')).not.toHaveAttribute('aria-invalid', 'true');
    });

    it('counts past the limit', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5001) } });

      expect(screen.getByText('5,001 / 5,000')).toBeInTheDocument();
    });

    it('shows the truncation notice when the value exceeds the limit', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5001) } });

      expect(screen.getByText('Only the first 5,000 characters will be used.')).toBeInTheDocument();
    });
  });

  describe('save flow', () => {
    it('encrypts and saves instructions on submit', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.type(textarea, 'Be helpful');

      const saveButton = screen.getByRole('button', { name: /save/i });
      fireEvent.click(saveButton);

      await waitFor(() => {
        expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(
          new Uint8Array([10, 20, 30]),
          'Be helpful',
          DEMO_USER_ID
        );
      });

      expect(mockFetchJson).toHaveBeenCalled();
    });

    it('calls onSuccess and updates auth store on successful save', async () => {
      const mockSetCustomInstructions = vi.fn();
      mockGetState.mockReturnValue({
        customInstructions: null,
        customInstructionsStatus: 'absent',
        privateKey: new Uint8Array([99, 100, 101]),
        user: { id: DEMO_USER_ID },
        setCustomInstructions: mockSetCustomInstructions,
      });

      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.type(textarea, 'Be helpful');

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(defaultProps.onSuccess).toHaveBeenCalled();
      });

      expect(mockSetCustomInstructions).toHaveBeenCalledWith('Be helpful');
    });

    it('saves null when textarea is empty (clears instructions)', async () => {
      mockGetState.mockReturnValue({
        customInstructions: 'Old instructions',
        customInstructionsStatus: 'present',
        privateKey: new Uint8Array([99, 100, 101]),
        user: { id: DEMO_USER_ID },
        setCustomInstructions: vi.fn(),
      });

      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.clear(textarea);

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockFetchJson).toHaveBeenCalled();
      });

      expect(mockEncryptMessageForStorage).not.toHaveBeenCalled();
    });

    it('puts the encrypted instructions as base64', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      await userEvent.type(screen.getByRole('textbox'), 'Be helpful');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(client.account.instructions.$put).toHaveBeenCalledWith({
          json: { instructions: Buffer.from([1, 2, 3]).toString('base64') },
        });
      });
      expect(client.account.instructions.$delete).not.toHaveBeenCalled();
    });

    it('deletes the stored instructions when saved empty', async () => {
      mockGetState.mockReturnValue({
        customInstructions: 'Old instructions',
        customInstructionsStatus: 'present',
        privateKey: new Uint8Array([99, 100, 101]),
        user: { id: DEMO_USER_ID },
        setCustomInstructions: vi.fn(),
      });
      render(<CustomInstructionsModal {...defaultProps} />);

      await userEvent.clear(screen.getByRole('textbox'));
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(client.account.instructions.$delete).toHaveBeenCalledWith();
      });
      expect(client.account.instructions.$put).not.toHaveBeenCalled();
    });

    it('encrypts only the first 5000 characters when the value is over the limit', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(5005) } });

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockEncryptMessageForStorage).toHaveBeenCalledWith(
          new Uint8Array([10, 20, 30]),
          'x'.repeat(5000),
          DEMO_USER_ID
        );
      });
    });

    it('shows error message on save failure', async () => {
      mockFetchJson.mockRejectedValue({ code: 'INTERNAL' });

      render(<CustomInstructionsModal {...defaultProps} />);

      const textarea = screen.getByRole('textbox');
      await userEvent.type(textarea, 'Be helpful');

      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(screen.getByText(/failed to save/i)).toBeTruthy();
      });
    });

    it('shows an error when the account private key is unavailable', async () => {
      // Non-empty instructions but no private key: exercises the `if (!privateKey)` guard.
      mockGetState.mockReturnValue({
        customInstructions: null,
        customInstructionsStatus: 'absent',
        privateKey: null,
        user: { id: DEMO_USER_ID },
        setCustomInstructions: vi.fn(),
      });

      render(<CustomInstructionsModal {...defaultProps} />);

      await userEvent.type(screen.getByRole('textbox'), 'Be helpful');
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE'))
        ).toBeInTheDocument();
      });
      expect(mockEncryptMessageForStorage).not.toHaveBeenCalled();
    });

    it('shows an error when no signed-in user is available to bind the blob to', async () => {
      mockGetState.mockReturnValue({
        customInstructions: null,
        customInstructionsStatus: 'absent',
        privateKey: new Uint8Array([99, 100, 101]),
        user: null,
        setCustomInstructions: vi.fn(),
      });

      render(<CustomInstructionsModal {...defaultProps} />);

      await userEvent.type(screen.getByRole('textbox'), 'Be helpful');
      fireEvent.click(screen.getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(
          screen.getByText(friendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE'))
        ).toBeInTheDocument();
      });
      expect(mockEncryptMessageForStorage).not.toHaveBeenCalled();
    });
  });

  describe('state reset', () => {
    it('resets textarea to stored value when modal reopens', () => {
      mockGetState.mockReturnValue({
        customInstructions: 'Stored value',
        customInstructionsStatus: 'present',
        privateKey: new Uint8Array([99, 100, 101]),
        setCustomInstructions: vi.fn(),
      });

      const { rerender } = render(<CustomInstructionsModal {...defaultProps} open={false} />);

      rerender(<CustomInstructionsModal {...defaultProps} open={true} />);

      expect(screen.getByRole('textbox')).toHaveValue('Stored value');
    });
  });

  describe('while the account instruction read is unresolved', () => {
    beforeEach(() => {
      mockGetState.mockReturnValue({
        customInstructions: null,
        customInstructionsStatus: 'pending',
        privateKey: new Uint8Array([99, 100, 101]),
        user: { id: DEMO_USER_ID },
        setCustomInstructions: vi.fn(),
      });
    });

    it('offers no editable box, so nothing is seeded from a value that says nothing', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.queryByRole('textbox')).toBeNull();
    });

    it('says the stored instruction is still loading', () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByText(/loading your saved instructions/i)).toBeInTheDocument();
    });

    it('refuses the save that would delete the stored blob', async () => {
      render(<CustomInstructionsModal {...defaultProps} />);

      const saveButton = screen.getByRole('button', { name: /save/i });
      expect(saveButton).toBeDisabled();

      fireEvent.click(saveButton);
      await waitFor(() => {
        expect(mockFetchJson).not.toHaveBeenCalled();
      });
    });

    it('seeds the box from the instruction that lands while the modal is open', () => {
      // Withholding the editor until the read resolves is what makes this state reachable:
      // the value lands with no box on screen, and the box that follows must already hold it.
      const { rerender } = render(<CustomInstructionsModal {...defaultProps} />);
      expect(screen.queryByRole('textbox')).toBeNull();

      mockGetState.mockReturnValue({
        customInstructions: 'Be concise',
        customInstructionsStatus: 'present',
        privateKey: new Uint8Array([99, 100, 101]),
        user: { id: DEMO_USER_ID },
        setCustomInstructions: vi.fn(),
      });
      rerender(<CustomInstructionsModal {...defaultProps} />);

      expect(screen.getByRole('textbox')).toHaveValue('Be concise');
    });
  });
});
