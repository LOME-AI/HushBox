import * as React from 'react';
import { Check, X } from 'lucide-react';
import { IconButton } from '@hushbox/ui';
import { TEST_IDS, ERROR_CODES, friendlyErrorMessage } from '@hushbox/shared';
import {
  useAcceptMembership,
  useDeclineInvitation,
} from '@/hooks/realtime/use-conversation-members';
import { LeaveConfirmationModal } from '@/components/chat/member/leave-confirmation-modal';

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
  const declineInvitation = useDeclineInvitation();
  const [declineTarget, setDeclineTarget] = React.useState<string | null>(null);
  // One accept mutation backs every row, so its own pending flag cannot say
  // which invitation is in flight or which one failed. The id captured at the
  // click can, and the failure has to stay attached to the row that produced it.
  const [acceptingId, setAcceptingId] = React.useState<string | null>(null);
  const [acceptFailedId, setAcceptFailedId] = React.useState<string | null>(null);

  if (conversations.length === 0) {
    return (
      <div
        data-testid={TEST_IDS.inboxContent}
        className="text-sidebar-foreground/50 px-2 py-8 text-center text-sm"
      >
        No pending invites
      </div>
    );
  }

  return (
    <div data-testid={TEST_IDS.inboxContent} className="flex flex-col gap-2">
      {conversations.map((conv) => (
        <div key={conv.id} className="bg-sidebar-accent/30 rounded-lg px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sidebar-foreground min-w-0 flex-1 truncate text-sm font-medium">
              {conv.title}
            </p>
            <IconButton
              aria-label={`Accept ${conv.title}`}
              className="text-success hover:text-success/80"
              disabled={acceptingId === conv.id}
              aria-busy={acceptingId === conv.id}
              onClick={() => {
                setAcceptingId(conv.id);
                setAcceptFailedId(null);
                acceptMembership.mutate(
                  { conversationId: conv.id },
                  {
                    // Subscribed per call, because the row is the only place
                    // that knows which invitation this rejection belongs to.
                    onError: () => {
                      setAcceptFailedId(conv.id);
                    },
                    onSettled: () => {
                      setAcceptingId(null);
                    },
                  }
                );
              }}
            >
              <Check className="h-4 w-4" />
            </IconButton>
          </div>
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
              className="text-destructive hover:text-destructive/80"
              onClick={() => {
                setDeclineTarget(conv.id);
              }}
            >
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          {acceptFailedId === conv.id && (
            <p role="alert" className="text-destructive mt-1 text-xs">
              {friendlyErrorMessage(ERROR_CODES.INVITE_ACCEPT_FAILED)}
            </p>
          )}
        </div>
      ))}

      <LeaveConfirmationModal
        open={declineTarget !== null}
        onOpenChange={(open) => {
          /* v8 ignore next -- the modal is controlled by declineTarget with no trigger, so onOpenChange only ever fires on close (open=false); the open=true arm is unreachable */
          if (!open) setDeclineTarget(null);
        }}
        isOwner={false}
        onConfirm={async () => {
          // Capture before clearing — declineTarget is closure state and the
          // modal close path (onOpenChange) nulls it before mutateAsync
          // resolves. Awaiting forwards any thrown error to ActionModal's
          // inline error region.
          const conversationId = declineTarget;
          /* v8 ignore next -- onConfirm only fires while the modal is open, so declineTarget is always set here; the null guard is defensive against a documented close race */
          if (conversationId) {
            await declineInvitation.mutateAsync({ conversationId });
          }
        }}
      />
    </div>
  );
}
