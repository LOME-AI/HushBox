import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Overlay, OverlayContent, OverlayHeader, ModalActions } from '@hushbox/ui';
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
      <OverlayContent data-testid={config.testId}>
        <OverlayHeader title={config.title} description={getSignupMessage(variant, modelName)} />
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
      </OverlayContent>
    </Overlay>
  );
}
