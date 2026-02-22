import * as React from 'react';
import { Check, X } from 'lucide-react';
import { IconButton } from '@hushbox/ui';
import { useAcceptMembership, useLeaveConversation } from '@/hooks/use-conversation-members';
import { LeaveConfirmationModal } from '@/components/chat/leave-confirmation-modal';

interface InboxConversation {
  id: string;
  title: string;
  currentEpoch: number;
  updatedAt: string;
  invitedByUsername?: string | null;
}

interface InboxContentProps {
  conversations: InboxConversation[];
}

export function InboxContent({ conversations }: Readonly<InboxContentProps>): React.JSX.Element {
  const acceptMembership = useAcceptMembership();
  const leaveConversation = useLeaveConversation();
  const [declineTarget, setDeclineTarget] = React.useState<string | null>(null);

  if (conversations.length === 0) {
    return (
      <div
        data-testid="inbox-content"
        className="text-sidebar-foreground/50 px-2 py-8 text-center text-sm"
      >
        No pending invites
      </div>
    );
  }

  return (
    <div data-testid="inbox-content" className="flex flex-col gap-2">
      {conversations.map((conv) => (
        <div key={conv.id} className="bg-sidebar-accent/30 rounded-lg px-3 py-2">
          {/* Row 1: Title + green check */}
          <div className="flex items-center justify-between gap-2">
            <p className="text-sidebar-foreground min-w-0 flex-1 truncate text-sm font-medium">
              {conv.title}
            </p>
            <IconButton
              aria-label={`Accept ${conv.title}`}
              className="text-green-500 hover:text-green-400"
              onClick={() => {
                acceptMembership.mutate({ conversationId: conv.id });
              }}
            >
              <Check className="h-4 w-4" />
            </IconButton>
          </div>
          {/* Row 2: Username + red X */}
          <div className="flex items-center justify-between gap-2">
            {conv.invitedByUsername ? (
              <p className="text-sidebar-foreground/50 min-w-0 flex-1 truncate text-xs">
                @{conv.invitedByUsername}
              </p>
            ) : (
              <span />
            )}
            <IconButton
              aria-label={`Decline ${conv.title}`}
              className="text-red-500 hover:text-red-400"
              onClick={() => {
                setDeclineTarget(conv.id);
              }}
            >
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      ))}

      <LeaveConfirmationModal
        open={declineTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeclineTarget(null);
        }}
        isOwner={false}
        onConfirm={() => {
          if (declineTarget) {
            leaveConversation.mutate({ conversationId: declineTarget });
          }
        }}
      />
    </div>
  );
}
