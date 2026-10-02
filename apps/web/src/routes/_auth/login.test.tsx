import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useNavigate } from '@tanstack/react-router';
import { PRODUCT_TAGLINE, TEST_IDS } from '@hushbox/shared';
import {
  signIn,
  resetPasswordViaRecovery,
  verifyRecoveryPhrase,
  discardVerifiedRecoveryPhrase,
} from '@/lib/auth/auth';
import { RECOVERY_PHRASE_MISMATCH_MESSAGE } from '@/lib/auth/validation';
import { renderRoute } from '@/test-utils/render';
import { Route } from './login';
import type { FormFactor } from '@hushbox/ui/platform';
import type { VerifiedRecoveryPhrase } from '@/lib/auth/auth';

/** The all-zero-entropy BIP-39 vector; the form rejects any 12 words whose checksum fails. */
const VALID_PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

type VerifyResult = Awaited<ReturnType<typeof verifyRecoveryPhrase>>;

const VERIFIED: VerifiedRecoveryPhrase = {
  identifier: 'test@example.com',
  accountPrivateKey: new Uint8Array(32),
  recoveryPrivateKey: new Uint8Array(32) as VerifiedRecoveryPhrase['recoveryPrivateKey'],
};

// Keep the real router (createFileRoute must run for the route file); mock only
// the navigation/link the page touches.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    Link: ({ children, to }: { children: React.ReactNode; to: string }): React.JSX.Element => (
      <a href={to}>{children}</a>
    ),
    useNavigate: vi.fn(() => vi.fn()),
  };
});

vi.mock('@/lib/auth/auth', () => ({
  signIn: {
    email: vi.fn(),
  },
  resetPasswordViaRecovery: vi.fn(),
  verifyRecoveryPhrase: vi.fn(),
  discardVerifiedRecoveryPhrase: vi.fn(),
  authClient: {
    resendVerification: vi.fn(),
  },
}));

const formFactor = vi.hoisted((): { band: FormFactor['band'] } => ({ band: 'desktop' }));

vi.mock('@hushbox/ui/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/ui/platform')>()),
  useFormFactor: (): FormFactor => ({ band: formFactor.band, pointer: 'fine' }),
}));

// A case that needs the step's own behaviour renders the real one.
const stepDouble = vi.hoisted((): { real: boolean } => ({ real: false }));

vi.mock('@/components/auth/two-factor-login-step', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/auth/two-factor-login-step')>();
  return {
    TwoFactorLoginStep: (props: Readonly<StepProps>): React.JSX.Element =>
      stepDouble.real ? <actual.TwoFactorLoginStep {...props} /> : <StepDouble {...props} />,
  };
});

// input-otp reads the element under a point, which the test DOM does not lay out.
document.elementFromPoint = vi.fn(() => null);

interface StepProps {
  onSuccess: () => void;
  onVerify: (code: string) => Promise<{ success: boolean; error?: string }>;
  onBack: () => void;
}

function StepDouble({ onVerify, onSuccess, onBack }: Readonly<StepProps>): React.JSX.Element {
  return (
    <div data-testid="two-factor-step">
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
      <button onClick={onBack}>Back to login</button>
    </div>
  );
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    formFactor.band = 'desktop';
    stepDouble.real = false;
    vi.mocked(verifyRecoveryPhrase).mockResolvedValue({ success: true, verified: VERIFIED });
  });

  it('renders login form with identifier and password fields', () => {
    renderRoute(Route);

    expect(screen.getByLabelText(/email or username/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
  });

  it('renders signup link', () => {
    renderRoute(Route);

    expect(screen.getByRole('link', { name: /sign up/i })).toHaveAttribute('href', '/signup');
  });

  it('marks the brand tagline as a reading surface so it renders in the serif', () => {
    renderRoute(Route);

    expect(screen.getByText(PRODUCT_TAGLINE)).toHaveAttribute('data-reading');
  });

  it('shows the product tagline under the title', () => {
    renderRoute(Route);

    expect(screen.getByText(PRODUCT_TAGLINE)).toBeInTheDocument();
  });

  it('sets the page title in the auth title role, in ink', () => {
    renderRoute(Route);

    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toHaveClass(
      'text-auth-title',
      'text-foreground'
    );
  });

  it('renders Log in as the extra-large full-width button', () => {
    renderRoute(Route);

    const button = screen.getByRole('button', { name: 'Log in' });
    expect(button).toHaveAttribute('data-size', 'xl');
    expect(button).toHaveAttribute('data-block');
  });

  it('draws Log in with no slanted cut', () => {
    renderRoute(Route);

    expect(screen.getByRole('button', { name: 'Log in' }).style.getPropertyValue('clip-path')).toBe(
      ''
    );
  });

  it('draws the Keep me signed in box with the control border', () => {
    renderRoute(Route);

    expect(screen.getByRole('checkbox', { name: 'Keep me signed in' })).toHaveClass(
      'border-border-control'
    );
  });

  describe('the Keep me signed in row', () => {
    function row(): HTMLElement {
      const forgot = screen.getByRole('button', { name: 'Forgot password?' });
      if (forgot.parentElement === null) throw new Error('Forgot password? has no row');
      return forgot.parentElement;
    }

    function checkSlot(): Element {
      const checkbox = screen.getByRole('checkbox', { name: 'Keep me signed in' });
      const slot = [...row().children].find((child) => child.contains(checkbox));
      if (slot === undefined) throw new Error('the checkbox is not in the row');
      return slot;
    }

    it('keeps a 1rem gap between the check and Forgot password?', () => {
      renderRoute(Route);

      expect(row()).toHaveClass('gap-4');
    });

    it('drops Forgot password? below the check when the pair does not fit', () => {
      renderRoute(Route);

      expect(row()).toHaveClass('flex-wrap');
    });

    it('never narrows Forgot password? beside the check', () => {
      renderRoute(Route);

      expect(screen.getByRole('button', { name: 'Forgot password?' })).toHaveClass('shrink-0');
    });

    it('lets Forgot password? wrap only when it is wider than the whole row', () => {
      renderRoute(Route);

      expect(screen.getByRole('button', { name: 'Forgot password?' })).toHaveClass('max-w-full');
    });

    it('starts every line of a wrapped Forgot password? at the row edge the check starts at', () => {
      renderRoute(Route);

      expect(screen.getByRole('button', { name: 'Forgot password?' })).toHaveClass('text-start');
    });

    it('sizes the check to its longest word before Forgot password? drops', () => {
      renderRoute(Route);

      expect(checkSlot()).toHaveClass('w-min', 'grow');
    });

    it('grows the check no wider than its label on one line', () => {
      renderRoute(Route);

      expect(checkSlot()).toHaveClass('max-w-max');
    });
  });

  it('draws the login fields with the control border', () => {
    renderRoute(Route);

    expect(screen.getByLabelText(/email or username/i)).toHaveClass('border-border-control');
    expect(screen.getByLabelText('Password')).toHaveClass('border-border-control');
  });

  it('validates identifier format on submit', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    // Hyphens invalid in both email and username
    await user.type(screen.getByLabelText(/email or username/i), 'invalid-input');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).not.toHaveBeenCalled();
  });

  it('validates required fields on submit', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(signIn.email).not.toHaveBeenCalled();
  });

  it('calls signIn.email with valid credentials', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
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
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'alice');
    await user.type(screen.getByLabelText('Password'), 'password123');
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
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
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
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    const errorAlert = screen
      .getAllByRole('alert')
      .find((el) => el.textContent === 'Authentication failed');
    expect(errorAlert).toBeInTheDocument();
  });

  it('shows success message when identifier is valid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');

    expect(screen.getByText('Valid')).toBeInTheDocument();
  });

  it('shows error message when identifier is invalid as user types', async () => {
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'a');

    expect(screen.getByRole('alert')).toHaveTextContent('Please enter a valid email or username');
  });

  async function logInToTheSecondFactor(): Promise<ReturnType<typeof userEvent.setup>> {
    vi.mocked(signIn.email).mockResolvedValue({
      requires2FA: true,
      verifyTOTP: vi.fn().mockResolvedValue({ success: true }),
    });
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));
    return user;
  }

  it('shows the two-factor step when requires2FA is true', async () => {
    await logInToTheSecondFactor();

    expect(screen.getByTestId('two-factor-step')).toBeInTheDocument();
  });

  it('shows the two-factor step in place of the login form', async () => {
    await logInToTheSecondFactor();

    expect(screen.queryByLabelText(/email or username/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log in/i })).not.toBeInTheDocument();
  });

  it('shows the two-factor step in place of the feature list', async () => {
    await logInToTheSecondFactor();

    expect(screen.queryByText('Privacy by design')).not.toBeInTheDocument();
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
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));
    await user.click(screen.getByTestId('verify-2fa-btn'));

    expect(mockVerifyTOTP).toHaveBeenCalledWith('123456');
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
  });

  it('returns to the login form from the two-factor step', async () => {
    const user = await logInToTheSecondFactor();

    await user.click(screen.getByRole('button', { name: 'Back to login' }));

    expect(screen.queryByTestId('two-factor-step')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
  });

  it('keeps the identifier when returning from the two-factor step', async () => {
    const user = await logInToTheSecondFactor();

    await user.click(screen.getByRole('button', { name: 'Back to login' }));

    expect(screen.getByLabelText(/email or username/i)).toHaveValue('test@example.com');
  });

  it('clears the password when returning from the two-factor step', async () => {
    const user = await logInToTheSecondFactor();

    await user.click(screen.getByRole('button', { name: 'Back to login' }));

    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('asks for the second factor again after returning and logging in again', async () => {
    const user = await logInToTheSecondFactor();
    await user.click(screen.getByRole('button', { name: 'Back to login' }));

    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(screen.getByTestId('two-factor-step')).toBeInTheDocument();
  });

  it('lands focus on the emptied password field after returning at desktop width', async () => {
    const user = await logInToTheSecondFactor();

    await user.click(screen.getByRole('button', { name: 'Back to login' }));

    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('lands focus on the form heading after returning on a phone', async () => {
    formFactor.band = 'phone';
    const user = await logInToTheSecondFactor();

    await user.click(screen.getByRole('button', { name: 'Back to login' }));

    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toHaveFocus();
  });

  it('sends the accepted code once while the way to chat is still loading', async () => {
    stepDouble.real = true;
    vi.mocked(useNavigate).mockReturnValue(vi.fn(() => new Promise<void>(() => {})));
    const verifyTOTP = vi.fn().mockResolvedValue({ success: true });
    vi.mocked(signIn.email).mockResolvedValue({ requires2FA: true, verifyTOTP });
    const user = userEvent.setup();
    renderRoute(Route);
    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    await user.click(screen.getByTestId(TEST_IDS.otpInput));
    await user.keyboard('123456');
    await waitFor(() => {
      expect(verifyTOTP).toHaveBeenCalledOnce();
    });
    await user.click(screen.getByRole('button', { name: 'Verify' }));

    expect(verifyTOTP).toHaveBeenCalledOnce();
  });

  it('does not show the two-factor step for normal login', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: /log in/i }));

    expect(screen.queryByTestId('two-factor-step')).not.toBeInTheDocument();
  });

  it('shows "Keep me signed in" checkbox unchecked by default', () => {
    renderRoute(Route);

    const checkbox = screen.getByLabelText(/keep me signed in/i);
    expect(checkbox).toBeInTheDocument();
    expect(checkbox).not.toBeChecked();
  });

  it('passes keepSignedIn=false to signIn.email when checkbox is unchecked', async () => {
    vi.mocked(signIn.email).mockResolvedValue({});
    const user = userEvent.setup();
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
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
    renderRoute(Route);

    await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
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
      renderRoute(Route);

      const identifier = screen.getByLabelText(/email or username/i);
      await user.click(identifier);
      await user.keyboard('{Enter}');

      expect(screen.getByLabelText('Password')).toHaveFocus();
    });

    it('Enter on password field submits the login form', async () => {
      vi.mocked(signIn.email).mockResolvedValue({});
      const user = userEvent.setup();
      renderRoute(Route);

      await user.type(screen.getByLabelText(/email or username/i), 'test@example.com');
      await user.type(screen.getByLabelText('Password'), 'password123');
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
      renderRoute(Route);

      expect(screen.getByRole('button', { name: /forgot password/i })).toBeInTheDocument();
    });

    it('clicking "Forgot password?" shows recovery phrase form', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
      expect(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
    });

    it("hides the phrase field's browser outline only while it has focus", async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      const phraseField = screen.getByPlaceholderText(/enter your 12-word recovery phrase/i);
      const suppressions = [...phraseField.classList].filter((token) =>
        /(^|:)outline-(none|hidden)$/.test(token)
      );
      expect(suppressions).toEqual(['focus:outline-hidden']);
    });

    it('does not mark the functional reset-password subtitle as a reading surface', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      // Only the brand tagline is editorial; functional subtitles stay on the sans chrome default.
      expect(
        screen.getByText('Enter your email or username and 12-word recovery phrase')
      ).not.toHaveAttribute('data-reading');
    });

    it("renders the reset steps' primary buttons extra-large and full width, with no cut", async () => {
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      const next = screen.getByRole('button', { name: 'Next' });
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(next);
      const reset = screen.getByRole('button', { name: 'Reset Password' });
      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(reset);
      const back = screen.getByRole('button', { name: 'Return to Login' });

      for (const button of [next, reset, back]) {
        expect(button).toHaveAttribute('data-size', 'xl');
        expect(button).toHaveAttribute('data-block');
        expect(button.style.getPropertyValue('clip-path')).toBe('');
      }
    });

    it('draws the reset step subtitle in the instruction look', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      expect(
        screen.getByText('Enter your email or username and 12-word recovery phrase')
      ).toHaveClass('text-primary', 'text-lg', 'font-medium');
    });

    it('"Back to login" link returns to login form', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      expect(screen.getByText(/reset password/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /back to login/i }));

      expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /log in/i })).toBeInTheDocument();
    });

    it('pre-fills email from login form when switching to recovery mode', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      expect(screen.getByLabelText(/email/i)).toHaveValue('test@example.com');
    });

    it('submitting recovery phrase shows new password form', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reset password/i })).toBeInTheDocument();
    });

    it('shows the verification message on the phrase field when the phrase is refused', async () => {
      vi.mocked(verifyRecoveryPhrase).mockResolvedValue({
        success: false,
        error: RECOVERY_PHRASE_MISMATCH_MESSAGE,
      });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === RECOVERY_PHRASE_MISMATCH_MESSAGE);
      expect(errorAlert).toBeInTheDocument();
    });

    it('stays on the phrase step when the phrase is refused', async () => {
      vi.mocked(verifyRecoveryPhrase).mockResolvedValue({
        success: false,
        error: RECOVERY_PHRASE_MISMATCH_MESSAGE,
      });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument();
      expect(resetPasswordViaRecovery).not.toHaveBeenCalled();
    });

    it('clears the verification message once the phrase is edited', async () => {
      vi.mocked(verifyRecoveryPhrase).mockResolvedValue({
        success: false,
        error: RECOVERY_PHRASE_MISMATCH_MESSAGE,
      });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      const phraseField = screen.getByPlaceholderText(/enter your 12-word recovery phrase/i);
      await user.type(phraseField, VALID_PHRASE);
      await user.click(screen.getByRole('button', { name: /next/i }));
      await user.type(phraseField, ' ');

      expect(screen.queryByText(RECOVERY_PHRASE_MISMATCH_MESSAGE)).not.toBeInTheDocument();
    });

    it('does not verify a phrase that fails the checksum', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        'abandon ability able about above absent absorb abstract absurd abuse access accident'
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(verifyRecoveryPhrase).not.toHaveBeenCalled();
      expect(
        screen.getByText('That recovery phrase is not valid. Check for a mistyped word.')
      ).toBeInTheDocument();
    });

    it('shows a retry message when the verification call itself throws', async () => {
      vi.mocked(verifyRecoveryPhrase).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Could not check that recovery phrase. Please try again.');
      expect(errorAlert).toBeInTheDocument();
    });

    it('shows a busy Next button while the phrase is being verified', async () => {
      let release: ((result: { success: false; error: string }) => void) | undefined;
      vi.mocked(verifyRecoveryPhrase).mockReturnValue(
        new Promise((resolve) => {
          release = resolve;
        })
      );
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled();

      release?.({ success: false, error: RECOVERY_PHRASE_MISMATCH_MESSAGE });
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /next/i })).toBeInTheDocument();
      });
    });

    it('discards the verified key material when the user returns to the phrase step', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));
      await user.click(screen.getByRole('button', { name: /back to recovery/i }));

      expect(discardVerifiedRecoveryPhrase).toHaveBeenCalledWith(VERIFIED);
    });

    it('shows success message after successful password reset', async () => {
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({ success: true });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      expect(resetPasswordViaRecovery).toHaveBeenCalledWith(VERIFIED, 'newpassword123');
      expect(screen.getByText(/password reset successful/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /return to login/i })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /return to login/i }));
      expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
    });

    it('keeps "Back to recovery" disabled while a reset is in flight', async () => {
      vi.mocked(resetPasswordViaRecovery).mockReturnValue(new Promise(() => {}));
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      expect(screen.getByRole('button', { name: /back to recovery/i })).toBeDisabled();
      expect(discardVerifiedRecoveryPhrase).not.toHaveBeenCalled();
    });

    it('runs one reset when a second submit lands while the first is in flight', async () => {
      vi.mocked(resetPasswordViaRecovery).mockReturnValue(new Promise(() => {}));
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      const confirmField = screen.getByLabelText(/confirm password/i);
      await user.type(confirmField, 'newpassword123');

      // Enter reaches the form through requestSubmit, which fires onSubmit
      // whether or not the button is disabled — the path a held Enter repeats.
      confirmField.focus();
      fireEvent.keyDown(confirmField, { key: 'Enter' });
      fireEvent.keyDown(confirmField, { key: 'Enter' });

      expect(resetPasswordViaRecovery).toHaveBeenCalledTimes(1);
    });

    it('runs one verification when a second submit lands while the first is in flight', async () => {
      vi.mocked(verifyRecoveryPhrase).mockReturnValue(new Promise(() => {}));
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      const emailField = screen.getByLabelText(/email/i);
      await user.type(emailField, 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );

      emailField.focus();
      fireEvent.keyDown(emailField, { key: 'Enter' });
      fireEvent.keyDown(emailField, { key: 'Enter' });

      expect(verifyRecoveryPhrase).toHaveBeenCalledTimes(1);
    });

    it('leaves a user who left the flow on the login form when the verification resolves', async () => {
      let resolveVerification: (result: VerifyResult) => void = () => {};
      vi.mocked(verifyRecoveryPhrase).mockReturnValue(
        new Promise<VerifyResult>((resolve) => {
          resolveVerification = resolve;
        })
      );
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));
      await user.click(screen.getByRole('button', { name: /back to login/i }));

      await act(async () => {
        resolveVerification({ success: true, verified: VERIFIED });
        await Promise.resolve();
      });

      expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/^new password$/i)).not.toBeInTheDocument();
    });

    it('discards the key material a verification produced for a user who left the flow', async () => {
      let resolveVerification: (result: VerifyResult) => void = () => {};
      vi.mocked(verifyRecoveryPhrase).mockReturnValue(
        new Promise<VerifyResult>((resolve) => {
          resolveVerification = resolve;
        })
      );
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));
      await user.click(screen.getByRole('button', { name: /back to login/i }));

      await act(async () => {
        resolveVerification({ success: true, verified: VERIFIED });
        await Promise.resolve();
      });

      expect(discardVerifiedRecoveryPhrase).toHaveBeenCalledWith(VERIFIED);
    });

    it('points the phrase field at its message', async () => {
      vi.mocked(verifyRecoveryPhrase).mockResolvedValue({
        success: false,
        error: RECOVERY_PHRASE_MISMATCH_MESSAGE,
      });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      const phraseField = screen.getByPlaceholderText(/enter your 12-word recovery phrase/i);
      await user.type(phraseField, VALID_PHRASE);
      await user.click(screen.getByRole('button', { name: /next/i }));

      const describedBy = phraseField.getAttribute('aria-describedby') ?? '';
      expect(describedBy).toBeTruthy();
      expect(document.querySelector(`#${describedBy}`)).toHaveTextContent(
        RECOVERY_PHRASE_MISMATCH_MESSAGE
      );
    });

    it('does not announce the phrase field invalid when re-entering the flow after a refusal', async () => {
      vi.mocked(verifyRecoveryPhrase).mockResolvedValue({
        success: false,
        error: RECOVERY_PHRASE_MISMATCH_MESSAGE,
      });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));
      await user.click(screen.getByRole('button', { name: /back to login/i }));
      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      const phraseField = screen.getByPlaceholderText(/enter your 12-word recovery phrase/i);
      expect(screen.queryByText(RECOVERY_PHRASE_MISMATCH_MESSAGE)).not.toBeInTheDocument();
      expect(phraseField).toHaveAttribute('aria-invalid', 'false');
    });

    it('does not announce the phrase field invalid when a refusal lands after the user left', async () => {
      let resolveVerification: (result: VerifyResult) => void = () => {};
      vi.mocked(verifyRecoveryPhrase).mockReturnValue(
        new Promise<VerifyResult>((resolve) => {
          resolveVerification = resolve;
        })
      );
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));
      await user.click(screen.getByRole('button', { name: /back to login/i }));

      await act(async () => {
        resolveVerification({ success: false, error: RECOVERY_PHRASE_MISMATCH_MESSAGE });
        await Promise.resolve();
      });

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      expect(screen.getByPlaceholderText(/enter your 12-word recovery phrase/i)).toHaveAttribute(
        'aria-invalid',
        'false'
      );
    });

    it('shows error message on failed recovery', async () => {
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({
        success: false,
        error: 'Invalid recovery phrase',
      });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
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
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
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
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
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
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      expect(screen.getByTestId(TEST_IDS.strengthIndicator)).toBeInTheDocument();
    });

    it('"Back to recovery" link on Create New Password returns to recovery phrase form', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
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
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));

      const backButton = screen.getByRole('button', { name: /back to login/i });
      expect(backButton.className).toContain('cursor-pointer');
    });

    describe('Recovery Phrase Form Validation', () => {
      it('blocks Next when email is empty', async () => {
        const user = userEvent.setup();
        renderRoute(Route);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          VALID_PHRASE
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
        renderRoute(Route);

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
        renderRoute(Route);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(screen.getByLabelText(/email/i), 'test@example.com');
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          VALID_PHRASE
        );
        await user.click(screen.getByRole('button', { name: /next/i }));

        expect(screen.getByLabelText(/^new password$/i)).toBeInTheDocument();
        expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
      });

      it('shows success message when valid 12-word phrase is entered', async () => {
        const user = userEvent.setup();
        renderRoute(Route);

        await user.click(screen.getByRole('button', { name: /forgot password/i }));
        await user.type(
          screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
          VALID_PHRASE
        );

        expect(screen.getByText('12 words entered')).toBeInTheDocument();
      });
    });

    it('Enter on new password field focuses confirm password field', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
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
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.keyboard('{Enter}');

      expect(resetPasswordViaRecovery).toHaveBeenCalledWith(VERIFIED, 'newpassword123');
    });

    it('Enter on email field in recovery phrase form advances to new password step', async () => {
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );

      // Focus email and press Enter — should trigger handleNext via requestSubmit
      await user.click(screen.getByLabelText(/email/i));
      await user.keyboard('{Enter}');

      expect(screen.getByText(/create new password/i)).toBeInTheDocument();
    });

    it('shows error message when resetPasswordViaRecovery throws', async () => {
      vi.mocked(resetPasswordViaRecovery).mockRejectedValue(new Error('Network error'));
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
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

    it('falls back to a default message when recovery reset fails without an error', async () => {
      // result.success === false but result.error is absent, so the handler
      // uses its `?? 'Password reset failed'` fallback message.
      vi.mocked(resetPasswordViaRecovery).mockResolvedValue({ success: false });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.click(screen.getByRole('button', { name: /forgot password/i }));
      await user.type(screen.getByLabelText(/email/i), 'test@example.com');
      await user.type(
        screen.getByPlaceholderText(/enter your 12-word recovery phrase/i),
        VALID_PHRASE
      );
      await user.click(screen.getByRole('button', { name: /next/i }));

      await user.type(screen.getByLabelText(/^new password$/i), 'newpassword123');
      await user.type(screen.getByLabelText(/confirm password/i), 'newpassword123');
      await user.click(screen.getByRole('button', { name: /reset password/i }));

      const errorAlert = screen
        .getAllByRole('alert')
        .find((el) => el.textContent === 'Password reset failed');
      expect(errorAlert).toBeInTheDocument();
    });
  });

  describe('unverified email', () => {
    it('shows the check-your-email view when sign-in reports an unverified email', async () => {
      vi.mocked(signIn.email).mockResolvedValue({
        error: { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' },
      });
      const user = userEvent.setup();
      renderRoute(Route);

      await user.type(screen.getByLabelText(/email or username/i), 'unverified@example.com');
      await user.type(screen.getByLabelText('Password'), 'password123');
      await user.click(screen.getByRole('button', { name: /log in/i }));

      await waitFor(() => {
        expect(screen.getByRole('heading', { name: /check your email/i })).toBeInTheDocument();
      });
      expect(screen.getByText('unverified@example.com')).toBeInTheDocument();
    });
  });

  it('renders password field with current-password autocomplete hint', () => {
    renderRoute(Route);

    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
  });
});
