import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChatWelcome } from '@/components/chat/chat-welcome';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { useStableSession } from '@/hooks/use-stable-session';
import { useStability } from '@/providers/stability-provider';
import { usePendingChatStore } from '@/stores/pending-chat';
import { useTrialChatStore } from '@/stores/trial-chat';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useChatErrorStore } from '@/stores/chat-error';
import { useModels } from '@/hooks/models';
import { usePremiumModelClick } from '@/hooks/use-premium-model-click';
import { billingKeys, useBalance } from '@/hooks/billing';
import { ROUTES, type FundingSource } from '@hushbox/shared';

export const Route = createFileRoute('/_app/chat/')({
  component: ChatIndexWithErrorBoundary,
});

function ChatIndexWithErrorBoundary(): React.JSX.Element {
  return (
    <ErrorBoundary>
      <ChatIndex />
    </ErrorBoundary>
  );
}

export function ChatIndex(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session, isAuthenticated, isStable } = useStableSession();
  const { isAppStable } = useStability();
  useBalance();

  const {
    signupModalOpen,
    paymentModalOpen,
    premiumModelName,
    setSignupModalOpen,
    setPaymentModalOpen,
  } = useUIModalsStore();

  const { data: modelsData } = useModels();
  const models = modelsData?.models ?? [];

  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);

  const sessionRef = React.useRef(session);
  React.useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  React.useEffect(() => {
    useChatErrorStore.getState().clearError();
  }, []);

  const handleSend = React.useCallback(
    (content: string, fundingSource: FundingSource): void => {
      useChatErrorStore.getState().clearError();
      const currentSession = sessionRef.current;
      const isUserAuthenticated = Boolean(currentSession?.user);
      if (isUserAuthenticated) {
        usePendingChatStore.getState().setPendingMessage(content, fundingSource);
        void navigate({ to: ROUTES.CHAT_ID, params: { id: 'new' } });
      } else {
        useTrialChatStore.getState().reset();
        useTrialChatStore.getState().setPendingMessage(content);
        void navigate({ to: ROUTES.CHAT_TRIAL });
      }
    },
    [navigate]
  );

  return (
    <div
      data-testid="new-chat-page"
      data-app-stable={String(isAppStable)}
      className="flex h-full flex-col"
    >
      <ChatWelcome
        onSend={handleSend}
        isAuthenticated={isAuthenticated}
        isLoading={!isStable}
        onPremiumClick={handlePremiumClick}
      />
      <SignupModal
        open={signupModalOpen}
        onOpenChange={setSignupModalOpen}
        modelName={premiumModelName}
      />
      {isAuthenticated && (
        <PaymentModal
          open={paymentModalOpen}
          onOpenChange={setPaymentModalOpen}
          onSuccess={() => {
            void (async () => {
              try {
                await queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
              } catch (error: unknown) {
                console.error(error);
              }
            })();
          }}
        />
      )}
    </div>
  );
}
