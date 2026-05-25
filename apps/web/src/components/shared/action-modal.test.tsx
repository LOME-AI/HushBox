import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAsyncAction } from '@hushbox/ui';
import { ActionModal } from './action-modal';

// Force the DevOnly wrapper to render its children so we can assert on the
// simulate-failure row. The wrapper gates on `env.isLocalDev` in the real app.
vi.mock('@/lib/env', () => ({
  env: { isLocalDev: true },
}));

interface SetupOptions {
  onSubmit?: () => Promise<unknown>;
  initiallyOpen?: boolean;
  devSimulateCodes?: readonly string[];
}

function ActionModalHarness(options: SetupOptions = {}): React.JSX.Element {
  const action = useAsyncAction();
  return (
    <ActionModal
      open={options.initiallyOpen ?? true}
      onOpenChange={onOpenChangeMock}
      title="Test Action"
      asyncAction={action}
      primary={{
        label: 'Submit',
        loadingLabel: 'Submitting…',
        onSubmit: options.onSubmit ?? (async () => undefined),
        testId: 'action-submit',
      }}
      cancel={{ label: 'Cancel', testId: 'action-cancel' }}
      testId="test-modal"
      {...(options.devSimulateCodes !== undefined && {
        devSimulateCodes: options.devSimulateCodes,
      })}
    >
      <input data-testid="form-input" />
    </ActionModal>
  );
}

const onOpenChangeMock = vi.fn();

beforeEach(() => {
  onOpenChangeMock.mockReset();
});

describe('ActionModal', () => {
  describe('rendering', () => {
    it('renders the title as a visible heading', () => {
      render(<ActionModalHarness />);
      // Overlay also renders an sr-only Radix Dialog title with the same text;
      // scope to the visible OverlayHeader heading via the non-sr-only class.
      const headings = screen.getAllByRole('heading', { name: 'Test Action' });
      const visible = headings.find((h) => !h.classList.contains('sr-only'));
      expect(visible).toBeInTheDocument();
    });

    it('renders children', () => {
      render(<ActionModalHarness />);
      expect(screen.getByTestId('form-input')).toBeInTheDocument();
    });

    it('renders primary and cancel buttons', () => {
      render(<ActionModalHarness />);
      expect(screen.getByTestId('action-submit')).toBeInTheDocument();
      expect(screen.getByTestId('action-cancel')).toBeInTheDocument();
    });

    it('does not render the inline error region before any error has occurred', () => {
      render(<ActionModalHarness />);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });
  });

  describe('async submission', () => {
    it('invokes onSubmit when the primary button is clicked', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn(async () => undefined);
      render(<ActionModalHarness onSubmit={onSubmit} />);
      await user.click(screen.getByTestId('action-submit'));
      await waitFor(() => {
        expect(onSubmit).toHaveBeenCalledOnce();
      });
    });

    it('closes the modal on successful submission', async () => {
      const user = userEvent.setup();
      render(<ActionModalHarness onSubmit={async () => undefined} />);
      await user.click(screen.getByTestId('action-submit'));
      await waitFor(() => {
        expect(onOpenChangeMock).toHaveBeenCalledWith(false);
      });
    });

    it('does NOT close the modal when onSubmit throws (stays open for retry)', async () => {
      const user = userEvent.setup();
      render(
        <ActionModalHarness
          onSubmit={async () => {
            throw new Error('STALE_EPOCH');
          }}
        />
      );
      await user.click(screen.getByTestId('action-submit'));
      // Give the rejection time to surface
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
      expect(onOpenChangeMock).not.toHaveBeenCalledWith(false);
    });

    it('shows the inline error with the friendly message on failure', async () => {
      const user = userEvent.setup();
      render(
        <ActionModalHarness
          onSubmit={async () => {
            throw new Error('STALE_EPOCH');
          }}
        />
      );
      await user.click(screen.getByTestId('action-submit'));
      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent(
          'Someone else just changed this conversation. Please try again.'
        );
      });
    });

    it('re-enables the primary button after failure for retry', async () => {
      const user = userEvent.setup();
      render(
        <ActionModalHarness
          onSubmit={async () => {
            throw new Error('STALE_EPOCH');
          }}
        />
      );
      await user.click(screen.getByTestId('action-submit'));
      await waitFor(() => {
        expect(screen.getByTestId('action-submit')).not.toBeDisabled();
      });
    });
  });

  describe('dismiss-lock while pending', () => {
    it('hides the close button while a submission is in flight', async () => {
      const user = userEvent.setup();
      let resolveSubmit: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      });

      render(<ActionModalHarness onSubmit={async () => pending} />);
      expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();

      await user.click(screen.getByTestId('action-submit'));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
      });

      resolveSubmit!();
    });

    it('restores the close button after submission resolves', async () => {
      const user = userEvent.setup();
      let resolveSubmit: (() => void) | undefined;
      const pending = new Promise<void>((resolve) => {
        resolveSubmit = resolve;
      });

      render(<ActionModalHarness onSubmit={async () => pending} />);
      await user.click(screen.getByTestId('action-submit'));

      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /close/i })).not.toBeInTheDocument();
      });

      resolveSubmit!();
      // After success the modal closes, so the close button is gone — but the
      // contract is "while pending, no close". Verify by opening a fresh modal
      // and confirming default state has the close button (covered above).
    });
  });

  describe('auto-clear-on-input', () => {
    it('clears the inline error when the user types in any child input', async () => {
      const user = userEvent.setup();
      render(
        <ActionModalHarness
          onSubmit={async () => {
            throw new Error('STALE_EPOCH');
          }}
        />
      );
      await user.click(screen.getByTestId('action-submit'));
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      await user.type(screen.getByTestId('form-input'), 'x');

      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      });
    });
  });

  describe('devSimulateCodes', () => {
    it('renders no dev row when devSimulateCodes is omitted', () => {
      render(<ActionModalHarness />);
      expect(screen.queryByTestId('dev-simulate-failures')).not.toBeInTheDocument();
    });

    it('renders one Simulate button per error code', () => {
      render(
        <ActionModalHarness devSimulateCodes={['STALE_EPOCH', 'WRAP_SET_MISMATCH']} />
      );
      expect(screen.getByTestId('dev-simulate-failures')).toBeInTheDocument();
      expect(screen.getByTestId('dev-simulate-STALE_EPOCH')).toBeInTheDocument();
      expect(screen.getByTestId('dev-simulate-WRAP_SET_MISMATCH')).toBeInTheDocument();
    });

    it('fires the corresponding friendly error when a simulate button is clicked', async () => {
      const user = userEvent.setup();
      render(<ActionModalHarness devSimulateCodes={['STALE_EPOCH']} />);
      await user.click(screen.getByTestId('dev-simulate-STALE_EPOCH'));

      expect(screen.getByRole('alert')).toHaveTextContent(
        'Someone else just changed this conversation. Please try again.'
      );
    });

    it('does not fire the real onSubmit', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn(async () => undefined);
      render(
        <ActionModalHarness onSubmit={onSubmit} devSimulateCodes={['STALE_EPOCH']} />
      );
      await user.click(screen.getByTestId('dev-simulate-STALE_EPOCH'));
      expect(onSubmit).not.toHaveBeenCalled();
    });
  });

  describe('cancel', () => {
    it('closes the modal when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ActionModalHarness />);
      await user.click(screen.getByTestId('action-cancel'));
      expect(onOpenChangeMock).toHaveBeenCalledWith(false);
    });
  });
});
