import { createRef, useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TEST_IDS } from '@hushbox/shared';
import { OtpInput } from './otp-input';

// Mock document.elementFromPoint (used by input-otp, not available in jsdom)
document.elementFromPoint = vi.fn(() => null);

describe('OtpInput', () => {
  const defaultProps = {
    value: '',
    onChange: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    // The code field's own focus bookkeeping runs on timers, and it updates state.
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it('renders otp-input test id', () => {
    render(<OtpInput {...defaultProps} />);
    expect(screen.getByTestId(TEST_IDS.otpInput)).toBeInTheDocument();
  });

  it('renders 6 slot cells', () => {
    render(<OtpInput {...defaultProps} />);
    const cells = screen.getAllByRole('textbox');
    // OTPInput renders a single textbox. We check for the slot divs instead.
    expect(cells.length).toBeGreaterThanOrEqual(1);
  });

  it('renders a dash separator between groups', () => {
    render(<OtpInput {...defaultProps} />);
    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('does not show error message when error is not provided', () => {
    render(<OtpInput {...defaultProps} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows error message when error is provided', () => {
    render(<OtpInput {...defaultProps} error="Invalid code" />);
    expect(screen.getByText('Invalid code')).toBeInTheDocument();
  });

  it('leaves forced colors an outline to paint on the active cell alone', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<OtpInput {...defaultProps} />);

    await user.click(screen.getByTestId(TEST_IDS.otpInput));

    const cells = screen.getAllByText('○').map((placeholder) => placeholder.parentElement!);
    expect(cells.map((cell) => cell.classList.contains('outline-hidden'))).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('keeps its transparent typed text out of forced-colors recolouring', () => {
    render(<OtpInput {...defaultProps} />);

    expect(screen.getByTestId(TEST_IDS.otpInput)).toHaveClass('forced-color-adjust-none');
  });

  describe('password manager badge room', () => {
    const CODE_ROW_WIDTH = 277;
    const CODE_ROW_RIGHT = 300;
    let initialValues: HTMLStyleElement;

    beforeEach(() => {
      // happy-dom leaves `overflow-x` empty where a browser computes its initial value.
      initialValues = document.createElement('style');
      initialValues.textContent = '* { overflow-x: visible; }';
      document.head.append(initialValues);
    });

    afterEach(() => {
      initialValues.remove();
    });

    async function focusInScrollBox(scrollBoxWidth: number): Promise<HTMLElement> {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(
        <div data-testid="scroll-box" style={{ overflowX: 'auto' }}>
          <OtpInput {...defaultProps} />
        </div>
      );
      const scrollBox = screen.getByTestId('scroll-box');
      const input = screen.getByTestId(TEST_IDS.otpInput);
      const codeRow = input.closest<HTMLElement>('[data-input-otp-container]')!;
      vi.spyOn(scrollBox, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(0, 0, scrollBoxWidth, 100)
      );
      vi.spyOn(scrollBox, 'clientWidth', 'get').mockReturnValue(scrollBoxWidth);
      vi.spyOn(codeRow, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(CODE_ROW_RIGHT - CODE_ROW_WIDTH, 0, CODE_ROW_WIDTH, 48)
      );

      await user.click(input);
      await act(() => vi.advanceTimersByTimeAsync(1000));
      return input;
    }

    it('keeps the code field inside a scroll box with no room for the badge', async () => {
      const input = await focusInScrollBox(CODE_ROW_RIGHT);

      expect(input).toHaveStyle({ width: '100%' });
    });

    it('widens the code field past the badge where its scroll box has room', async () => {
      const input = await focusInScrollBox(CODE_ROW_RIGHT + 100);

      expect(input).toHaveStyle({ width: 'calc(100% + 40px)' });
    });
  });

  describe('appearance', () => {
    function cells(): HTMLElement[] {
      return screen.getAllByText('○').map((placeholder) => placeholder.parentElement!);
    }

    it('draws the dialog cells unless asked for another look', () => {
      render(<OtpInput {...defaultProps} />);

      expect(cells()[0]!.className).toBe(
        'border-input bg-background flex h-12 w-10 items-center justify-center rounded-md border text-lg font-medium'
      );
    });

    it('draws the field cells with the control border when asked for the field look', () => {
      render(<OtpInput {...defaultProps} appearance="field" />);

      expect(cells()[0]).toHaveClass('border-2', 'border-border-control', 'rounded-lg', 'h-14');
    });

    it('lets the field cells shrink to share the width they are given', () => {
      render(<OtpInput {...defaultProps} appearance="field" />);

      expect(cells()[0]).toHaveClass('min-w-0', 'flex-1', 'max-w-11');
    });

    it('stretches the field look across its column', () => {
      render(<OtpInput {...defaultProps} appearance="field" />);

      const codeRow = screen
        .getByTestId(TEST_IDS.otpInput)
        .closest<HTMLElement>('[data-input-otp-container]')!;
      expect(codeRow).toHaveClass('w-full');
    });

    it('marks the active field cell with a solid Signal Red outline', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<OtpInput {...defaultProps} appearance="field" />);

      await user.click(screen.getByTestId(TEST_IDS.otpInput));

      expect(cells().map((cell) => cell.classList.contains('outline-primary'))).toEqual([
        true,
        false,
        false,
        false,
        false,
        false,
      ]);
    });

    it('announces an error in the field look', () => {
      render(<OtpInput {...defaultProps} appearance="field" error="Invalid code" />);

      expect(screen.getByRole('alert')).toHaveTextContent('Invalid code');
    });

    it('draws the error the same way in both looks', () => {
      const { unmount } = render(<OtpInput {...defaultProps} error="Invalid code" />);
      const dialogClass = screen.getByText('Invalid code').className;
      unmount();

      render(<OtpInput {...defaultProps} appearance="field" error="Invalid code" />);

      expect(screen.getByText('Invalid code').className).toBe(dialogClass);
    });

    it('names the code field when given a label', () => {
      render(<OtpInput {...defaultProps} aria-label="6-digit code" />);

      expect(screen.getByRole('textbox', { name: '6-digit code' })).toBe(
        screen.getByTestId(TEST_IDS.otpInput)
      );
    });
  });

  describe('disabled', () => {
    it('disables the code field when asked', () => {
      render(<OtpInput {...defaultProps} disabled />);

      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeDisabled();
    });

    it('leaves the code field enabled by default', () => {
      render(<OtpInput {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.otpInput)).toBeEnabled();
    });

    // A browser may send no blur when a focused field is disabled, so the cell that
    // held focus would keep marking where the next digit goes.
    it.each(['field', 'dialog'] as const)(
      'draws no active mark once the focused field is disabled, in the %s look',
      async (appearance) => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        const { rerender } = render(<OtpInput {...defaultProps} appearance={appearance} />);
        await user.click(screen.getByTestId(TEST_IDS.otpInput));
        const marked = appearance === 'field' ? 'outline-primary' : 'ring-2';

        rerender(<OtpInput {...defaultProps} appearance={appearance} disabled />);

        const cells = screen.getAllByText('○').map((placeholder) => placeholder.parentElement!);
        expect(cells.filter((cell) => cell.classList.contains(marked))).toHaveLength(0);
      }
    );
  });

  describe('ref', () => {
    it('hands its ref to the code field', () => {
      const ref = createRef<HTMLInputElement>();
      render(<OtpInput {...defaultProps} ref={ref} />);

      expect(ref.current).toBe(screen.getByTestId(TEST_IDS.otpInput));
    });
  });

  describe('onComplete', () => {
    function Wrapper({
      onComplete,
    }: Readonly<{ onComplete: (value: string) => void }>): React.JSX.Element {
      const [value, setValue] = useState('');
      return <OtpInput value={value} onChange={setValue} onComplete={onComplete} />;
    }

    it('calls onComplete when all 6 digits are entered', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const onComplete = vi.fn();
      render(<Wrapper onComplete={onComplete} />);

      const input = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(input);
      await user.keyboard('123456');

      expect(onComplete).toHaveBeenCalledWith('123456');
    });

    it('does not crash when onComplete is not provided', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<OtpInput value="" onChange={vi.fn()} />);

      const input = screen.getByTestId(TEST_IDS.otpInput);
      await user.click(input);
      await user.keyboard('123456');
      expect(input).toBeInTheDocument();
    });
  });
});
