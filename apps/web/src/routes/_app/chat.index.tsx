import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { NewChatPage } from '@/components/chat/new-chat-page';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { ErrorBoundary } from '@/components/shared/error-boundary';
import { useSession } from '@/lib/auth';
import { usePendingChatStore } from '@/stores/pending-chat';
import { useUIModalsStore } from '@/stores/ui-modals';
import { useModels } from '@/hooks/models';
import { usePremiumModelClick } from '@/hooks/use-premium-model-click';
import { billingKeys, useBalance } from '@/hooks/billing';

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
  const { data: session, isPending } = useSession();
  const isAuthenticated = !isPending && Boolean(session?.user);
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

  const handleSend = (content: string): void => {
    usePendingChatStore.getState().setPendingMessage(content);
    void navigate({ to: '/chat/new' });
  };

  return (
    <div className="flex h-full flex-col">
      <NewChatPage
        onSend={handleSend}
        isAuthenticated={isAuthenticated}
        isLoading={isPending}
        onPremiumClick={handlePremiumClick}
      />
      <SignupModal
        open={signupModalOpen}
        onOpenChange={setSignupModalOpen}
        modelName={premiumModelName}
      />
      <PaymentModal
        open={paymentModalOpen}
        onOpenChange={setPaymentModalOpen}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        }}
      />
    </div>
  );
}
