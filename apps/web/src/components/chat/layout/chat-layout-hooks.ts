import * as React from 'react';
import { createEvent } from '@hushbox/realtime/events';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';
import type { MessageListHandle } from '@/components/chat/message/message-list';
import type { PromptInputRef } from '@/components/chat/input/prompt-input';

export function useInputFocusManagement(
  inputDisabled: boolean,
  isMobile: boolean,
  promptInputRef: React.RefObject<PromptInputRef | null>
): void {
  const previousInputDisabledRef = React.useRef(inputDisabled);

  React.useEffect(() => {
    const wasDisabled = previousInputDisabledRef.current;
    previousInputDisabledRef.current = inputDisabled;

    if (wasDisabled && !inputDisabled && !isMobile) {
      // eslint-disable-next-line no-restricted-globals -- one-shot rAF defers focus to next frame, not motion animation
      requestAnimationFrame(() => {
        // eslint-disable-next-line no-restricted-globals -- one-shot rAF defers focus to next frame, not motion animation
        requestAnimationFrame(() => {
          promptInputRef.current?.focus();
        });
      });
    }
  }, [inputDisabled, isMobile, promptInputRef]);
}

export function useStreamScrollEffect(
  streamingMessageIds: Set<string>,
  messagesLength: number,
  virtuosoRef: React.RefObject<MessageListHandle | null>
): void {
  const previousWasStreamingRef = React.useRef(false);

  React.useEffect(() => {
    const wasStreaming = previousWasStreamingRef.current;
    const isNowStreaming = streamingMessageIds.size > 0;
    previousWasStreamingRef.current = isNowStreaming;

    const isFirstMessage = messagesLength <= 2;

    if (!wasStreaming && isNowStreaming && isFirstMessage) {
      // eslint-disable-next-line no-restricted-globals -- one-shot rAF defers scroll to next frame, not motion animation
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
      });
    }
  }, [streamingMessageIds, messagesLength, virtuosoRef]);
}

export function useInputHeightObserver(
  isMobile: boolean,
  inputContainerRef: React.RefObject<HTMLDivElement | null>
): number {
  const [inputHeight, setInputHeight] = React.useState(0);

  React.useEffect(() => {
    if (!isMobile || !inputContainerRef.current) return;

    const updateHeight = (): void => {
      if (inputContainerRef.current) {
        setInputHeight(inputContainerRef.current.offsetHeight);
      }
    };

    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(inputContainerRef.current);

    return (): void => {
      observer.disconnect();
    };
  }, [isMobile, inputContainerRef]);

  return inputHeight;
}

export function useSubmitUserOnly(
  onSubmitUserOnly: (() => void) | undefined,
  virtuosoRef: React.RefObject<MessageListHandle | null>
): () => void {
  return React.useCallback((): void => {
    if (onSubmitUserOnly) {
      onSubmitUserOnly();
      virtuosoRef.current?.resetScrollBreakaway();
      // eslint-disable-next-line no-restricted-globals -- one-shot rAF defers scroll to next frame, not motion animation
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
      });
    }
  }, [onSubmitUserOnly, virtuosoRef]);
}

export function useTypingBroadcast(
  groupChat: GroupChatProps | undefined
): (isTyping: boolean) => void {
  return React.useCallback(
    (isTyping: boolean): void => {
      if (!groupChat?.ws?.connected || !groupChat.currentUserId) return;
      const eventType = isTyping ? 'typing:start' : 'typing:stop';
      groupChat.ws.send(
        createEvent(eventType, {
          conversationId: groupChat.conversationId,
          userId: groupChat.currentUserId,
        })
      );
    },
    [groupChat]
  );
}
