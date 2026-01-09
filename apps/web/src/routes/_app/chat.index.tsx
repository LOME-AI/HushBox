import * as React from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { NewChatPage } from '@/components/chat/new-chat-page';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { useSession } from '@/lib/auth';
import { usePendingChatStore } from '@/stores/pending-chat';
import { useModels } from '@/hooks/models';
import { billingKeys, useBalance } from '@/hooks/billing';

export const Route = createFileRoute('/_app/chat/')({
  component: ChatIndex,
});

export function ChatIndex(): React.JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending } = useSession();
  const isAuthenticated = !isPending && Boolean(session?.user);
  useBalance();

  const [showSignupModal, setShowSignupModal] = React.useState(false);
  const [showPaymentModal, setShowPaymentModal] = React.useState(false);
  const [premiumModelName, setPremiumModelName] = React.useState<string | undefined>();

  const { data: modelsData } = useModels();
  const models = modelsData?.models ?? [];

  const handleSend = (content: string): void => {
    usePendingChatStore.getState().setPendingMessage(content);
    void navigate({ to: '/chat/new' });
  };

  const handlePremiumClick = (modelId: string): void => {
    const model = models.find((m) => m.id === modelId);
    setPremiumModelName(model?.name);

    if (isAuthenticated) {
      setShowPaymentModal(true);
    } else {
      setShowSignupModal(true);
    }
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
        open={showSignupModal}
        onOpenChange={setShowSignupModal}
        modelName={premiumModelName}
      />
      <PaymentModal
        open={showPaymentModal}
        onOpenChange={setShowPaymentModal}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        }}
      />
    </div>
  );
}
