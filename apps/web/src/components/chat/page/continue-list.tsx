import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { cn } from '@hushbox/ui';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { useDecryptedConversations } from '@/hooks/chat/chat';
import { useSession } from '@/lib/auth/auth';
import { conversationDateGroup, mostRecentConversations } from '@/lib/chat/conversation-groups';

const CONTINUE_COUNT = 3;

/**
 * The account's most recent conversations above the new chat's suggestions, each under the
 * date group the sidebar files it in. From 768 a row of cards; below it one outlined list of
 * single-line rows, sized so the whole new chat still fits a small phone's first screen.
 */
export function ContinueList(): React.JSX.Element | null {
  const headingId = React.useId();
  const { data: session } = useSession();
  const { data: conversations } = useDecryptedConversations();

  // A link guest's session reads as absent, so this also hides the list over a cached
  // conversation list while a shared conversation is open.
  if (!session?.user || !conversations) return null;
  const recent = mostRecentConversations(conversations, CONTINUE_COUNT);
  if (recent.length === 0) return null;

  const now = new Date();
  const lastIndex = recent.length - 1;

  return (
    <nav
      aria-labelledby={headingId}
      data-testid={TEST_IDS.continueList}
      className="flex flex-col gap-2"
    >
      <h2
        id={headingId}
        className="text-caption text-muted-foreground text-center font-sans font-semibold"
      >
        Continue
      </h2>
      <ul className="border-border-control grid grid-cols-1 rounded-lg border md:grid-cols-3 md:gap-2 md:rounded-none md:border-0">
        {recent.map((conversation, index) => {
          const group = conversationDateGroup(conversation.updatedAt, now);
          return (
            <li
              key={conversation.id}
              className="max-md:not-first:border-border max-md:not-first:border-t"
            >
              <Link
                to={ROUTES.CHAT_ID}
                params={{ id: conversation.id }}
                search={{ fork: undefined }}
                aria-label={`${conversation.title}, ${group}`}
                className={cn(
                  'text-foreground hover:bg-accent focus-visible:outline-ring text-center transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2',
                  'max-md:text-ui-sm max-md:block max-md:px-3.5 max-md:py-1.75 max-md:text-balance',
                  index === 0 && 'max-md:rounded-t-[calc(var(--radius)-1px)]',
                  index === lastIndex && 'max-md:rounded-b-[calc(var(--radius)-1px)]',
                  'md:border-border-control md:hover:border-muted-foreground md:flex md:h-full md:min-h-12 md:flex-col md:items-center md:justify-center md:gap-1 md:rounded-lg md:border md:px-3.5 md:py-2.5'
                )}
              >
                {/* The clamp sits inside the padding, so a clipped third line never shows in it. */}
                <span className="max-md:line-clamp-2 md:contents">
                  <span className="text-ui-sm font-semibold md:line-clamp-2 md:w-full md:text-pretty">
                    {conversation.title}
                  </span>
                  <span className="text-caption text-muted-foreground max-md:ml-1.5 max-md:inline-block max-md:whitespace-nowrap max-md:before:mr-1.5 max-md:before:content-['·']">
                    {group}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
