import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders as render } from '@/test-utils/render';
import { ChatLayoutModals } from '@/components/chat/layout/chat-layout-modals';
import type * as React from 'react';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';

let lastShareModalProps: Record<string, unknown> | null = null;
const captured: Record<string, Record<string, unknown>> = {};

vi.mock('@/hooks/billing/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

vi.mock('@/components/auth/signup-modal', () => ({
  SignupModal: (props: Record<string, unknown>): null => {
    captured['signup'] = props;
    return null;
  },
}));

vi.mock('@/components/billing/payment-modal', () => ({
  PaymentModal: (props: Record<string, unknown>): null => {
    captured['payment'] = props;
    return null;
  },
}));

vi.mock('@/components/chat/member/add-member-modal', () => ({
  AddMemberModal: (props: Record<string, unknown>): null => {
    captured['addMember'] = props;
    return null;
  },
}));

vi.mock('@/components/chat/budget/budget-settings-modal', () => ({
  BudgetSettingsModal: (props: Record<string, unknown>): null => {
    captured['budget'] = props;
    return null;
  },
}));

vi.mock('@/components/chat/member/invite-link-modal', () => ({
  InviteLinkModal: (props: Record<string, unknown>): null => {
    captured['invite'] = props;
    return null;
  },
}));

vi.mock('@/components/chat/message/share-message-modal', () => ({
  ShareMessageModal: (props: Record<string, unknown>): null => {
    lastShareModalProps = props;
    captured['share'] = props;
    return null;
  },
}));

function invokeCaptured(key: string, property: string, ...args: unknown[]): void {
  const handler = captured[key]?.[property] as ((...a: unknown[]) => void) | undefined;
  handler?.(...args);
}

function makeGroupChat(overrides: Partial<GroupChatProps> = {}): GroupChatProps {
  return {
    conversationId: 'conv-1',
    members: [{ id: 'm1', userId: 'u1', username: 'a', privilege: 'owner' }],
    links: [],
    onlineMemberIds: new Set<string>(),
    currentUserId: 'u1',
    currentUserLinkId: null,
    currentUserPrivilege: 'owner',
    ...overrides,
  } as GroupChatProps;
}

describe('ChatLayoutModals', () => {
  beforeEach(() => {
    lastShareModalProps = null;
  });

  function renderModals(
    overrides: Partial<React.ComponentProps<typeof ChatLayoutModals>> = {}
  ): void {
    render(
      <ChatLayoutModals
        signupModalOpen={false}
        setSignupModalOpen={() => {}}
        paymentModalOpen={false}
        setPaymentModalOpen={() => {}}
        premiumModelName={undefined}
        refusalReason="insufficient_funds"
        shareMessageModalOpen
        closeShareMessageModal={() => {}}
        shareMessageId="m1"
        shareMessageConversationId="conv-1"
        sharedMessageContent="hi"
        sharedMessageEpochNumber={3}
        sharedMessageWrappedContentKey="wrapped"
        sharedMessageMediaItems={null}
        sharedMessageSenderId="sender-42"
        sharedMessageReasoningTokens={null}
        sharedMessageReasoningEffort={null}
        groupChat={undefined}
        title={undefined}
        addMemberModalOpen={false}
        closeAddMemberModal={() => {}}
        budgetSettingsModalOpen={false}
        closeBudgetSettingsModal={() => {}}
        inviteLinkModalOpen={false}
        closeInviteLinkModal={() => {}}
        {...overrides}
      />
    );
  }

  it('forwards the refused row to the payment modal so its notice can name it', () => {
    renderModals({ premiumModelName: 'GPT-5' });

    expect(captured['payment']?.['reason']).toBe('insufficient_funds');
    expect(captured['payment']?.['modelName']).toBe('GPT-5');
  });

  it('forwards the refusal reason to the signup modal so its sentence can match the row', () => {
    renderModals();

    expect(captured['signup']?.['reason']).toBe('insufficient_funds');
  });

  it('forwards the shared message senderId to ShareMessageModal so its media preview can build the envelope', () => {
    renderModals();

    expect(lastShareModalProps?.['senderId']).toBe('sender-42');
  });

  it('forwards the reasoning the link publishes to ShareMessageModal so the preview can disclose it', () => {
    renderModals({ sharedMessageReasoningTokens: 1204, sharedMessageReasoningEffort: 'high' });

    expect(lastShareModalProps?.['reasoningTokens']).toBe(1204);
    expect(lastShareModalProps?.['reasoningEffort']).toBe('high');
  });

  it('routes each modal close through its close handler and invalidates balance on payment success', () => {
    const closeAddMemberModal = vi.fn();
    const closeBudgetSettingsModal = vi.fn();
    const closeInviteLinkModal = vi.fn();
    const closeShareMessageModal = vi.fn();
    const onAddMember = vi.fn();

    render(
      <ChatLayoutModals
        signupModalOpen={false}
        setSignupModalOpen={() => {}}
        paymentModalOpen
        setPaymentModalOpen={() => {}}
        premiumModelName="GPT-5"
        refusalReason="insufficient_funds"
        shareMessageModalOpen
        closeShareMessageModal={closeShareMessageModal}
        shareMessageId="m1"
        shareMessageConversationId="conv-1"
        sharedMessageContent="hi"
        sharedMessageEpochNumber={3}
        sharedMessageWrappedContentKey="wrapped"
        sharedMessageMediaItems={null}
        sharedMessageSenderId="sender-42"
        sharedMessageReasoningTokens={null}
        sharedMessageReasoningEffort={null}
        groupChat={makeGroupChat({ onAddMember })}
        title="My Chat"
        addMemberModalOpen
        closeAddMemberModal={closeAddMemberModal}
        budgetSettingsModalOpen
        closeBudgetSettingsModal={closeBudgetSettingsModal}
        inviteLinkModalOpen
        closeInviteLinkModal={closeInviteLinkModal}
      />
    );

    // Payment success invalidates the balance query (no throw).
    invokeCaptured('payment', 'onSuccess');

    // Each modal's onOpenChange(false) delegates to its close handler.
    invokeCaptured('addMember', 'onOpenChange', false);
    invokeCaptured('budget', 'onOpenChange', false);
    invokeCaptured('invite', 'onOpenChange', false);
    invokeCaptured('share', 'onOpenChange', false);

    expect(closeAddMemberModal).toHaveBeenCalledTimes(1);
    expect(closeBudgetSettingsModal).toHaveBeenCalledTimes(1);
    expect(closeInviteLinkModal).toHaveBeenCalledTimes(1);
    expect(closeShareMessageModal).toHaveBeenCalledTimes(1);

    // onOpenChange(true) must NOT trigger a close for any modal.
    invokeCaptured('addMember', 'onOpenChange', true);
    invokeCaptured('budget', 'onOpenChange', true);
    invokeCaptured('invite', 'onOpenChange', true);
    invokeCaptured('share', 'onOpenChange', true);
    expect(closeAddMemberModal).toHaveBeenCalledTimes(1);
    expect(closeBudgetSettingsModal).toHaveBeenCalledTimes(1);
    expect(closeInviteLinkModal).toHaveBeenCalledTimes(1);
    expect(closeShareMessageModal).toHaveBeenCalledTimes(1);

    // The add-member handler is the provided callback.
    expect(captured['addMember']?.['onAddMember']).toBe(onAddMember);
  });

  it("hands the invite-link modal the group's current-epoch key", () => {
    const currentEpochKey = { epochNumber: 4, privateKey: new Uint8Array(32).fill(4) };

    renderModals({ groupChat: makeGroupChat({ currentEpochKey }) });

    expect(captured['invite']?.['currentEpochKey']).toBe(currentEpochKey);
  });

  it('hands the invite-link modal no key while the group has no verified one', () => {
    renderModals({ groupChat: makeGroupChat() });

    expect(Object.keys(captured['invite'] ?? {})).toContain('currentEpochKey');
    expect(captured['invite']?.['currentEpochKey']).toBeUndefined();
  });

  it('falls back to a noop add-member handler when the group chat omits one', () => {
    render(
      <ChatLayoutModals
        signupModalOpen={false}
        setSignupModalOpen={() => {}}
        paymentModalOpen={false}
        setPaymentModalOpen={() => {}}
        premiumModelName={undefined}
        refusalReason={undefined}
        shareMessageModalOpen={false}
        closeShareMessageModal={() => {}}
        shareMessageId={null}
        shareMessageConversationId={null}
        sharedMessageContent={null}
        sharedMessageEpochNumber={null}
        sharedMessageWrappedContentKey={null}
        sharedMessageMediaItems={null}
        sharedMessageSenderId=""
        sharedMessageReasoningTokens={null}
        sharedMessageReasoningEffort={null}
        groupChat={makeGroupChat({ onAddMember: undefined })}
        title={undefined}
        addMemberModalOpen={false}
        closeAddMemberModal={() => {}}
        budgetSettingsModalOpen={false}
        closeBudgetSettingsModal={() => {}}
        inviteLinkModalOpen={false}
        closeInviteLinkModal={() => {}}
      />
    );

    const noop = captured['addMember']?.['onAddMember'] as () => void;
    expect(() => {
      noop();
    }).not.toThrow();
    // Group chat with title undefined passes an empty plaintext title to the invite modal.
    expect(captured['invite']?.['plaintextTitle']).toBe('');
  });
});
