import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ROUTES } from '@hushbox/shared';
import { useLeaveConversation } from '@/hooks/realtime/use-conversation-members';
import { leaveConversation } from '@/lib/chat/leave-conversation';
import { LeaveConfirmationModal } from '@/components/chat/member/leave-confirmation-modal';
import type { SidebarConversation } from './chat-item';

/**
 * Opens the leave-confirmation modal for a sidebar conversation row.
 * `isActive` is whether the row's conversation is the one currently open, which
 * decides post-leave navigation.
 */
type RequestLeave = (conversation: SidebarConversation, isActive: boolean) => void;

function missingProvider(): never {
  throw new Error('useRequestLeave must be used within a LeaveConversationProvider');
}

const LeaveConversationContext = React.createContext<RequestLeave>(missingProvider);

export function useRequestLeave(): RequestLeave {
  return React.useContext(LeaveConversationContext);
}

interface LeaveTarget {
  conversation: SidebarConversation;
  isActive: boolean;
}

/**
 * Owns the sidebar leave-confirmation modal so it outlives the row that opens
 * it. Confirming a leave invalidates the conversation-list query, which drops
 * that row and unmounts its `ChatItem`; if the modal lived inside the row it
 * would unmount mid-close, and on touch devices vaul leaves the drawer's
 * portaled node stuck in the DOM. Rendering the modal here — a stable ancestor
 * of every row — lets the auto-close land on a still-mounted component.
 */
export function LeaveConversationProvider({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const navigate = useNavigate();
  const leaveMutation = useLeaveConversation();
  const [target, setTarget] = React.useState<LeaveTarget | null>(null);

  const requestLeave = React.useCallback<RequestLeave>((conversation, isActive) => {
    setTarget({ conversation, isActive });
  }, []);

  const handleConfirmLeave = React.useCallback(async (): Promise<void> => {
    /* v8 ignore next -- onConfirm only fires while the modal is open, which requires a non-null target; this is a defensive type-narrow */
    if (!target) return;
    await leaveConversation({
      conversationId: target.conversation.id,
      leave: leaveMutation.mutateAsync,
    });
    // Only redirect when the user was viewing the chat that just disappeared —
    // leaving a non-active chat from the sidebar leaves the URL alone.
    if (target.isActive) void navigate({ to: ROUTES.CHAT });
  }, [target, leaveMutation, navigate]);

  return (
    <LeaveConversationContext.Provider value={requestLeave}>
      {children}
      <LeaveConfirmationModal
        open={target !== null}
        // The modal is controlled and has no trigger, so ActionModal only ever
        // requests a close (cancel, dismiss, or auto-close on success) — clear
        // the target unconditionally.
        onOpenChange={() => {
          setTarget(null);
        }}
        isOwner={false}
        onConfirm={handleConfirmLeave}
      />
    </LeaveConversationContext.Provider>
  );
}
