import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ModalOverlay, Button } from '@lome-chat/ui';

interface SignupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional model name to show in the message */
  modelName?: string | undefined;
}

/**
 * Modal prompting users to sign up for premium model access.
 * Shown when a guest or free user clicks on a premium model.
 */
export function SignupModal({
  open,
  onOpenChange,
  modelName,
}: SignupModalProps): React.JSX.Element | null {
  const navigate = useNavigate();

  const handleSignUp = (): void => {
    void navigate({ to: '/signup' });
    onOpenChange(false);
  };

  const handleMaybeLater = (): void => {
    onOpenChange(false);
  };

  if (!open) return null;

  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange}>
      <div
        data-testid="signup-modal"
        className="bg-background w-full max-w-md rounded-lg border p-6 shadow-lg"
      >
        <h2 className="mb-4 text-xl font-semibold">Unlock Premium Models</h2>
        <p className="text-muted-foreground mb-6">
          {modelName ? (
            <>
              <span className="text-foreground font-medium">{modelName}</span> is a premium model.
              Sign up for free to access the most powerful AI models available.
            </>
          ) : (
            <>
              Sign up for free to access premium models including the latest and most powerful AI
              models available.
            </>
          )}
        </p>
        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={handleMaybeLater}>
            Maybe Later
          </Button>
          <Button onClick={handleSignUp}>Sign Up</Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
