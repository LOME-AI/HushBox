import * as React from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Logo } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { Swatch } from '@hushbox/ui/marks';
import { Overlay, OverlayContent, OverlayFooter, OverlayHeader } from '@hushbox/ui/overlay';
import { NOTICE_COPY, ROUTES, TEST_IDS } from '@hushbox/shared';
import { modelSwatch } from '@/lib/utils/model-color';
import { useUIModalsStore } from '@/stores/ui/modals';
import { AuthFeatureList } from '@/components/auth/auth-feature-list';
import type { RefusalCode } from '@hushbox/shared';

type SignupModalVariant = 'premium' | 'multi-model';

interface SignupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: SignupModalVariant;
  modelName?: string | undefined;
  /**
   * Why the row the visitor clicked was refused. Every refusal reaches this
   * modal when there is no session, so the sentence has to come from the reason
   * rather than from the tier: most of them are not about premium at all.
   */
  reason?: RefusalCode | undefined;
}

const VARIANT_CONFIG: Record<SignupModalVariant, { testId: string; title: string }> = {
  premium: {
    testId: TEST_IDS.signupModal,
    title: 'Unlock Premium Models',
  },
  'multi-model': {
    testId: TEST_IDS.multiModelSignupModal,
    title: 'Compare Multiple Models',
  },
};

/**
 * The two refusals the premium heading is true of. Every other refusal, including
 * any added later, heads with {@link ACCOUNT_TITLE}, which is true of any refused
 * row because this modal opens only when there is no session. The default is the
 * safe one, so a new code inherits a true heading.
 */
const PREMIUM_TITLE_CODES: ReadonlySet<RefusalCode> = new Set<RefusalCode>([
  'premium_requires_account',
  'premium_requires_credit',
]);

/** Verbatim the heading of the sign-up form on the page this modal sends the visitor to. */
const ACCOUNT_TITLE = 'Create your account';

function getSignupTitle(variant: SignupModalVariant, reason?: RefusalCode): string {
  if (variant === 'premium' && reason !== undefined && !PREMIUM_TITLE_CODES.has(reason)) {
    return ACCOUNT_TITLE;
  }
  return VARIANT_CONFIG[variant].title;
}

function getSignupMessage(
  variant: SignupModalVariant,
  modelName?: string,
  reason?: RefusalCode
): React.JSX.Element {
  if (variant === 'multi-model') {
    return (
      <>
        Sign up for free to send your message to multiple AI models at once. Compare their responses
        side by side and find the best model for every task.
      </>
    );
  }
  if (reason) {
    // The one home for refusal copy, so this door says the same thing the row's
    // own notice says rather than a second wording of it. The name sits on the
    // model line above that sentence, never composed into it: a sentence naming
    // the model would be copy this vocabulary does not hold.
    return <>{NOTICE_COPY[reason].cause}</>;
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

/** The refused model's swatch and name, the swatch only when the click that opened the modal recorded its id. */
function ModelLine({
  name,
  id,
}: Readonly<{ name: string; id: string | undefined }>): React.JSX.Element {
  return (
    <p className="text-foreground inline-flex items-center gap-2 text-[0.9375rem] font-semibold">
      {id !== undefined && <Swatch swatch={modelSwatch(id)} />}
      {name}
    </p>
  );
}

/**
 * Modal prompting users to sign up.
 * Variants:
 * - 'premium': shown when a signed-out visitor clicks a row they cannot use
 * - 'multi-model': shown when a trial user tries to select multiple models
 */
export function SignupModal({
  open,
  onOpenChange,
  variant = 'premium',
  modelName,
  reason,
}: Readonly<SignupModalProps>): React.JSX.Element | null {
  const navigate = useNavigate();
  const modelId = useUIModalsStore((state) => state.premiumModelId);
  const config = VARIANT_CONFIG[variant];
  const title = getSignupTitle(variant, reason);

  const handleSignUp = (): void => {
    onOpenChange(false);
    void navigate({ to: ROUTES.SIGNUP });
  };

  const handleMaybeLater = (): void => {
    onOpenChange(false);
  };

  if (!open) return null;

  return (
    <Overlay open={open} onOpenChange={onOpenChange} ariaLabel={title}>
      <OverlayContent size="sm" data-testid={config.testId}>
        <OverlayHeader
          title={title}
          size="lg"
          align="center"
          media={<Logo mark className="size-10" />}
          {...(modelName !== undefined && { meta: <ModelLine name={modelName} id={modelId} /> })}
          description={getSignupMessage(variant, modelName, reason)}
        />
        {/* Cancels the list's own top margin and the header's space before a first input, so the rule sits 1.25rem under the sentence. */}
        <div className="-mt-5 self-center">
          <AuthFeatureList />
        </div>
        <OverlayFooter>
          <Button variant="outline" onClick={handleMaybeLater}>
            Maybe Later
          </Button>
          <Button onClick={handleSignUp}>Sign Up</Button>
        </OverlayFooter>
        <p className="text-muted-foreground text-center text-sm">
          Already have an account?{' '}
          <Link
            to={ROUTES.LOGIN}
            onClick={() => {
              onOpenChange(false);
            }}
            className="text-primary underline-offset-4 hover:underline"
          >
            Log in
          </Link>
        </p>
      </OverlayContent>
    </Overlay>
  );
}
