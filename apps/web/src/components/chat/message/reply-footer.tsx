import * as React from 'react';
import { Lock } from '@hushbox/ui/icons';
import { CostPill } from '@/components/chat/message/cost-pill';
import { DottedLine, type MetaItem } from '@/components/chat/message/dotted-line';
import { TrustLine } from '@/components/shared/trust-line';
import { formatReplyDate } from '@/lib/chat/reply-date';
import type { Message } from '@/lib/api/api';

/** The fields of a reply its footer reads. */
type FooterMessage = Pick<Message, 'cost' | 'inputTokens' | 'outputTokens' | 'createdAt'>;

interface ReplyFooterProps {
  message: FooterMessage;
  /** Whether the reply is a stored row, which is what "Saved encrypted" states. */
  saved: boolean;
  /** A streaming reply has no date yet to show, and the row only holds its place. */
  streaming?: boolean | undefined;
  /**
   * A reply in a compare group shows its cost alone: the group states the turn's storage
   * and date once, under its replies.
   */
  costOnly?: boolean | undefined;
  /** A control that starts the control row, ahead of the message's own controls. */
  leading?: React.ReactNode;
  controls: React.ReactNode;
}

function metaItems(
  message: FooterMessage,
  saved: boolean,
  streaming: boolean,
  costOnly: boolean
): MetaItem[] {
  const items: MetaItem[] = [];
  if (message.cost) {
    items.push({
      key: 'cost',
      node: (
        <CostPill
          cost={message.cost}
          inputTokens={message.inputTokens}
          outputTokens={message.outputTokens}
        />
      ),
    });
  }
  if (costOnly) return items;
  if (saved) {
    items.push({ key: 'saved', node: <TrustLine icon={Lock}>Saved encrypted</TrustLine> });
  }
  if (!streaming && message.createdAt !== '') {
    items.push({
      key: 'date',
      node: (
        <time dateTime={message.createdAt}>{formatReplyDate(message.createdAt, new Date())}</time>
      ),
    });
  }
  return items;
}

/**
 * A reply's footer row: its cost pill, its storage state and its date at the start, its
 * controls at the end. The row keeps its touch-sized height while the reply streams, so
 * the controls arrive without moving the thread.
 */
export function ReplyFooter({
  message,
  saved,
  streaming = false,
  costOnly = false,
  leading,
  controls,
}: Readonly<ReplyFooterProps>): React.JSX.Element {
  const items = metaItems(message, saved, streaming, costOnly);
  return (
    <div
      data-chrome=""
      className="flex min-h-8 w-full flex-wrap items-center gap-x-3 gap-y-1 pointer-coarse:min-h-11"
    >
      {items.length > 0 && (
        <DottedLine items={items} className="text-caption text-muted-foreground" />
      )}
      {leading === undefined ? (
        controls
      ) : (
        // The row takes the rest of the cost's line, or a whole line once it wraps under the
        // cost; the leading control grows into what the controls leave, so it starts at the
        // cost's edge, and takes a line of its own where the two cannot share one.
        <div className="flex min-w-0 flex-auto flex-wrap items-center gap-x-1 gap-y-1">
          {leading}
          {controls}
        </div>
      )}
    </div>
  );
}
