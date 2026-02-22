import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ModalOverlay, ModalActions } from '@hushbox/ui';
import { ROUTES } from '@hushbox/shared';

interface SignupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelName?: string | undefined;
}

function getSignupMessage(modelName?: string): React.JSX.Element {
  if (modelName) {
    return (
      <>
        <span className="text-foreground font-medium">{modelName}</span> is a premium model. Sign up
        for free to access the most powerful AI models available.
      </>
    );
  }
  return (
    <>
      Sign up for free to access premium models including the latest and most powerful AI models
      available.
    </>
  );
}

/**
 * Modal prompting users to sign up for premium model access.
 * Shown when a trial or free user clicks on a premium model.
 */
export function SignupModal({
  open,
  onOpenChange,
  modelName,
}: Readonly<SignupModalProps>): React.JSX.Element | null {
  const navigate = useNavigate();

  const handleSignUp = (): void => {
    void navigate({ to: ROUTES.SIGNUP });
    onOpenChange(false);
  };

  const handleMaybeLater = (): void => {
    onOpenChange(false);
  };

  if (!open) return null;

  return (
    <ModalOverlay open={open} onOpenChange={onOpenChange} ariaLabel="Unlock premium models">
      <div
        data-testid="signup-modal"
        className="bg-background w-[90vw] max-w-md rounded-lg border p-6 shadow-lg"
      >
        <h2 className="mb-4 text-xl font-semibold">Unlock Premium Models</h2>
        <p className="text-muted-foreground mb-6">{getSignupMessage(modelName)}</p>
        <ModalActions
          cancel={{
            label: 'Maybe Later',
            onClick: handleMaybeLater,
          }}
          primary={{
            label: 'Sign Up',
            onClick: handleSignUp,
          }}
        />
      </div>
    </ModalOverlay>
  );
}
