import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SignupModal } from '@/components/auth/signup-modal';
import { PaymentModal } from '@/components/billing/payment-modal';
import { AddMemberModal } from '@/components/chat/member/add-member-modal';
import { BudgetSettingsModal } from '@/components/chat/budget/budget-settings-modal';
import { InviteLinkModal } from '@/components/chat/member/invite-link-modal';
import { ShareMessageModal } from '@/components/chat/message/share-message-modal';
import { billingKeys } from '@/hooks/billing/billing';
import type { RefusalCode } from '@hushbox/shared';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { ShareMessageReply } from '@/components/chat/message/share-message-modal';

interface GroupChatModalsProps {
  groupChat: GroupChatProps;
  plaintextTitle: string;
  addMemberModalOpen: boolean;
  closeAddMemberModal: () => void;
  budgetSettingsModalOpen: boolean;
  closeBudgetSettingsModal: () => void;
  inviteLinkModalOpen: boolean;
  closeInviteLinkModal: () => void;
}

function GroupChatModals({
  groupChat,
  plaintextTitle,
  addMemberModalOpen,
  closeAddMemberModal,
  budgetSettingsModalOpen,
  closeBudgetSettingsModal,
  inviteLinkModalOpen,
  closeInviteLinkModal,
}: Readonly<GroupChatModalsProps>): React.JSX.Element {
  return (
    <>
      <AddMemberModal
        open={addMemberModalOpen}
        onOpenChange={(open) => {
          if (!open) closeAddMemberModal();
        }}
        conversationId={groupChat.conversationId}
        memberCount={groupChat.members.length + groupChat.links.length}
        onAddMember={
          groupChat.onAddMember ??
          (() => {
            /* noop */
          })
        }
      />
      <BudgetSettingsModal
        open={budgetSettingsModalOpen}
        onOpenChange={(open) => {
          if (!open) closeBudgetSettingsModal();
        }}
        conversationId={groupChat.conversationId}
        currentUserPrivilege={groupChat.currentUserPrivilege}
      />
      <InviteLinkModal
        open={inviteLinkModalOpen}
        onOpenChange={(open) => {
          if (!open) closeInviteLinkModal();
        }}
        conversationId={groupChat.conversationId}
        currentEpochKey={groupChat.currentEpochKey}
        plaintextTitle={plaintextTitle}
        memberCount={groupChat.members.length + groupChat.links.length}
      />
    </>
  );
}

interface ChatLayoutModalsProps {
  readonly signupModalOpen: boolean;
  readonly setSignupModalOpen: (open: boolean) => void;
  readonly paymentModalOpen: boolean;
  readonly setPaymentModalOpen: (open: boolean) => void;
  readonly premiumModelName: string | undefined;
  readonly refusalReason: RefusalCode | undefined;
  readonly shareMessageModalOpen: boolean;
  readonly closeShareMessageModal: () => void;
  readonly shareMessageConversationId: string | null;
  readonly sharedMessage: ShareMessageReply | null;
  readonly groupChat: GroupChatProps | undefined;
  readonly title: string | undefined;
  readonly addMemberModalOpen: boolean;
  readonly closeAddMemberModal: () => void;
  readonly budgetSettingsModalOpen: boolean;
  readonly closeBudgetSettingsModal: () => void;
  readonly inviteLinkModalOpen: boolean;
  readonly closeInviteLinkModal: () => void;
}

export function ChatLayoutModals({
  signupModalOpen,
  setSignupModalOpen,
  paymentModalOpen,
  setPaymentModalOpen,
  premiumModelName,
  refusalReason,
  shareMessageModalOpen,
  closeShareMessageModal,
  shareMessageConversationId,
  sharedMessage,
  groupChat,
  title,
  addMemberModalOpen,
  closeAddMemberModal,
  budgetSettingsModalOpen,
  closeBudgetSettingsModal,
  inviteLinkModalOpen,
  closeInviteLinkModal,
}: Readonly<ChatLayoutModalsProps>): React.JSX.Element {
  const queryClient = useQueryClient();

  return (
    <>
      <SignupModal
        open={signupModalOpen}
        onOpenChange={setSignupModalOpen}
        modelName={premiumModelName}
        reason={refusalReason}
      />
      <PaymentModal
        open={paymentModalOpen}
        onOpenChange={setPaymentModalOpen}
        modelName={premiumModelName}
        reason={refusalReason}
        onSuccess={() => {
          void queryClient.invalidateQueries({ queryKey: billingKeys.balance() });
        }}
      />
      {groupChat && (
        <GroupChatModals
          groupChat={groupChat}
          plaintextTitle={title ?? ''}
          addMemberModalOpen={addMemberModalOpen}
          closeAddMemberModal={closeAddMemberModal}
          budgetSettingsModalOpen={budgetSettingsModalOpen}
          closeBudgetSettingsModal={closeBudgetSettingsModal}
          inviteLinkModalOpen={inviteLinkModalOpen}
          closeInviteLinkModal={closeInviteLinkModal}
        />
      )}
      <ShareMessageModal
        open={shareMessageModalOpen}
        onOpenChange={(open) => {
          if (!open) closeShareMessageModal();
        }}
        message={sharedMessage}
        conversationId={shareMessageConversationId}
      />
    </>
  );
}
