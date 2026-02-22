import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useNavigate } from '@tanstack/react-router';
import { signIn, resetPasswordViaRecovery } from '@/lib/auth';
import { LoginPage } from './login';

// Mock TanStack Router
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => vi.fn()),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
  useNavigate: vi.fn(() => vi.fn()),
}));

// Mock auth client
vi.mock('@/lib/auth', () => ({
  signIn: {
    email: vi.fn(),
  },
  resetPasswordViaRecovery: vi.fn(),
}));

// Mock UI components
vi.mock('@hushbox/ui', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  Input: ({
    label,
    id,
    ...props
  }: { label?: string; id?: string } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      {label && <label htmlFor={id}>{label}</label>}
      <input id={id} {...props} />
    </div>
  ),
  Checkbox: ({
    id,
    checked,
    onCheckedChange,
  }: {
    id?: string;
    checked?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e: React.ChangeEvent<HTMLInputElement>) => onCheckedChange?.(e.target.checked)}
    />
  ),
}));

// Mock FormInput
vi.mock('@/components/shared/form-input', () => ({
  FormInput: ({
    label,
    id,
    error,
    success,
    ...props
  }: {
    label: string;
    id?: string;
    error?: string;
    success?: string;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input id={id} {...props} />
      {error && <span role="alert">{error}</span>}
      {success && id && <span data-testid={`${id}-success`}>{success}</span>}
    </div>
  ),
}));

// Mock AuthPasswordInput
vi.mock('@/components/auth/AuthPasswordInput', () => ({
  AuthPasswordInput: ({
    label,
    id,
    error,
    success,
    showStrength,
    ...props
  }: {
    label: string;
    id?: string;
    error?: string;
    success?: string;
    showStrength?: boolean;
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label htmlFor={id}>{label}</label>
      <input type="password" id={id} {...props} />
      {error && <span role="alert">{error}</span>}
      {success && id && <span data-testid={`${id}-success`}>{success}</span>}
      {showStrength && id && <span data-testid={`${id}-strength`}>strength</span>}
    </div>
  ),
}));

// Mock AuthButton
vi.mock('@/components/auth/AuthButton', () => ({
  AuthButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

// Mock TwoFactorInput
vi.mock('@/components/auth/TwoFactorInput', () => ({
  TwoFactorInput: ({
    open,
    onVerify,
    onSuccess,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSuccess: () => void;
    onVerify: (code: string) => Promise<{ success: boolean; error?: string }>;
  }) =>
    open ? (
      <div data-testid="two-factor-modal">
        <button
          data-testid="verify-2fa-btn"
          onClick={() => {
            void (async () => {
              const result = await onVerify('123456');
              if (result.success) onSuccess();
            })();
          }}
        >
          Verify
        </button>
      </div>
    ) : null,
}));

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders login form with identifier and password fields', () => {
    render(<LoginPage />);

    expect(screen.getByLabelText(/email or username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
  });

  it('renders signup link', () => {
    render(<LoginPage />);

    expect(screen.getByRole('link', { name: /sign up/i })).toHaveAttribute('href', '/signup');
  });

  it('validates identifier format on submit', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    // Hyphens invalid in both email and username
    await user.type(screen.getByLabelText(/email or username/i), 'invalid-input');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).not.toHaveBeenCalled();
  });

  it('validates required fields on submit', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).not.toHaveBeenCalled();
  });

  it('calls signIn.email with valid credentials', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).toHaveBeenCalledWith({
      identifier: 'test@example.com',
      password: 'password123',
      keepSignedIn: false,
    });
  });

  it('calls signIn.email with valid username', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'alice');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).toHaveBeenCalledWith({
      identifier: 'alice',
      password: 'password123',
      keepSignedIn: false,
    });
  });

  it('shows inline error on authentication failure', async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      error: { message: 'Invalid credentials' },
    });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    const errorAlert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent === 'Invalid credentials');
    expect(errorAlert).toBeInTheDocument();
  });

  it('shows fallback error message when error has no message', async () => {
    vi.mocked(signIn.email).mockResolvedValue({
      error: { message: 'Authentication failed' },
    });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    const errorAlert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent === 'Authentication failed');
    expect(errorAlert).toBeInTheDocument();
  });

  it('shows success message when identifier is valid as user types', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');

    expect(screen.getByTestId('identifier-success')).toHaveTextContent('Valid');
  });

  it('shows error message when identifier is invalid as user types', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'a');

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid email or username');
  });

  it('shows 2FA modal when requires2FA is true', async () => {
    const mockVerifyTOTP = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(signIn.email).mockResolvedValue({
      requires2FA: true,
      verifyTOTP: mockVerifyTOTP,
    });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(screen.getByTestId('two-factor-modal')).toBeInTheDocument();
  });

  it('navigates to chat after successful 2FA verification', async () => {
    const mockNavigate = vi.fn();
    vi.mocked(useNavigate).mockReturnValue(mockNavigate);

    const mockVerifyTOTP = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(signIn.email).mockResolvedValue({
      requires2FA: true,
      verifyTOTP: mockVerifyTOTP,
    });
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));
    await user.click(screen.getByTestId('verify-2fa-btn'));

    expect(mockVerifyTOTP).toHaveBeenCalledWith('123456');
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
  });

  it('does not show 2FA modal for normal login', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(screen.queryByTestId('two-factor-modal')).not.toBeInTheDocument();
  });

  it('shows "Keep me signed in" checkbox unchecked by default', () => {
    render(<LoginPage />);

    const checkbox = screen.getByLabelText(/keep me signed in/i);
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it('passes keepSignedIn=false to signIn.email when checkbox is unchecked', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).toHaveBeenCalledWith({
      identifier: 'test@example.com',
      password: 'password123',
      keepSignedIn: false,
    });
  });

  it('passes keepSignedIn=true to signIn.email when checkbox is checked', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    render(<LoginPage />);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText(/password/i), 'password123');
    await user.click(screen.getByLabelText(/keep me signed in/i));
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).toHaveBeenCalledWith({
      identifier: 'test@example.com',
      password: 'password123',
      keepSignedIn: true,
    });
  });

  describe('Enter key navigation', () => {
    it('Enter on identifier field focuses password field', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      const identifier = screen.getByLabelText(/email or username/i);
      await user.click(identifier);
      await user.keyboard('{Enter}');

      expect(screen.getByLabelText(/password/i)).toHaveFocus();
    });

    it('Enter on password field submits the login form', async () => {
      vi.mocked(signIn.email).mockResolvedValue({});
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
      await user.type(screen.getByLabelText(/password/i), 'password123');
      await user.keyboard('{Enter}');

      expect(signIn.email).toHaveBeenCalledWith({
        identifier: 'test@example.com',
        password: 'password123',
        keepSignedIn: false,
      });
    });
  });

  describe('Password Recovery Flow', () => {
    it('shows "Forgot password?" link on login page', () => {
      render(<LoginPage />);

      expect(screen.getByRole('button', { name: /forgot password/i })).toBeInTheDocument();
    });

    it('clicking "Forgot password?" shows recovery phrase form', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    });

    it('"Back to login" link returns to login form', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      expect(screen.getByText(/reset password/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /back to login/i }));

      expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
    });

    it('pre-fills email from login form when switching to recovery mode', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      expect(screen.getByLabelText(/email/i)).toHaveValue('test@example.com');
    });

    it('submitting recovery phrase shows new password form', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reset password/i })).toBeInTheDocument();
    });

    it('shows success message after successful password reset', async () => {
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      expect(resetPasswordViaRecovery).toHaveBeenCalledWith(
        'test@example.com',
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        'newpassword123'
      );
      expect(screen.getByText(/password reset successful/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /return to login/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /return to login/i }));
      expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
    });

    it('shows error message on failed recovery', async () => {
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({
        success: false,
        error: 'Invalid recovery phrase',
      });
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'wrong phrase but it has twelve words total for the validation check'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Invalid recovery phrase');
      expect(errorAlert).toBeInTheDocument();
    });

    it('does not submit when password is too short', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'short');
      await user.type(screen.getByLabelText(/confirm password/i), 'short');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      expect(resetPasswordViaRecovery).not.toHaveBeenCalled();
      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Password must be at least 8 characters');
      expect(errorAlert).toBeInTheDocument();
    });

    it('does not submit when passwords do not match', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'password123');
      await user.type(screen.getByLabelText(/confirm password/i), 'different456');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      expect(resetPasswordViaRecovery).not.toHaveBeenCalled();
      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Passwords do not match');
      expect(errorAlert).toBeInTheDocument();
    });

    it('shows strength indicator on new password field', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByTestId('new-password-strength')).toBeInTheDocument();
    });

    it('"Back to recovery" link on Create New Password returns to recovery phrase form', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByText(/create new password/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /back to recovery/i }));

      expect(screen.getByText(/reset password/i)).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)
      ).toBeInTheDocument();
    });

    it('"Back to login" button on recovery phrase form has pointer cursor', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      const backButton = screen.getByRole('button', { name: /back to login/i });
      expect(backButton.className).toContain('cursor-pointer');
    });

    describe('Recovery Phrase Form Validation', () => {
      it('blocks Next when email is empty', async () => {
        const user = userEvent.setup();
        render(<LoginPage />);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
        );
        await user.click(screen.getByRole('button', { name: /next/i }));

        // Should still be on recovery phrase form, not new password form
        expect(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)
        ).toBeInTheDocument();
        expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument();
      });

      it('shows recovery phrase validation error when clicking Next with invalid phrase', async () => {
        const user = userEvent.setup();
        render(<LoginPage />);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(screen.getByLabelText(/email/i), 'test@example.com');
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          'only three words'
        );
        await user.click(screen.getByRole('button', { name: /next/i }));

        expect(screen.getByText('Recovery phrase must be exactly 12 words')).toBeInTheDocument();
        // Should still be on recovery phrase form
        expect(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)
        ).toBeInTheDocument();
        expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument();
      });

      it('proceeds to new password form with valid email and valid 12-word phrase', async () => {
        const user = userEvent.setup();
        render(<LoginPage />);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(screen.getByLabelText(/email/i), 'test@example.com');
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
        );
        await user.click(screen.getByRole('button', { name: /next/i }));

        expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
      });

      it('shows success message when valid 12-word phrase is entered', async () => {
        const user = userEvent.setup();
        render(<LoginPage />);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
        );

        expect(screen.getByText('12 words entered')).toBeInTheDocument();
      });
    });

    it('Enter on new password field focuses confirm password field', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      const newPassword = screen.getByLabelText(/^new password$/i);
      await user.click(newPassword);
      await user.keyboard('{Enter}');

      expect(screen.getByLabelText(/confirm password/i)).toHaveFocus();
    });

    it('Enter on confirm password submits recovery password reset', async () => {
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.keyboard('{Enter}');

      expect(resetPasswordViaRecovery).toHaveBeenCalledWith(
        'test@example.com',
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        'newpassword123'
      );
    });

    it('Enter on email field in recovery phrase form advances to new password step', async () => {
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );

      // Focus email and press Enter — should trigger handleNext via requestSubmit
      await user.click(screen.getByLabelText(/email/i));
      await user.keyboard('{Enter}');

      expect(screen.getByText(/create new password/i)).toBeInTheDocument();
    });

    it('shows error message when resetPasswordViaRecovery throws', async () => {
      vi.mocked(resetPasswordViaRecovery).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      render(<LoginPage />);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Password reset failed. Please try again.');
      expect(errorAlert).toBeInTheDocument();
    });
  });
});
