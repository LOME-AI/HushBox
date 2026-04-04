import * as React from 'react';
import { Overlay, OverlayContent, OverlayHeader, ModalActions } from '@hushbox/ui';
import { useMobileAutoFocus } from '@/hooks/use-mobile-auto-focus';
import { useOtpVerification } from '@/hooks/use-otp-verification';
import { OtpInput } from '@/components/auth/otp-input';

interface TwoFactorInputProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  onVerify: (code: string) => Promise<{ success: boolean; error?: string }>;
  showRecoveryOption?: boolean;
  onRecoveryClick?: () => void;
}

export function TwoFactorInput({
  open,
  onOpenChange,
  onSuccess,
  onVerify,
  showRecoveryOption = false,
  onRecoveryClick,
}: Readonly<TwoFactorInputProps>): React.JSX.Element | null {
  const { otpValue, setOtpValue, error, isVerifying, handleVerify, handleComplete, reset } =
    useOtpVerification({ onVerify, onSuccess });
  const handleOpenAutoFocus = useMobileAutoFocus();

  // Reset state when modal opens
  React.useEffect(() => {
    if (open) {
      reset();
    }
  }, [open, reset]);

  if (!open) return null;

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Two-factor authentication"
      onOpenAutoFocus={handleOpenAutoFocus}
    >
      <OverlayContent data-testid="two-factor-input-modal" className="w-full">
        <OverlayHeader
          title="Two-Factor Authentication"
          description="Enter the 6-digit code from your authenticator app."
        />

        <OtpInput
          value={otpValue}
          onChange={setOtpValue}
          onComplete={handleComplete}
          error={error}
        />

        <ModalActions
          primary={{
            label: 'Verify',
            onClick: () => {
              handleVerify();
            },
            disabled: otpValue.length !== 6,
            loading: isVerifying,
            loadingLabel: 'Verifying...',
          }}
        />

        {showRecoveryOption && (
          <div className="text-center">
            <button
              type="button"
              onClick={onRecoveryClick}
              className="text-muted-foreground hover:text-foreground text-sm underline-offset-4 hover:underline"
            >
              Use recovery code instead
            </button>
          </div>
        )}
      </OverlayContent>
    </Overlay>
  );
}
