import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Overlay, ModalActions } from '@hushbox/ui';
import { ROUTES } from '@hushbox/shared';

type SignupModalVariant = 'premium' | 'multi-model';

interface SignupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: SignupModalVariant;
  modelName?: string | undefined;
}

const VARIANT_CONFIG: Record<
  SignupModalVariant,
  { ariaLabel: string; testId: string; title: string }
> = {
  premium: {
    ariaLabel: 'Unlock premium models',
    testId: 'signup-modal',
    title: 'Unlock Premium Models',
  },
  'multi-model': {
    ariaLabel: 'Compare multiple models',
    testId: 'multi-model-signup-modal',
    title: 'Compare Multiple Models',
  },
};

function getSignupMessage(variant: SignupModalVariant, modelName?: string): React.JSX.Element {
  if (variant === 'multi-model') {
    return (
      <>
        Sign up for free to send your message to multiple AI models at once. Compare their responses
        side by side and find the best model for every task.
      </>
    );
  }
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
 * Modal prompting users to sign up.
 * Variants:
 * - 'premium': shown when a trial user clicks a premium model
 * - 'multi-model': shown when a trial user tries to select multiple models
 */
export function SignupModal({
  open,
  onOpenChange,
  variant = 'premium',
  modelName,
}: Readonly<SignupModalProps>): React.JSX.Element | null {
  const navigate = useNavigate();
  const config = VARIANT_CONFIG[variant];

  const handleSignUp = (): void => {
    onOpenChange(false);
    void navigate({ to: ROUTES.SIGNUP });
  };

  const handleMaybeLater = (): void => {
    onOpenChange(false);
  };

  if (!open) return null;

  return (
    <Overlay open={open} onOpenChange={onOpenChange} ariaLabel={config.ariaLabel}>
      <div
        data-testid={config.testId}
        className="bg-background w-[90vw] max-w-md rounded-lg border p-6 shadow-lg"
      >
        <h2 className="mb-4 text-xl font-semibold">{config.title}</h2>
        <p className="text-muted-foreground mb-6">{getSignupMessage(variant, modelName)}</p>
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
    </Overlay>
  );
}
