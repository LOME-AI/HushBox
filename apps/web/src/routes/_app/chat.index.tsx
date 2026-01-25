import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ChatWelcome } from '@/components/chat/chat-welcome';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { useStableSession } from '@/hooks/use-stable-session';
import { usePendingChatStore } from '@/stores/pending-chat';
import { useGuestChatStore } from '@/stores/guest-chat';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useModels } from '@/hooks/models';
import { usePremiumModelClick } from '@/hooks/use-premium-model-click';
import { billingKeys, useBalance } from '@/hooks/billing';
import { ROUTES } from '@/lib/routes';

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
  useBalance();

  const {
    signupModalOpen,
    signupModalVariant,
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

  const handleSend = React.useCallback(
    (content: string): void => {
      const currentSession = sessionRef.current;
      const isUserAuthenticated = Boolean(currentSession?.user);
      if (isUserAuthenticated) {
        usePendingChatStore.getState().setPendingMessage(content);
        void navigate({ to: ROUTES.CHAT_ID, params: { id: 'new' } });
      } else {
        useGuestChatStore.getState().reset();
        useGuestChatStore.getState().setPendingMessage(content);
        void navigate({ to: ROUTES.CHAT_GUEST });
      }
    },
    [navigate]
  );

  return (
    <div data-testid="new-chat-page" className="flex h-full flex-col">
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
        variant={signupModalVariant}
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
