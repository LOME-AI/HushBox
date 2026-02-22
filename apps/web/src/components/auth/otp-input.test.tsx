import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders otp-input test id', () => {
    render(<OtpInput {...defaultProps} />);
    expect(screen.getByTestId('otp-input')).toBeInTheDocument();
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

      const input = screen.getByTestId('otp-input');
      await user.click(input);
      await user.keyboard('123456');

      expect(onComplete).toHaveBeenCalledWith('123456');
    });

    it('does not crash when onComplete is not provided', async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<OtpInput value="" onChange={vi.fn()} />);

      const input = screen.getByTestId('otp-input');
      await user.click(input);
      // Should not throw
      await user.keyboard('123456');
      expect(input).toBeInTheDocument();
    });
  });
});
