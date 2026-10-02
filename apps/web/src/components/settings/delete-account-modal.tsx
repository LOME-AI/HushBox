import * as React from 'react';
import { useState, useCallback, useMemo, useRef } from 'react';
import {
  InlineFormError,
  UserMessageError,
  useAsyncAction,
  type UseAsyncActionReturn,
} from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { CheckField, TextField } from '@hushbox/ui/field';
import {
  ArrowLeft,
  File,
  Icon,
  KeyRound,
  MessageSquare,
  type IconComponent,
} from '@hushbox/ui/icons';
import {
  Overlay,
  OverlayBody,
  OverlayContent,
  OverlayFooter,
  OverlayHeader,
} from '@hushbox/ui/overlay';
import { Text } from '@hushbox/ui/type';
import {
  DELETE_ACCOUNT_CONFIRMATION_PHRASE,
  ERROR_CODES,
  formatLockoutMessage,
  asErrorCode,
  friendlyErrorMessage,
  NanoUSD,
  parseNanoUSD,
  retryAfterSecondsOf,
  ROUTES,
  TEST_IDS,
  type UserFacingMessage,
} from '@hushbox/shared';
import { useFormEnterNav } from '@/hooks/ui/use-form-enter-nav';
import { useDeleteAccountInit, useDeleteAccountFinish } from '@/hooks/auth/use-delete-account';
import { useBalance } from '@/hooks/billing/billing';
import { formatBalance } from '@/lib/billing/format';
import { useAuthStore, clearLocalAuthState } from '@/lib/auth/auth';
import { beginPasswordStepUp } from '@/lib/auth/password-step-up';
import { getErrorBody } from '@/lib/api/api';
import { AuthPasswordInput } from '@/components/auth/auth-password-input';
import { OtpInput } from '@/components/auth/otp-input';

interface DeleteAccountModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Step = 'intro' | 'wallet' | 'password' | 'totp' | 'final';

// eslint-disable-next-line sonarjs/no-hardcoded-passwords -- DOM id for aria-describedby, not a credential
const PASSWORD_ERROR_ID = 'delete-account-password-error';
const CONFIRMATION_ERROR_ID = 'delete-account-confirmation-error';

// Returns a duration-aware lockout message when the server included a usable
// retryAfterSeconds. The deletion gate reports lockout as
// DELETE_ACCOUNT_LOCKED + retryAfterSeconds, so key on the detail rather than a
// specific code — the countdown renders regardless of which code carried it.
function messageFor(code: string, details?: Record<string, unknown>): UserFacingMessage {
  const retryAfterSeconds = retryAfterSecondsOf(details);
  if (retryAfterSeconds !== undefined) return formatLockoutMessage(retryAfterSeconds);
  return friendlyErrorMessage(asErrorCode(code));
}

// The purchased balance a forfeit refusal names, as a canonical NanoUSD wire
// string, or undefined when the refusal carries no readable figure.
function refusedForfeitOf(error: unknown): string | undefined {
  const body = getErrorBody(error);
  if (body?.code !== ERROR_CODES.DELETE_ACCOUNT_FORFEIT_UNACKNOWLEDGED) return undefined;
  const parsed = NanoUSD.safeParse(body.details?.['purchasedBalanceNanoUsd']);
  return parsed.success ? parsed.data.toString() : undefined;
}

// Translate an arbitrary thrown error into a UserMessageError carrying a
// user-facing message. Lockout payloads with a `retryAfterSeconds` detail
// produce a duration-aware string; other ApiError bodies use their code's
// friendly message; opaque errors fall back to INTERNAL's generic message.
function mapOpaqueError(error: unknown): UserMessageError {
  if (error instanceof UserMessageError) return error;
  const body = getErrorBody(error);
  return new UserMessageError(
    body ? messageFor(body.code, body.details) : friendlyErrorMessage('INTERNAL')
  );
}

function stepSequence(hasBalance: boolean, totpEnabled: boolean): Step[] {
  const sequence: Step[] = ['intro'];
  if (hasBalance) sequence.push('wallet');
  sequence.push('password');
  if (totpEnabled) sequence.push('totp');
  sequence.push('final');
  return sequence;
}

function computeStepNumber(step: Step, hasBalance: boolean, totpEnabled: boolean): number {
  return stepSequence(hasBalance, totpEnabled).indexOf(step) + 1;
}

/** The step line's position, or `'pending'` while the balance that decides the count loads. */
type StepLine = { current: number; total: number } | 'pending';

const DELETED_ITEMS: readonly { icon: IconComponent; text: string }[] = [
  {
    icon: MessageSquare,
    text: 'Every conversation you own, group chats included. Their members lose them too.',
  },
  { icon: File, text: 'Your files, custom instructions and settings.' },
  { icon: KeyRound, text: 'Your encryption keys. Your recovery phrase stops working.' },
];

function IntroStep({
  step,
  onContinue,
  onCancel,
  balanceLoading,
}: Readonly<{
  step: StepLine;
  onContinue: () => void;
  onCancel: () => void;
  balanceLoading: boolean;
}>): React.JSX.Element {
  return (
    <>
      <OverlayHeader title="Delete your account" step={step} />
      <OverlayBody>
        <Text variant="ui">This deletes, from our servers:</Text>
        <ul className="flex flex-col gap-3">
          {DELETED_ITEMS.map(({ icon, text }) => (
            <li key={text} className="flex items-center gap-3">
              <Icon icon={icon} className="text-muted-foreground shrink-0" />
              <Text variant="ui" as="span">
                {text}
              </Text>
            </li>
          ))}
        </ul>
        <Text variant="ui" tone="muted">
          Billing records are kept for tax law, with your name and email removed. You&apos;re signed
          out everywhere. This can&apos;t be undone.
        </Text>
      </OverlayBody>
      <OverlayFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          data-testid={TEST_IDS.deleteAccountCancel}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onContinue}
          // Block advancing until balance is known — otherwise we'd silently
          // skip the forfeit step for a user with credits.
          disabled={balanceLoading}
          loading={balanceLoading}
          loadingLabel="Loading..."
          data-testid={TEST_IDS.deleteAccountIntroContinue}
        >
          Continue
        </Button>
      </OverlayFooter>
    </>
  );
}

function WalletStep({
  step,
  balanceDisplay,
  acknowledged,
  onAcknowledgedChange,
  onContinue,
  onBack,
}: Readonly<{
  step: StepLine;
  balanceDisplay: string;
  acknowledged: boolean;
  onAcknowledgedChange: (checked: boolean) => void;
  onContinue: () => void;
  onBack: () => void;
}>): React.JSX.Element {
  return (
    <>
      <OverlayHeader title="Your balance is forfeited" step={step} />
      <OverlayBody>
        <div className="flex flex-col gap-0.5">
          <Text variant="caption" as="span">
            Your balance
          </Text>
          <span className="font-mono text-[1.75rem] leading-[1.2] font-medium tabular-nums">
            {balanceDisplay}
          </span>
        </div>
        <Text variant="ui">
          Credit can&apos;t be refunded or moved to another account. To use it first, close this and
          come back later.
        </Text>
        <CheckField
          testId={TEST_IDS.deleteAccountForfeitCheckbox}
          checked={acknowledged}
          onCheckedChange={onAcknowledgedChange}
          label={
            <span className="text-foreground">
              I understand the {balanceDisplay} balance is forfeited and can&apos;t be refunded.
            </span>
          }
        />
      </OverlayBody>
      <OverlayFooter>
        <Button type="button" variant="outline" onClick={onBack}>
          <Icon icon={ArrowLeft} />
          Back
        </Button>
        <Button
          type="button"
          onClick={onContinue}
          disabled={!acknowledged}
          data-testid={TEST_IDS.deleteAccountWalletContinue}
        >
          Continue
        </Button>
      </OverlayFooter>
    </>
  );
}

function PasswordStep({
  step,
  password,
  onPasswordChange,
  passwordAction,
  onSubmit,
  onCancel,
  formRef,
}: Readonly<{
  step: StepLine;
  password: string;
  onPasswordChange: (value: string) => void;
  passwordAction: UseAsyncActionReturn;
  onSubmit: () => void;
  onCancel: () => void;
  formRef: React.RefObject<HTMLFormElement | null>;
}>): React.JSX.Element {
  const { isPending: isSubmitting, error, errorKey, clearError } = passwordAction;
  const hasError = error !== null;
  return (
    <>
      <OverlayHeader title="Enter your password to continue" step={step} />
      <OverlayBody>
        <form
          id="delete-account-password-form"
          ref={formRef}
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <AuthPasswordInput
            id="delete-account-password"
            label="Password"
            value={password}
            onChange={(e) => {
              onPasswordChange(e.target.value);
              if (hasError) clearError();
            }}
            aria-invalid={hasError}
            aria-describedby={hasError ? PASSWORD_ERROR_ID : undefined}
          />
        </form>
        <InlineFormError error={error} errorKey={errorKey} id={PASSWORD_ERROR_ID} />
      </OverlayBody>
      <OverlayFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="submit"
          form="delete-account-password-form"
          onClick={onSubmit}
          disabled={password.length === 0 || isSubmitting}
          loading={isSubmitting}
          loadingLabel="Verifying..."
          data-testid={TEST_IDS.deleteAccountPasswordContinue}
        >
          Continue
        </Button>
      </OverlayFooter>
    </>
  );
}

function TotpStep({
  step,
  otpValue,
  onOtpChange,
  onContinue,
  onCancel,
  error,
}: Readonly<{
  step: StepLine;
  otpValue: string;
  onOtpChange: (value: string) => void;
  onContinue: () => void;
  onCancel: () => void;
  error: string | null;
}>): React.JSX.Element {
  return (
    <>
      <OverlayHeader
        title="Enter your verification code"
        step={step}
        description="Enter the 6-digit code from your authenticator app."
      />
      <OverlayBody>
        <OtpInput value={otpValue} onChange={onOtpChange} error={error} />
      </OverlayBody>
      <OverlayFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onContinue}
          disabled={otpValue.length !== 6}
          data-testid={TEST_IDS.deleteAccountTotpContinue}
        >
          Continue
        </Button>
      </OverlayFooter>
    </>
  );
}

interface FinalStepProps {
  step: StepLine;
  confirmation: string;
  onConfirmationChange: (value: string) => void;
  finishAction: UseAsyncActionReturn;
  showStartOver: boolean;
  phraseMatches: boolean;
  onSubmit: () => void;
  onCancel: () => void;
  onStartOver: () => void;
}

function FinalStep({
  step,
  confirmation,
  onConfirmationChange,
  finishAction,
  showStartOver,
  phraseMatches,
  onSubmit,
  onCancel,
  onStartOver,
}: Readonly<FinalStepProps>): React.JSX.Element {
  const { isPending: isSubmitting, error, errorKey, clearError } = finishAction;
  const hasError = error !== null;
  return (
    <>
      <OverlayHeader title="Type delete my account to confirm" step={step} />
      <OverlayBody>
        <div className="space-y-3">
          <p className="text-sm">
            Type the phrase{' '}
            <code className="bg-muted rounded px-1 py-0.5 text-sm font-medium">
              {DELETE_ACCOUNT_CONFIRMATION_PHRASE}
            </code>{' '}
            exactly to enable the delete button.
          </p>
          <TextField
            id="delete-account-confirmation"
            label="Confirmation"
            value={confirmation}
            onChange={(e) => {
              onConfirmationChange(e.target.value);
              if (hasError) clearError();
            }}
            aria-invalid={hasError}
            aria-describedby={hasError ? CONFIRMATION_ERROR_ID : undefined}
            data-testid={TEST_IDS.deleteAccountConfirmationInput}
            autoComplete="off"
          />
        </div>
        <InlineFormError error={error} errorKey={errorKey} id={CONFIRMATION_ERROR_ID} />
      </OverlayBody>
      <OverlayFooter>
        {showStartOver ? (
          <Button
            type="button"
            variant="outline"
            onClick={onStartOver}
            data-testid={TEST_IDS.deleteAccountStartOver}
          >
            Start over
          </Button>
        ) : (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type="button"
          variant="destructive"
          onClick={onSubmit}
          disabled={!phraseMatches || isSubmitting}
          loading={isSubmitting}
          loadingLabel="Deleting..."
          data-testid={TEST_IDS.deleteAccountFinalSubmit}
        >
          Delete account permanently
        </Button>
      </OverlayFooter>
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
  const [otpValue, setOtpValue] = useState('');
  const [totpError, setTotpError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [showStartOver, setShowStartOver] = useState(false);
  const [ke3, setKe3] = useState<number[] | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // The purchased balance a server refusal named; it outranks the balance read,
  // which can be stale or missing.
  const [refusedForfeit, setRefusedForfeit] = useState<string | null>(null);
  // The figure the forfeit step showed when the user continued past it.
  const [acknowledgedForfeit, setAcknowledgedForfeit] = useState('0');
  const passwordAction = useAsyncAction();
  const finishAction = useAsyncAction();

  // The spendable purchased wallet (NanoUSD wire string) drives the "you still
  // have credits" warning; bigint math throughout — never `parseFloat` on money.
  const balanceRaw = refusedForfeit ?? balanceQuery.data?.purchased.balanceNanoUsd;
  const hasBalance = balanceRaw ? parseNanoUSD(balanceRaw) > 0n : false;
  const balanceDisplay = formatBalance(balanceRaw ?? '0');
  const balanceLoading = balanceQuery.isPending;

  const { clearError: clearPasswordError } = passwordAction;
  const { clearError: clearFinishError } = finishAction;

  const resetState = useCallback(() => {
    setStep('intro');
    setWalletAcknowledged(false);
    setPassword('');
    setOtpValue('');
    setTotpError(null);
    setConfirmation('');
    setShowStartOver(false);
    setKe3(null);
    setSessionId(null);
    setRefusedForfeit(null);
    setAcknowledgedForfeit('0');
    clearPasswordError();
    clearFinishError();
  }, [clearPasswordError, clearFinishError]);

  React.useEffect(() => {
    if (open) {
      resetState();
    }
  }, [open, resetState]);

  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);

  const runPasswordSubmit = useCallback(async (): Promise<void> => {
    if (password.length === 0) return;
    // Mirrors the disable-2FA / change-password defense-in-depth pattern:
    // the encoded byte copy is zeroed on every exit path so a heap inspection
    // after the modal closes can't recover it. JS strings stay un-zeroable.
    const passwordBytes = new TextEncoder().encode(password);
    try {
      const stepUp = await beginPasswordStepUp(password);
      const { ke2, deleteAccountSessionId } = await initMutation.mutateAsync({
        ke1: [...stepUp.ke1],
      });
      // OPAQUE is constant-time: `/init` always succeeds, so wrong-password
      // surfaces as a thrown crypto error in the proof step. Map that to
      // INCORRECT_PASSWORD instead of the generic INTERNAL fallback.
      let ke3: number[];
      try {
        ke3 = await stepUp.finish(ke2);
      } catch {
        throw new UserMessageError(friendlyErrorMessage('INCORRECT_PASSWORD'));
      }
      setKe3([...ke3]);
      setSessionId(deleteAccountSessionId);
      setStep(totpEnabled ? 'totp' : 'final');
    } catch (error) {
      throw mapOpaqueError(error);
    } finally {
      passwordBytes.fill(0);
    }
  }, [password, initMutation, totpEnabled]);

  const handlePasswordSubmit = useCallback((): void => {
    void passwordAction.run(runPasswordSubmit);
  }, [passwordAction, runPasswordSubmit]);

  const phraseMatches = useMemo(
    () => confirmation.trim().toLowerCase() === DELETE_ACCOUNT_CONFIRMATION_PHRASE,
    [confirmation]
  );

  // Moves the dialog to the step a finish refusal belongs on and reports
  // whether it did; a refusal it leaves alone surfaces on the final step.
  const routeFinishRefusal = useCallback((error: unknown): boolean => {
    const code = getErrorBody(error)?.code;
    // TOTP-shape errors get routed back to the TOTP step so the user sees
    // the error next to the offending input. Don't throw — the final step
    // won't be visible anyway, so a thrown UserMessageError would surface
    // on a step the user isn't on.
    if (code === 'INVALID_TOTP_CODE' || code === 'TOTP_CODE_REQUIRED') {
      setTotpError(messageFor(code));
      setStep('totp');
      return true;
    }
    // The server holds more purchased credit than this attempt acknowledged:
    // show the forfeit step with its figure. The refusal consumed the step-up,
    // so the user proves the password again after ticking it.
    const refused = refusedForfeitOf(error);
    if (refused !== undefined) {
      setRefusedForfeit(refused);
      setWalletAcknowledged(false);
      setKe3(null);
      setSessionId(null);
      setStep('wallet');
      return true;
    }
    if (code === 'NO_PENDING_DELETE_ACCOUNT') setShowStartOver(true);
    return false;
  }, []);

  const runFinishSubmit = useCallback(async (): Promise<void> => {
    if (!phraseMatches || ke3 === null || sessionId === null) return;
    setTotpError(null);
    setShowStartOver(false);
    try {
      const body: {
        ke3: number[];
        totpCode?: string;
        confirmationPhrase: string;
        deleteAccountSessionId: string;
        acknowledgedForfeitNanoUsd: string;
      } = {
        ke3,
        confirmationPhrase: confirmation.trim().toLowerCase(),
        deleteAccountSessionId: sessionId,
        acknowledgedForfeitNanoUsd: acknowledgedForfeit,
      };
      if (totpEnabled) body.totpCode = otpValue;
      await finishMutation.mutateAsync(body);
      // Assign before clearLocalAuthState: queryClient.clear() flips the
      // settled-aware indicator true, racing the browser's URL commit.
      globalThis.location.href = ROUTES.MARKETING;
      // navigate-away, not reload: the `globalThis.location.href` assignment is
      // itself a full-document navigation that tears the JS context down, so it
      // already provides clearLocalAuthState's memory-hygiene guarantee. A reload
      // here would reload the CURRENT url (still /settings), overriding the
      // pending /welcome nav and bouncing the re-run auth guard to /login.
      await clearLocalAuthState({ next: 'navigate-away' });
    } catch (error) {
      if (routeFinishRefusal(error)) return;
      throw mapOpaqueError(error);
    }
  }, [
    phraseMatches,
    ke3,
    sessionId,
    confirmation,
    totpEnabled,
    otpValue,
    acknowledgedForfeit,
    finishMutation,
    routeFinishRefusal,
  ]);

  const handleFinishSubmit = useCallback((): void => {
    void finishAction.run(runFinishSubmit);
  }, [finishAction, runFinishSubmit]);

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
  const stepTotal = stepSequence(hasBalance, totpEnabled).length;

  if (!open) return null;

  const isBusy = passwordAction.isPending || finishAction.isPending;

  const stepBody = renderStepBody({
    step,
    stepLine: balanceLoading ? 'pending' : { current: stepNumber, total: stepTotal },
    hasBalance,
    balanceLoading,
    balanceDisplay,
    acknowledgeForfeit: () => {
      setAcknowledgedForfeit(balanceRaw ?? '0');
    },
    walletAcknowledged,
    setWalletAcknowledged,
    password,
    setPassword,
    passwordAction,
    handlePasswordSubmit,
    formRef,
    otpValue,
    setOtpValue,
    totpError,
    setStep,
    confirmation,
    setConfirmation,
    finishAction,
    showStartOver,
    phraseMatches,
    handleFinishSubmit,
    resetState,
    handleCancel,
    handleBack,
  });

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Delete account"
      currentStep={stepNumber}
      dismissible={!isBusy}
      // The balance step draws its Back in the footer, so it takes no corner arrow.
      {...(step !== 'intro' && step !== 'wallet' && { onBack: handleBack })}
    >
      <OverlayContent data-testid={TEST_IDS.deleteAccountModal} size="md">
        {stepBody}
      </OverlayContent>
    </Overlay>
  );
}

interface StepBodyArgs {
  step: Step;
  stepLine: StepLine;
  hasBalance: boolean;
  balanceLoading: boolean;
  balanceDisplay: string;
  acknowledgeForfeit: () => void;
  walletAcknowledged: boolean;
  setWalletAcknowledged: (value: boolean) => void;
  password: string;
  setPassword: (value: string) => void;
  passwordAction: UseAsyncActionReturn;
  handlePasswordSubmit: () => void;
  formRef: React.RefObject<HTMLFormElement | null>;
  otpValue: string;
  setOtpValue: (value: string) => void;
  totpError: string | null;
  setStep: React.Dispatch<React.SetStateAction<Step>>;
  confirmation: string;
  setConfirmation: (value: string) => void;
  finishAction: UseAsyncActionReturn;
  showStartOver: boolean;
  phraseMatches: boolean;
  handleFinishSubmit: () => void;
  resetState: () => void;
  handleCancel: () => void;
  handleBack: () => void;
}

function renderStepBody(args: Readonly<StepBodyArgs>): React.JSX.Element | null {
  if (args.step === 'intro') {
    return (
      <IntroStep
        step={args.stepLine}
        onContinue={() => {
          args.setStep(args.hasBalance ? 'wallet' : 'password');
        }}
        onCancel={args.handleCancel}
        balanceLoading={args.balanceLoading}
      />
    );
  }
  if (args.step === 'wallet') {
    return (
      <WalletStep
        step={args.stepLine}
        balanceDisplay={args.balanceDisplay}
        acknowledged={args.walletAcknowledged}
        onAcknowledgedChange={args.setWalletAcknowledged}
        onContinue={() => {
          args.acknowledgeForfeit();
          args.setStep('password');
        }}
        onBack={args.handleBack}
      />
    );
  }
  if (args.step === 'password') {
    return (
      <PasswordStep
        step={args.stepLine}
        password={args.password}
        onPasswordChange={args.setPassword}
        passwordAction={args.passwordAction}
        onSubmit={args.handlePasswordSubmit}
        onCancel={args.handleCancel}
        formRef={args.formRef}
      />
    );
  }
  if (args.step === 'totp') {
    return (
      <TotpStep
        step={args.stepLine}
        otpValue={args.otpValue}
        onOtpChange={args.setOtpValue}
        onContinue={() => {
          args.setStep('final');
        }}
        onCancel={args.handleCancel}
        error={args.totpError}
      />
    );
  }
  return (
    <FinalStep
      step={args.stepLine}
      confirmation={args.confirmation}
      onConfirmationChange={args.setConfirmation}
      finishAction={args.finishAction}
      showStartOver={args.showStartOver}
      phraseMatches={args.phraseMatches}
      onSubmit={args.handleFinishSubmit}
      onCancel={args.handleCancel}
      onStartOver={args.resetState}
    />
  );
}
