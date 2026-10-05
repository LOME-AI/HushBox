import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { PRODUCT_TAGLINE_SENTENCES, ROUTES, TEST_IDS } from '@hushbox/shared';
import { Button } from '@hushbox/ui/button';
import { Heading, Text } from '@hushbox/ui/type';
import { AuthFeatureList } from '@/components/auth/auth-feature-list';
import { ChatColumn } from '@/components/chat/layout/chat-column';
import { ChatLayout } from '@/components/chat/layout/chat-layout';
import { publishedRowOf } from '@/components/chat/message/share-message-modal';
import { ShareHead } from '@/components/chat/share/share-head';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { sharedMessageReply } from '@/hooks/chat/shared-message-reply';
import {
  MessageContentKeySourceContext,
  contentKeySourceFor,
} from '@/hooks/crypto/use-decrypted-media';
import type { SharedMessageData } from '@/hooks/chat/use-shared-message';

const NO_IDS = new Set<string>();

function noop(): void {
  /* The page has no composer, so nothing is typed or sent. */
}

/** The closing pitch: the product's tagline, today's sign-up points, and Sign Up. */
function SharePitch(): React.JSX.Element {
  const titleId = React.useId();
  return (
    <section aria-labelledby={titleId} className="border-border mt-12 mb-4 w-full border-t pt-10">
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 text-center">
        <Heading level={2} variant="title-2" id={titleId}>
          {/* Each sentence keeps its line, so a narrow line breaks only between them. */}
          {PRODUCT_TAGLINE_SENTENCES.map((sentence, index) => (
            <React.Fragment key={sentence}>
              {index > 0 && ' '}
              <span className="whitespace-nowrap">{sentence}</span>
            </React.Fragment>
          ))}
        </Heading>
        {/* The list draws its own rule and space above it, for the auth card; here the
            section's rule above the tagline already parts it from the reply. */}
        <div className="text-start [&>div]:mt-0 [&>div]:border-t-0 [&>div]:pt-0">
          <AuthFeatureList />
        </div>
        <Button asChild block>
          <Link to={ROUTES.SIGNUP}>Sign Up</Link>
        </Button>
      </div>
    </section>
  );
}

interface SharedMessageChatPageProps {
  readonly data: SharedMessageData;
}

/**
 * A reply shared by link, drawn by the chat's own layout as a thread of one message. The
 * reader holds no seat in the conversation: what they may do with the reply is the message
 * link's permission row, and what they see is what the share read serves.
 */
export function SharedMessageChatPage({ data }: SharedMessageChatPageProps): React.JSX.Element {
  const { isAuthenticated, isStable } = useStableSession();
  // Until the session settles the page speaks to a reader with no account, and holds the
  // pitch back so a signed-in reader never sees it flash.
  const signedIn = isStable && isAuthenticated;
  const signedOut = isStable && !isAuthenticated;
  const messages = React.useMemo(
    () => [publishedRowOf(sharedMessageReply(data), data.conversationId)],
    [data]
  );
  const keySource = React.useMemo(
    () => (data.deleted ? null : contentKeySourceFor(data.wrappedContentKey, data.contentKey)),
    [data]
  );
  const threadHeader = React.useMemo(
    () => (
      <ChatColumn>
        {/* An erased message is never decrypted, so its page makes no decryption promise. */}
        <ShareHead title="Shared reply" showTrustLine={!data.deleted} />
      </ChatColumn>
    ),
    [data.deleted]
  );
  const threadFooter = React.useMemo(
    () => (
      <ChatColumn>
        <div data-testid={TEST_IDS.sharedReplyNote}>
          <Text variant="caption">
            One reply, shared on its own. The question and the rest of the conversation stay
            private.
          </Text>
        </div>
        {signedOut && <SharePitch />}
      </ChatColumn>
    ),
    [signedOut]
  );

  const layout = (
    <ChatLayout
      messages={messages}
      streamingMessageIds={NO_IDS}
      persistingMessageIds={NO_IDS}
      inputValue=""
      onInputChange={noop}
      onSubmit={noop}
      inputDisabled
      isProcessing={false}
      historyCharacters={0}
      isAuthenticated={signedIn}
      isMessageLink
      messagesReady
      threadHeader={threadHeader}
      threadFooter={threadFooter}
      // The layout draws the composer for a nullish slot, so the empty slot is `false`.
      composerSlot={false}
    />
  );
  if (keySource === null) return layout;
  return (
    <MessageContentKeySourceContext value={keySource}>{layout}</MessageContentKeySourceContext>
  );
}
