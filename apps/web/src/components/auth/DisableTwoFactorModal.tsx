import * as React from 'react';
import { useState, useCallback, useRef } from 'react';
import { ModalOverlay, ModalActions } from '@hushbox/ui';
import { useFormEnterNav } from '@/hooks/use-form-enter-nav';
import { useMobileAutoFocus } from '@/hooks/use-mobile-auto-focus';
import { useOtpVerification } from '@/hooks/use-otp-verification';
import { AuthPasswordInput } from '@/components/auth/AuthPasswordInput';
import { OtpInput } from '@/components/auth/otp-input';
import { disable2FAInit, disable2FAFinish } from '@/lib/auth';

interface DisableTwoFactorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

export function DisableTwoFactorModal({
  open,
  onOpenChange,
  onSuccess,
}: Readonly<DisableTwoFactorModalProps>): React.JSX.Element | null {
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isPasswordSubmitting, setIsPasswordSubmitting] = useState(false);
  const [ke3, setKe3] = useState<number[] | null>(null);

  const disableVerify = useCallback(
    async (code: string): Promise<{ success: boolean; error?: string }> => {
      if (!ke3) return { success: false, error: 'Missing authentication data' };
      return disable2FAFinish(ke3, code);
    },
    [ke3]
  );

  const {
    otpValue,
    setOtpValue,
    error: otpError,
    isVerifying,
    handleVerify,
    handleComplete,
    reset: resetOtp,
  } = useOtpVerification({ onVerify: disableVerify, onSuccess });

  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const handleOpenAutoFocus = useMobileAutoFocus();

  // Reset state when modal opens
  React.useEffect(() => {
    if (open) {
      setStep('password');
      setPassword('');
      setPasswordError(null);
      setIsPasswordSubmitting(false);
      setKe3(null);
      resetOtp();
    }
  }, [open, resetOtp]);

  const handlePasswordSubmit = useCallback(async () => {
    if (password.length === 0) return;

    setIsPasswordSubmitting(true);
    setPasswordError(null);

    try {
      const result = await disable2FAInit(password);

      if (result.success) {
        setKe3(result.ke3);
        setStep('code');
      } else {
        setPasswordError(result.error);
      }
    } catch {
      setPasswordError('Failed to verify password. Please try again.');
    } finally {
      setIsPasswordSubmitting(false);
    }
  }, [password]);

  const handleBack = useCallback(() => {
    setStep('password');
    resetOtp();
  }, [resetOtp]);

  if (!open) return null;

  return (
    <ModalOverlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Disable two-factor authentication"
      onOpenAutoFocus={handleOpenAutoFocus}
      currentStep={step === 'password' ? 1 : 2}
      {...(step === 'code' && { onBack: handleBack })}
    >
      <div
        data-testid="disable-two-factor-modal"
        className="bg-background w-[75vw] max-w-md rounded-lg border p-6 shadow-lg"
      >
        <div className="space-y-4">
          {step === 'password' ? (
            <form
              ref={formRef}
              onSubmit={(e) => {
                e.preventDefault();
                void handlePasswordSubmit();
              }}
            >
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">Disable Two-Factor Authentication</h2>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Enter your password to confirm. This will remove the extra security layer from
                    your account.
                  </p>
                </div>

                <AuthPasswordInput
                  id="current-password"
                  label="Current Password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                  }}
                />

                {passwordError && <p className="text-destructive text-sm">{passwordError}</p>}

                <ModalActions
                  primary={{
                    label: 'Continue',
                    onClick: () => {
                      void handlePasswordSubmit();
                    },
                    disabled: password.length === 0,
                    loading: isPasswordSubmitting,
                    loadingLabel: 'Verifying...',
                  }}
                />
              </div>
            </form>
          ) : (
            <>
              <div>
                <h2 className="text-lg font-semibold">Enter Verification Code</h2>
                <p className="text-muted-foreground mt-1 text-sm">
                  Enter the 6-digit code from your authenticator app to confirm.
                </p>
              </div>

              <OtpInput
                value={otpValue}
                onChange={setOtpValue}
                onComplete={handleComplete}
                error={otpError}
              />

              <ModalActions
                primary={{
                  label: 'Disable 2FA',
                  variant: 'destructive',
                  onClick: () => {
                    handleVerify();
                  },
                  disabled: otpValue.length !== 6,
                  loading: isVerifying,
                  loadingLabel: 'Disabling...',
                }}
              />
            </>
          )}
        </div>
      </div>
    </ModalOverlay>
  );
}
