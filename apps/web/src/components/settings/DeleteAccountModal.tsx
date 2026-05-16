import * as React from 'react';
import { useState, useCallback, useMemo, useRef } from 'react';
import {
  Alert,
  Checkbox,
  Input,
  Label,
  ModalActions,
  Overlay,
  OverlayContent,
  OverlayHeader,
} from '@hushbox/ui';
import {
  createOpaqueClient,
  startLogin,
  finishLogin,
  OPAQUE_SERVER_IDENTIFIER,
} from '@hushbox/crypto';
import { friendlyErrorMessage, MARKETING_BASE_URL } from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/use-form-enter-nav';
import { useMobileAutoFocus } from '@/hooks/use-mobile-auto-focus';
import { useDeleteAccountInit, useDeleteAccountFinish } from '@/hooks/useDeleteAccount';
import { useBalance } from '@/hooks/billing';
import { useAuthStore } from '@/lib/auth';
import { queryClient } from '@/providers/query-provider';
import { AuthPasswordInput } from '@/components/auth/AuthPasswordInput';
import { OtpInput } from '@/components/auth/otp-input';

interface DeleteAccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 'intro' | 'wallet' | 'password' | 'totp' | 'final';

const CONFIRMATION_PHRASE = 'delete my account';

function extractErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function formatBalanceDollars(raw: string): string {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return '$0.00';
  return `$${value.toFixed(2)}`;
}

function computeStepNumber(step: Step, hasBalance: boolean, totpEnabled: boolean): number {
  const sequence: Step[] = ['intro'];
  if (hasBalance) sequence.push('wallet');
  sequence.push('password');
  if (totpEnabled) sequence.push('totp');
  sequence.push('final');
  return sequence.indexOf(step) + 1;
}

function IntroStep({
  onContinue,
  onCancel,
}: Readonly<{ onContinue: () => void; onCancel: () => void }>): React.JSX.Element {
  return (
    <>
      <OverlayHeader title="Delete your account" />
      <div className="space-y-3 text-sm">
        <p>
          Deleting your account removes your conversations, files, custom instructions, and
          encryption keys from our servers. You will be signed out immediately and unable to log
          back in.
        </p>
        <p>
          Anonymized billing records are retained for tax and accounting compliance. These records
          have no link back to your identity once your account is gone.
        </p>
        <p className="font-medium">This action cannot be undone.</p>
      </div>
      <ModalActions
        cancel={{ label: 'Cancel', onClick: onCancel, testId: 'delete-account-cancel' }}
        primary={{
          label: 'Continue',
          onClick: onContinue,
          testId: 'delete-account-intro-continue',
        }}
      />
    </>
  );
}

function WalletStep({
  balanceDisplay,
  acknowledged,
  onAcknowledgedChange,
  onContinue,
  onCancel,
}: Readonly<{
  balanceDisplay: string;
  acknowledged: boolean;
  onAcknowledgedChange: (checked: boolean) => void;
  onContinue: () => void;
  onCancel: () => void;
}>): React.JSX.Element {
  return (
    <>
      <OverlayHeader title="Forfeit remaining credit" />
      <div className="space-y-3 text-sm">
        <p>
          You have <span className="font-semibold">{balanceDisplay}</span> in credits. They will be
          permanently forfeited and cannot be refunded.
        </p>
        <Label className="flex items-start gap-2">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(checked) => {
              onAcknowledgedChange(checked === true);
            }}
            aria-label={`I understand I will forfeit ${balanceDisplay} and it cannot be refunded.`}
            data-testid="delete-account-forfeit-checkbox"
          />
          <span>I understand I will forfeit {balanceDisplay} and it cannot be refunded.</span>
        </Label>
      </div>
      <ModalActions
        cancel={{ label: 'Cancel', onClick: onCancel }}
        primary={{
          label: 'Continue',
          onClick: onContinue,
          disabled: !acknowledged,
          testId: 'delete-account-wallet-continue',
        }}
      />
    </>
  );
}

function PasswordStep({
  password,
  onPasswordChange,
  error,
  isSubmitting,
  onSubmit,
  onCancel,
  formRef,
}: Readonly<{
  password: string;
  onPasswordChange: (value: string) => void;
  error: string | null;
  isSubmitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  formRef: React.RefObject<HTMLFormElement | null>;
}>): React.JSX.Element {
  return (
    <>
      <OverlayHeader title="Enter your password to continue" />
      <form
        id="delete-account-password-form"
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <AuthPasswordInput
          id="delete-account-password"
          label="Password"
          value={password}
          onChange={(e) => {
            onPasswordChange(e.target.value);
          }}
        />
      </form>
      {error && <Alert>{error}</Alert>}
      <ModalActions
        cancel={{ label: 'Cancel', onClick: onCancel }}
        primary={{
          label: 'Continue',
          type: 'submit',
          form: 'delete-account-password-form',
          onClick: () => {
            /* handled by form submit */
          },
          disabled: password.length === 0,
          loading: isSubmitting,
          loadingLabel: 'Verifying...',
          testId: 'delete-account-password-continue',
        }}
      />
    </>
  );
}

function TotpStep({
  otpValue,
  onOtpChange,
  onContinue,
  onCancel,
}: Readonly<{
  otpValue: string;
  onOtpChange: (value: string) => void;
  onContinue: () => void;
  onCancel: () => void;
}>): React.JSX.Element {
  return (
    <>
      <OverlayHeader
        title="Enter your verification code"
        description="Enter the 6-digit code from your authenticator app."
      />
      <OtpInput value={otpValue} onChange={onOtpChange} />
      <ModalActions
        cancel={{ label: 'Cancel', onClick: onCancel }}
        primary={{
          label: 'Continue',
          onClick: onContinue,
          disabled: otpValue.length !== 6,
          testId: 'delete-account-totp-continue',
        }}
      />
    </>
  );
}

interface FinalStepProps {
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  error: string | null;
  showStartOver: boolean;
  phraseMatches: boolean;
  isSubmitting: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onStartOver: () => void;
}

function FinalStep({
  confirmation,
  onConfirmationChange,
  error,
  showStartOver,
  phraseMatches,
  isSubmitting,
  onSubmit,
  onCancel,
  onStartOver,
}: Readonly<FinalStepProps>): React.JSX.Element {
  const primary = {
    label: 'Delete account permanently',
    variant: 'destructive' as const,
    onClick: onSubmit,
    disabled: !phraseMatches || isSubmitting,
    loading: isSubmitting,
    loadingLabel: 'Deleting...',
    testId: 'delete-account-final-submit',
  };

  return (
    <>
      <OverlayHeader title="Type delete my account to confirm" />
      <div className="space-y-3">
        <p className="text-sm">
          Type the phrase{' '}
          <code className="bg-muted rounded px-1 py-0.5 text-sm font-medium">
            delete my account
          </code>{' '}
          exactly to enable the delete button.
        </p>
        <Label htmlFor="delete-account-confirmation" className="block">
          Confirmation
        </Label>
        <Input
          id="delete-account-confirmation"
          value={confirmation}
          onChange={(e) => {
            onConfirmationChange(e.target.value);
          }}
          aria-label="Confirmation"
          data-testid="delete-account-confirmation-input"
          autoComplete="off"
        />
      </div>
      {error && <Alert>{error}</Alert>}
      {showStartOver ? (
        <ModalActions
          cancel={{
            label: 'Start over',
            onClick: onStartOver,
            testId: 'delete-account-start-over',
          }}
          primary={primary}
        />
      ) : (
        <ModalActions cancel={{ label: 'Cancel', onClick: onCancel }} primary={primary} />
      )}
    </>
  );
}

export function DeleteAccountModal({
  open,
  onOpenChange,
}: Readonly<DeleteAccountModalProps>): React.JSX.Element | null {
  const balanceQuery = useBalance();
  const totpEnabled = useAuthStore((s) => s.user?.totpEnabled ?? false);

  const initMutation = useDeleteAccountInit();
  const finishMutation = useDeleteAccountFinish();

  const [step, setStep] = useState<Step>('intro');
  const [walletAcknowledged, setWalletAcknowledged] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isPasswordSubmitting, setIsPasswordSubmitting] = useState(false);
  const [otpValue, setOtpValue] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [finishError, setFinishError] = useState<string | null>(null);
  const [showStartOver, setShowStartOver] = useState(false);
  const [ke3, setKe3] = useState<number[] | null>(null);

  const balanceRaw = balanceQuery.data?.balance;
  const balanceNumber = balanceRaw ? Number.parseFloat(balanceRaw) : 0;
  const hasBalance = Number.isFinite(balanceNumber) && balanceNumber > 0;
  const balanceDisplay = balanceRaw ? formatBalanceDollars(balanceRaw) : '$0.00';

  const resetState = useCallback(() => {
    setStep('intro');
    setWalletAcknowledged(false);
    setPassword('');
    setPasswordError(null);
    setIsPasswordSubmitting(false);
    setOtpValue('');
    setConfirmation('');
    setFinishError(null);
    setShowStartOver(false);
    setKe3(null);
  }, []);

  React.useEffect(() => {
    if (open) {
      resetState();
    }
  }, [open, resetState]);

  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const handleOpenAutoFocus = useMobileAutoFocus();

  const handlePasswordSubmit = useCallback(async () => {
    if (password.length === 0) return;
    setIsPasswordSubmitting(true);
    setPasswordError(null);
    try {
      const opaqueClient = createOpaqueClient();
      const { ke1 } = await startLogin(opaqueClient, password);
      const { ke2 } = await initMutation.mutateAsync({ ke1: [...ke1] });
      // OPAQUE is constant-time: `/init` always succeeds and returns ke2 even
      // when the password is wrong. The mismatch surfaces here as a thrown
      // crypto error with no `code`. Map that to INCORRECT_PASSWORD so the user
      // sees a meaningful message instead of the INTERNAL fallback.
      let loginResult;
      try {
        loginResult = await finishLogin(opaqueClient, ke2, OPAQUE_SERVER_IDENTIFIER);
      } catch {
        setPasswordError(friendlyErrorMessage('INCORRECT_PASSWORD'));
        return;
      }
      setKe3([...loginResult.ke3]);
      setStep(totpEnabled ? 'totp' : 'final');
    } catch (error) {
      const code = extractErrorCode(error);
      setPasswordError(code ? friendlyErrorMessage(code) : friendlyErrorMessage('INTERNAL'));
    } finally {
      setIsPasswordSubmitting(false);
    }
  }, [password, initMutation, totpEnabled]);

  const phraseMatches = useMemo(
    () => confirmation.trim().toLowerCase() === CONFIRMATION_PHRASE,
    [confirmation]
  );

  const handleFinishSubmit = useCallback(async () => {
    if (!phraseMatches || ke3 === null) return;
    setFinishError(null);
    setShowStartOver(false);
    try {
      const body: { ke3: number[]; totpCode?: string; confirmationPhrase: string } = {
        ke3,
        confirmationPhrase: confirmation.trim().toLowerCase(),
      };
      if (totpEnabled) body.totpCode = otpValue;
      await finishMutation.mutateAsync(body);
      useAuthStore.getState().clear();
      queryClient.clear();
      globalThis.location.href = MARKETING_BASE_URL;
    } catch (error) {
      const code = extractErrorCode(error);
      setFinishError(code ? friendlyErrorMessage(code) : friendlyErrorMessage('INTERNAL'));
      if (code === 'NO_PENDING_DELETE_ACCOUNT') {
        setShowStartOver(true);
      }
    }
  }, [phraseMatches, ke3, confirmation, totpEnabled, otpValue, finishMutation]);

  const previousStep = useCallback(
    (current: Step): Step => {
      if (current === 'wallet') return 'intro';
      if (current === 'password') return hasBalance ? 'wallet' : 'intro';
      if (current === 'totp') return 'password';
      return totpEnabled ? 'totp' : 'password';
    },
    [hasBalance, totpEnabled]
  );

  const handleBack = useCallback(() => {
    setStep((current) => previousStep(current));
  }, [previousStep]);

  const handleCancel = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const stepNumber = useMemo(
    () => computeStepNumber(step, hasBalance, totpEnabled),
    [step, hasBalance, totpEnabled]
  );

  if (!open) return null;

  const stepBody = renderStepBody({
    step,
    hasBalance,
    balanceDisplay,
    walletAcknowledged,
    setWalletAcknowledged,
    password,
    setPassword,
    passwordError,
    isPasswordSubmitting,
    handlePasswordSubmit,
    formRef,
    otpValue,
    setOtpValue,
    setStep,
    confirmation,
    setConfirmation,
    finishError,
    showStartOver,
    phraseMatches,
    finishIsPending: finishMutation.isPending,
    handleFinishSubmit,
    resetState,
    handleCancel,
  });

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Delete account"
      onOpenAutoFocus={handleOpenAutoFocus}
      currentStep={stepNumber}
      {...(step !== 'intro' && { onBack: handleBack })}
    >
      <OverlayContent data-testid="delete-account-modal" className="w-[75vw]">
        {stepBody}
      </OverlayContent>
    </Overlay>
  );
}

interface StepBodyArgs {
  step: Step;
  hasBalance: boolean;
  balanceDisplay: string;
  walletAcknowledged: boolean;
  setWalletAcknowledged: (value: boolean) => void;
  password: string;
  setPassword: (value: string) => void;
  passwordError: string | null;
  isPasswordSubmitting: boolean;
  handlePasswordSubmit: () => Promise<void>;
  formRef: React.RefObject<HTMLFormElement | null>;
  otpValue: string;
  setOtpValue: (value: string) => void;
  setStep: React.Dispatch<React.SetStateAction<Step>>;
  confirmation: string;
  setConfirmation: (value: string) => void;
  finishError: string | null;
  showStartOver: boolean;
  phraseMatches: boolean;
  finishIsPending: boolean;
  handleFinishSubmit: () => Promise<void>;
  resetState: () => void;
  handleCancel: () => void;
}

function renderStepBody(args: Readonly<StepBodyArgs>): React.JSX.Element | null {
  if (args.step === 'intro') {
    return (
      <IntroStep
        onContinue={() => {
          args.setStep(args.hasBalance ? 'wallet' : 'password');
        }}
        onCancel={args.handleCancel}
      />
    );
  }
  if (args.step === 'wallet') {
    return (
      <WalletStep
        balanceDisplay={args.balanceDisplay}
        acknowledged={args.walletAcknowledged}
        onAcknowledgedChange={args.setWalletAcknowledged}
        onContinue={() => {
          args.setStep('password');
        }}
        onCancel={args.handleCancel}
      />
    );
  }
  if (args.step === 'password') {
    return (
      <PasswordStep
        password={args.password}
        onPasswordChange={args.setPassword}
        error={args.passwordError}
        isSubmitting={args.isPasswordSubmitting}
        onSubmit={() => {
          void args.handlePasswordSubmit();
        }}
        onCancel={args.handleCancel}
        formRef={args.formRef}
      />
    );
  }
  if (args.step === 'totp') {
    return (
      <TotpStep
        otpValue={args.otpValue}
        onOtpChange={args.setOtpValue}
        onContinue={() => {
          args.setStep('final');
        }}
        onCancel={args.handleCancel}
      />
    );
  }
  return (
    <FinalStep
      confirmation={args.confirmation}
      onConfirmationChange={args.setConfirmation}
      error={args.finishError}
      showStartOver={args.showStartOver}
      phraseMatches={args.phraseMatches}
      isSubmitting={args.finishIsPending}
      onSubmit={() => {
        void args.handleFinishSubmit();
      }}
      onCancel={args.handleCancel}
      onStartOver={args.resetState}
    />
  );
}
