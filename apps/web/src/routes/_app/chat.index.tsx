import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';
import {
  PRE_CREATION_CONVERSATION_ID,
  ROUTES,
  TEST_IDS,
  type FundingSource,
} from '@hushbox/shared';
import { ErrorBoundary } from '@hushbox/ui';
import { ChatWelcome } from '@/components/chat/page/chat-welcome';
import { promptPredictor } from '@/lib/prediction/prompt-predictor';
import { SUGGESTION_LIST_ALTERNATIVE_COUNT } from '@/lib/prediction/alternative-count';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { useStability } from '@/providers/stability-provider';
import { usePendingChatStore } from '@/stores/chat/pending-chat';
import { useTrialChatStore } from '@/stores/chat/trial-chat';
import { useUIModalsStore } from '@/stores/ui/modals';
import { useChatErrorStore } from '@/stores/chat/error';
import { useModels } from '@/hooks/models/models';
import { usePremiumModelClick } from '@/hooks/models/use-premium-model-click';
import { billingKeys, useBalance } from '@/hooks/billing/billing';

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

function ChatIndex(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session, isAuthenticated, isStable } = useStableSession();
  const { isAppStable } = useStability();
  useBalance();

  const {
    signupModalOpen,
    paymentModalOpen,
    premiumModelName,
    refusalReason,
    setSignupModalOpen,
    setPaymentModalOpen,
  } = useUIModalsStore(
    useShallow((s) => ({
      signupModalOpen: s.signupModalOpen,
      paymentModalOpen: s.paymentModalOpen,
      premiumModelName: s.premiumModelName,
      refusalReason: s.refusalReason,
      setSignupModalOpen: s.setSignupModalOpen,
      setPaymentModalOpen: s.setPaymentModalOpen,
    }))
  );

  const { data: modelsData } = useModels();
  const models = modelsData?.models ?? [];

  const handlePremiumClick = usePremiumModelClick(models, isAuthenticated);

  const sessionRef = React.useRef(session);
  React.useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  React.useEffect(() => {
    useChatErrorStore.getState().clearAll();
  }, []);

  const handleSend = React.useCallback(
    (content: string, fundingSource: FundingSource): void => {
      useChatErrorStore.getState().clearAll();
      const currentSession = sessionRef.current;
      const isUserAuthenticated = Boolean(currentSession?.user);
      if (isUserAuthenticated) {
        usePendingChatStore.getState().setPendingMessage(content, fundingSource);
        void navigate({
          to: ROUTES.CHAT_ID,
          params: { id: PRE_CREATION_CONVERSATION_ID },
          search: { fork: undefined },
        });
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
      data-testid={TEST_IDS.newChatPage}
      data-app-stable={String(isAppStable)}
      className="flex h-full flex-col"
    >
      <ChatWelcome
        onSend={handleSend}
        isAuthenticated={isAuthenticated}
        isLoading={!isStable}
        onPremiumClick={handlePremiumClick}
        predictor={promptPredictor(SUGGESTION_LIST_ALTERNATIVE_COUNT)}
      />
      <SignupModal
        open={signupModalOpen}
        onOpenChange={setSignupModalOpen}
        modelName={premiumModelName}
        reason={refusalReason}
      />
      {isAuthenticated && (
        <PaymentModal
          open={paymentModalOpen}
          onOpenChange={setPaymentModalOpen}
          modelName={premiumModelName}
          reason={refusalReason}
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
