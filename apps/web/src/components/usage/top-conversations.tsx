import * as React from 'react';
import { Icon, Users } from '@hushbox/ui/icons';
import { Swatch } from '@hushbox/ui/marks';
import { TEST_IDS, type SpendingByConversationResponse } from '@hushbox/shared';
import { DECRYPTING_TITLE, UNREADABLE_TITLE } from '@/lib/chat/auth-chat-helpers';
import { formatNanoUsdAmount, UsageSection } from './chart-utilities';
import { useUsageModelLabels } from './use-usage-model-labels';

interface ConversationTitle {
  id: string;
  title: string;
}

interface TopConversationsProps {
  data: SpendingByConversationResponse | undefined;
  isLoading: boolean;
  isError?: boolean | undefined;
  onRetry?: (() => void) | undefined;
  conversationTitles?: ConversationTitle[];
}

/** A conversation's title, or the end of its id while it has no readable title. */
function conversationLabel(title: string | undefined, conversationId: string): string {
  if (!title || title === DECRYPTING_TITLE || title === UNREADABLE_TITLE) {
    return `conv-${conversationId.slice(-6)}`;
  }
  return title;
}

type ConversationRow = SpendingByConversationResponse['data'][number];

/**
 * Which model answered, ahead of the message count: the one model's swatch and
 * name, or how many answered. A conversation whose replies name no model shows none.
 */
function ModelLabel({ modelIds }: Readonly<{ modelIds: string[] }>): React.JSX.Element | null {
  const labels = useUsageModelLabels();
  const [only] = modelIds;
  if (only === undefined) return null;
  const label =
    modelIds.length > 1 ? (
      <span className="flex items-center gap-1.5">
        <Icon icon={Users} size="sm" />
        {`${String(modelIds.length)} models`}
      </span>
    ) : (
      <span className="flex min-w-0 items-center gap-1.5">
        <Swatch swatch={labels.swatch(only)} />
        <span className="min-w-0 wrap-anywhere">{labels.name(only)}</span>
      </span>
    );
  return (
    <>
      {label}
      <span aria-hidden="true">·</span>
    </>
  );
}

function ConversationItem({
  row,
  title,
}: Readonly<{ row: ConversationRow; title: string }>): React.JSX.Element {
  const messages = `${String(row.messageCount)} ${row.messageCount === 1 ? 'message' : 'messages'}`;
  return (
    <li className="border-border flex items-center gap-4 border-b py-2.5">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span data-slot="top-title" className="truncate text-sm font-medium">
          {title}
        </span>
        <span
          data-slot="top-sub"
          className="text-ui-sm text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5"
        >
          <ModelLabel modelIds={row.modelIds} />
          <span>{messages}</span>
        </span>
      </span>
      <span className="flex-none font-mono text-sm tabular-nums">
        {formatNanoUsdAmount(row.totalSpent)}
      </span>
    </li>
  );
}

/** The range's costliest conversations, ranked. */
export function TopConversations({
  data,
  isLoading,
  isError = false,
  onRetry,
  conversationTitles,
}: Readonly<TopConversationsProps>): React.JSX.Element {
  const rows = data?.data ?? [];
  const titles = React.useMemo(
    () => new Map(conversationTitles?.map((c) => [c.id, c.title])),
    [conversationTitles]
  );

  return (
    <UsageSection
      title="Top Conversations"
      testId={TEST_IDS.topConversations}
      isLoading={isLoading}
      isError={isError}
      onRetry={onRetry}
      isEmpty={rows.length === 0}
      emptyMessage="No conversation data"
    >
      {/* eslint-disable-next-line jsx-a11y/no-redundant-roles -- WebKit's VoiceOver drops list semantics from a list with list-style none, and the app ships in WKWebView */}
      <ol role="list" className="border-border flex flex-col border-t">
        {rows.map((row) => (
          <ConversationItem
            key={row.conversationId}
            row={row}
            title={conversationLabel(titles.get(row.conversationId), row.conversationId)}
          />
        ))}
      </ol>
    </UsageSection>
  );
}
