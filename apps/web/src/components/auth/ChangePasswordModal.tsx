import * as React from 'react';
import { useState, useCallback, useMemo, useRef } from 'react';
import { Alert, ModalOverlay, ModalActions } from '@hushbox/ui';
import { useFormEnterNav } from '@/hooks/use-form-enter-nav';
import { useMobileAutoFocus } from '@/hooks/use-mobile-auto-focus';
import { AuthPasswordInput } from '@/components/auth/AuthPasswordInput';

interface ChangePasswordModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  onSubmit: (data: {
    currentPassword: string;
    newPassword: string;
  }) => Promise<{ success: boolean; error?: string }>;
}

const MIN_PASSWORD_LENGTH = 8;

export function ChangePasswordModal({
  open,
  onOpenChange,
  onSuccess,
  onSubmit,
}: Readonly<ChangePasswordModalProps>): React.JSX.Element | null {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const passwordsMatch = useMemo(() => {
    if (confirmPassword === '') return true;
    return newPassword === confirmPassword;
  }, [newPassword, confirmPassword]);

  const passwordLongEnough = useMemo(() => {
    if (newPassword === '') return true;
    return newPassword.length >= MIN_PASSWORD_LENGTH;
  }, [newPassword]);

  const isValid = useMemo(() => {
    return (
      currentPassword.length > 0 &&
      newPassword.length >= MIN_PASSWORD_LENGTH &&
      newPassword === confirmPassword
    );
  }, [currentPassword, newPassword, confirmPassword]);

  const handleSubmit = useCallback(async () => {
    if (!isValid) return;

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await onSubmit({
        currentPassword,
        newPassword,
      });

      if (result.success) {
        onSuccess();
      } else {
        setError(result.error ?? 'Failed to change password');
      }
    } catch {
      setError('Failed to change password. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [isValid, currentPassword, newPassword, onSubmit, onSuccess]);

  const formRef = useRef<HTMLFormElement>(null);
  useFormEnterNav(formRef);
  const handleOpenAutoFocus = useMobileAutoFocus();

  // Reset state when modal opens
  React.useEffect(() => {
    if (open) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  return (
    <ModalOverlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Change password"
      onOpenAutoFocus={handleOpenAutoFocus}
    >
      <div
        data-testid="change-password-modal"
        className="bg-background w-[75vw] max-w-md rounded-lg border p-6 shadow-lg"
      >
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Change Password</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Enter your current password and choose a new one.
            </p>
          </div>

          {error && <Alert>{error}</Alert>}

          <form
            ref={formRef}
            onSubmit={(e) => {
              e.preventDefault();
              void handleSubmit();
            }}
          >
            <div className="space-y-4">
              <AuthPasswordInput
                id="current-password"
                label="Current Password"
                value={currentPassword}
                onChange={(e) => {
                  setCurrentPassword(e.target.value);
                }}
              />

              <AuthPasswordInput
                id="new-password"
                label="New Password"
                value={newPassword}
                onChange={(e) => {
                  setNewPassword(e.target.value);
                }}
                showStrength
                error={
                  passwordLongEnough
                    ? undefined
                    : `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters`
                }
              />

              <AuthPasswordInput
                id="confirm-password"
                label="Confirm New Password"
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                }}
                error={passwordsMatch ? undefined : 'Passwords do not match'}
              />
            </div>

            <ModalActions
              primary={{
                label: 'Change Password',
                onClick: () => void handleSubmit(),
                disabled: !isValid,
                loading: isSubmitting,
                loadingLabel: 'Changing...',
              }}
            />
          </form>
        </div>
      </div>
    </ModalOverlay>
  );
}
