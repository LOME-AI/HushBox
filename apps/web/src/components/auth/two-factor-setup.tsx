import * as React from 'react';
import { useState, useCallback } from 'react';
import { Copy, Check, Loader2 } from 'lucide-react';
import { QRCode } from 'react-qrcode-logo';
import { z } from 'zod';
import {
  Button,
  InlineFormError,
  ModalActions,
  Overlay,
  OverlayContent,
  OverlayHeader,
  UserMessageError,
  useAsyncAction,
  useCopyToClipboard,
  type UseAsyncActionReturn,
} from '@hushbox/ui';
import { readThemeColor } from '@hushbox/ui/cipher-wall/hook';
import logoUrl from '@hushbox/ui/assets/HushBoxLogo.png';
import { errorResponseSchema, TEST_IDS, friendlyErrorMessage } from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client';
import { ApiError } from '@/lib/api/api';
import { useOtpVerification } from '@/hooks/auth/use-otp-verification';
import { OtpInput } from '@/components/auth/otp-input';
import { ModalSuccessStep } from '@/components/shared/modal-success-step';
import type { ErrorCode } from '@hushbox/shared';

interface TwoFactorSetupProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

type Step = 'loading' | 'scan' | 'verify' | 'success';

const totpSetupBodySchema = z.object({
  secret: z.string().min(1),
  totpUri: z.string().min(1),
});

type TotpData = z.infer<typeof totpSetupBodySchema>;

interface StepContentProps {
  readonly step: Step;
  readonly totpData: TotpData | null;
  readonly otpValue: string;
  readonly otpError: string | null;
  readonly fetchAction: UseAsyncActionReturn;
  readonly isVerifying: boolean;
  readonly onStart: () => void;
  readonly onContinueToVerify: () => void;
  readonly setOtpValue: (value: string) => void;
  readonly onOtpComplete: (value: string) => void;
  readonly onVerify: () => void;
  readonly onDone: () => void;
}

function StepContent({
  step,
  totpData,
  otpValue,
  otpError,
  fetchAction,
  isVerifying,
  onStart,
  onContinueToVerify,
  setOtpValue,
  onOtpComplete,
  onVerify,
  onDone,
}: Readonly<StepContentProps>): React.JSX.Element | null {
  if (step === 'loading') {
    return <LoadingStep fetchAction={fetchAction} onStart={onStart} />;
  }

  if (step === 'scan' && totpData) {
    return <ScanStep totpData={totpData} onContinue={onContinueToVerify} />;
  }

  if (step === 'verify') {
    return (
      <VerifyStep
        otpValue={otpValue}
        onOtpChange={setOtpValue}
        onOtpComplete={onOtpComplete}
        error={otpError}
        isVerifying={isVerifying}
        onVerify={onVerify}
      />
    );
  }

  if (step === 'success') {
    return (
      <ModalSuccessStep
        heading="Two-Factor Authentication Enabled"
        description="Your account is now more secure. You'll need to enter a code from your authenticator app each time you log in."
        primaryLabel="Done"
        onDone={onDone}
      />
    );
  }

  return null;
}

/**
 * The wire code carried by a failed `fetchJson` call, or `null` when the
 * failure body is absent or does not match the `{ code, details? }` contract.
 */
function failureCode(error: unknown): ErrorCode | null {
  const parsed = errorResponseSchema.safeParse(error instanceof ApiError ? error.data : undefined);
  return parsed.success ? parsed.data.code : null;
}

async function fetchTotpSetup(): Promise<
  { ok: true; data: TotpData } | { ok: false; error: string }
> {
  try {
    const body = await fetchJson(client.auth['2fa'].setup.$post());
    const parsed = totpSetupBodySchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, error: friendlyErrorMessage('TWO_FACTOR_SETUP_FAILED') };
    }
    // The route's inferred 200 body is the contract; the schema is only the
    // runtime gate on it, and this annotation is what stops the two drifting
    // into a second hand-maintained copy.
    const data: typeof body = parsed.data;
    return { ok: true, data };
  } catch (error_: unknown) {
    return {
      ok: false,
      error: friendlyErrorMessage(failureCode(error_) ?? 'TWO_FACTOR_SETUP_FAILED'),
    };
  }
}

async function verifyTotpCode(code: string): Promise<{ success: boolean; error?: string }> {
  try {
    await fetchJson(client.auth['2fa'].verify.$post({ json: { code } }));
    return { success: true };
  } catch (error_: unknown) {
    return {
      success: false,
      error: friendlyErrorMessage(failureCode(error_) ?? 'TWO_FACTOR_VERIFICATION_FAILED'),
    };
  }
}

export function TwoFactorSetup({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<TwoFactorSetupProps>): React.JSX.Element | null {
  const [step, setStep] = useState<Step>('loading');
  const [totpData, setTotpData] = useState<TotpData | null>(null);
  const fetchAction = useAsyncAction();

  const handleVerifySuccess = useCallback(() => {
    setStep('success');
  }, []);

  const {
    otpValue,
    setOtpValue,
    error: otpError,
    isVerifying,
    handleVerify,
    handleComplete,
    reset: resetOtp,
  } = useOtpVerification({
    onVerify: verifyTotpCode,
    onSuccess: handleVerifySuccess,
  });

  const { clearError: clearFetchError } = fetchAction;
  React.useEffect(() => {
    if (open) {
      setStep('loading');
      clearFetchError();
      setTotpData(null);
      resetOtp();
    }
  }, [open, resetOtp, clearFetchError]);

  const handleStart = useCallback((): void => {
    void fetchAction.run(async () => {
      const result = await fetchTotpSetup();
      if (!result.ok) {
        throw new UserMessageError(result.error);
      }
      setTotpData(result.data);
      setStep('scan');
    });
  }, [fetchAction]);

  const handleContinueToVerify = useCallback(() => {
    setStep('verify');
    resetOtp();
  }, [resetOtp]);

  const handleBackToIntro = useCallback(() => {
    setStep('loading');
    clearFetchError();
  }, [clearFetchError]);

  const handleBackToScan = useCallback(() => {
    setStep('scan');
    resetOtp();
  }, [resetOtp]);

  const handleDone = useCallback(() => {
    onSuccess();
  }, [onSuccess]);

  if (!open) return null;

  const currentStep = (() => {
    if (step === 'loading') return 1;
    if (step === 'scan') return 2;
    if (step === 'verify') return 3;
    return 4;
  })();
  const showBackButton = step === 'scan' || step === 'verify';

  const handleBack = step === 'verify' ? handleBackToScan : handleBackToIntro;
  const isBusy = fetchAction.isPending || isVerifying;

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Two-factor authentication setup"
      currentStep={currentStep}
      dismissible={!isBusy}
      {...(showBackButton && { onBack: handleBack })}
    >
      <OverlayContent data-testid={TEST_IDS.twoFactorSetupModal} className="md:w-[75vw]">
        <StepContent
          step={step}
          totpData={totpData}
          otpValue={otpValue}
          otpError={otpError}
          fetchAction={fetchAction}
          isVerifying={isVerifying}
          onStart={handleStart}
          onContinueToVerify={handleContinueToVerify}
          setOtpValue={setOtpValue}
          onOtpComplete={handleComplete}
          /* v8 ignore start -- the OTP auto-submits on the 6th digit, so the Verify button is never idle-and-enabled on the verify step: success unmounts VerifyStep and failure clears the input */
          onVerify={() => {
            handleVerify();
          }}
          /* v8 ignore stop */
          onDone={handleDone}
        />
      </OverlayContent>
    </Overlay>
  );
}

interface LoadingStepProps {
  fetchAction: UseAsyncActionReturn;
  onStart: () => void;
}

function LoadingStep({ fetchAction, onStart }: Readonly<LoadingStepProps>): React.JSX.Element {
  const { isPending: isLoading, error, errorKey } = fetchAction;
  return (
    <div className="space-y-4">
      <OverlayHeader
        title="Set Up Two-Factor Authentication"
        description="Add an extra layer of security. You'll need an authenticator app like Google Authenticator, Authy, or 1Password."
      />

      <InlineFormError error={error} errorKey={errorKey} />

      {error === null && isLoading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
          <span className="text-muted-foreground ml-2">Loading...</span>
        </div>
      )}

      {error === null && !isLoading && (
        <ModalActions
          primary={{
            label: 'Get Started →',
            onClick: onStart,
          }}
        />
      )}
    </div>
  );
}

interface ScanStepProps {
  totpData: TotpData;
  onContinue: () => void;
}

function ScanStep({ totpData, onContinue }: Readonly<ScanStepProps>): React.JSX.Element {
  const qrSize = 180;
  const { copy, copied } = useCopyToClipboard({ resetAfterMs: 3000 });
  // The QR paints to a canvas, whose fills take a resolved colour and silently
  // ignore a `var()` reference — so the brand token is read off the cascade
  // rather than restated as a hex that would drift from the stylesheet.
  const brandRed = readThemeColor('--brand-red');

  return (
    <div className="space-y-4">
      <OverlayHeader
        title="Scan QR Code"
        description="Open your authenticator app and scan this code."
      />

      <div className="flex justify-center py-4">
        <div className="rounded-lg bg-white p-3">
          <QRCode
            value={totpData.totpUri}
            size={qrSize}
            qrStyle="fluid"
            eyeRadius={12}
            eyeColor={brandRed}
            logoImage={logoUrl}
            logoWidth={qrSize * 0.2}
            logoPadding={5}
            logoPaddingStyle="circle"
            ecLevel="H"
            removeQrCodeBehindLogo={true}
          />
        </div>
      </div>

      <div className="space-y-2">
        <p className="text-muted-foreground text-center text-sm">
          Can&apos;t scan? Enter this code manually:
        </p>
        <div className="bg-muted/50 flex items-center gap-2 rounded-md border p-2">
          <code className="flex-1 text-center font-mono text-sm">{totpData.secret}</code>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              void copy(totpData.secret);
            }}
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            <span className="sr-only">{copied ? 'Copied' : 'Copy'}</span>
          </Button>
        </div>
      </div>

      <ModalActions
        primary={{
          label: 'Continue →',
          onClick: onContinue,
        }}
      />
    </div>
  );
}

interface VerifyStepProps {
  otpValue: string;
  onOtpChange: (value: string) => void;
  onOtpComplete: (value: string) => void;
  error: string | null;
  isVerifying: boolean;
  onVerify: () => void;
}

function VerifyStep({
  otpValue,
  onOtpChange,
  onOtpComplete,
  error,
  isVerifying,
  onVerify,
}: Readonly<VerifyStepProps>): React.JSX.Element {
  return (
    <div className="space-y-4">
      <OverlayHeader
        title="Enter Verification Code"
        description="Enter the 6-digit code from your authenticator app."
      />

      <OtpInput value={otpValue} onChange={onOtpChange} onComplete={onOtpComplete} error={error} />

      <ModalActions
        primary={{
          label: 'Verify →',
          onClick: onVerify,
          disabled: otpValue.length !== 6,
          loading: isVerifying,
          loadingLabel: 'Verifying...',
        }}
      />
    </div>
  );
}
