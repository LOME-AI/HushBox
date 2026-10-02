import { ChartNoAxesColumn, MessageSquareWarning, SquarePen } from 'lucide-react';
import { buildSections, type PaletteItem, type PaletteSection } from '@hushbox/ui';
import { Accessibility, CreditCard, MessageSquare, Settings, Users } from '@hushbox/ui/icons';
import { APP_ACTIONS } from '@/lib/app-actions';
import { APP_SHORTCUTS } from '@/hooks/ui/use-app-shortcuts';
import { conversationDateGroup, mostRecentConversations } from '@/lib/chat/conversation-groups';
import type { ConversationListItem } from '@hushbox/shared';

export type PaletteConversation = Pick<
  ConversationListItem,
  'id' | 'title' | 'updatedAt' | 'memberCount' | 'accepted'
>;

type ActionItem = PaletteItem & {
  readonly kind: 'action';
  readonly action: keyof typeof APP_ACTIONS;
  /** A `useHotkeys` combo the row draws as its meta. */
  readonly shortcut?: string;
};

type ConversationItem = PaletteItem & {
  readonly kind: 'conversation';
  readonly conversationId: string;
};

export type WebPaletteItem = ActionItem | ConversationItem;

const RECENT_COUNT = 3;

const ACTIONS: readonly ActionItem[] = [
  {
    kind: 'action',
    id: 'action:newChat',
    label: 'New chat',
    icon: SquarePen,
    action: 'newChat',
    shortcut: APP_SHORTCUTS.newChat,
  },
  {
    kind: 'action',
    id: 'action:addCredit',
    label: 'Add credit',
    icon: CreditCard,
    action: 'addCredit',
  },
  {
    kind: 'action',
    id: 'action:sendFeedback',
    label: 'Send feedback',
    icon: MessageSquareWarning,
    action: 'sendFeedback',
  },
];

const GO_TO: readonly ActionItem[] = [
  {
    kind: 'action',
    id: 'action:settings',
    label: 'Settings',
    icon: Settings,
    action: 'settings',
    shortcut: APP_SHORTCUTS.settings,
  },
  { kind: 'action', id: 'action:usage', label: 'Usage', icon: ChartNoAxesColumn, action: 'usage' },
  {
    kind: 'action',
    id: 'action:accessibilityPage',
    label: 'Accessibility',
    icon: Accessibility,
    action: 'accessibilityPage',
  },
];

function conversationItem(conversation: PaletteConversation, now: Date): ConversationItem {
  const isGroup = conversation.memberCount > 1;
  return {
    kind: 'conversation',
    id: `conversation:${conversation.id}`,
    label: conversation.title,
    icon: isGroup ? Users : MessageSquare,
    meta: isGroup
      ? `${String(conversation.memberCount)} members`
      : conversationDateGroup(conversation.updatedAt, now),
    conversationId: conversation.id,
  };
}

function section<TItem extends WebPaletteItem>(
  heading: string,
  items: readonly TItem[]
): readonly PaletteSection<TItem>[] {
  return items.length > 0 ? [{ heading, items }] : [];
}

/**
 * The web palette's sections: the most recent conversations, the actions and the pages while
 * the query is empty; otherwise the loaded conversations and those items that match it. Items
 * that need a session, and every conversation, are left out for a visitor without one.
 */
export function webPaletteSections({
  query,
  conversations,
  signedIn,
  now,
}: {
  readonly query: string;
  readonly conversations: readonly PaletteConversation[];
  readonly signedIn: boolean;
  readonly now: Date;
}): readonly PaletteSection<WebPaletteItem>[] {
  const offered = (item: ActionItem): boolean =>
    signedIn || !APP_ACTIONS[item.action].requiresSession;
  const loaded = signedIn ? conversations.filter((conversation) => conversation.accepted) : [];
  const groups: readonly PaletteSection<WebPaletteItem>[] = [
    ...section(
      'Actions',
      ACTIONS.filter((item) => offered(item))
    ),
    ...section(
      'Go to',
      GO_TO.filter((item) => offered(item))
    ),
  ];

  if (query.trim() === '') {
    const recent = mostRecentConversations(loaded, RECENT_COUNT).map((conversation) =>
      conversationItem(conversation, now)
    );
    return [...section<WebPaletteItem>('Recent', recent), ...groups];
  }
  return buildSections<WebPaletteItem>({
    query,
    groups: [
      {
        heading: 'Chats',
        items: loaded.map((conversation) => conversationItem(conversation, now)),
      },
      ...groups,
    ],
  });
}
