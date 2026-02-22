import * as React from 'react';
import type { ConversationWebSocket } from '../lib/ws-client.js';

const TYPING_TIMEOUT_MS = 5000;

export function useTypingIndicators(ws: ConversationWebSocket | null): Set<string> {
  const [typingUserIds, setTypingUserIds] = React.useState<Set<string>>(new Set());
  const timeoutsRef = React.useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const removeTypingUser = React.useCallback((userId: string): void => {
    timeoutsRef.current.delete(userId);
    setTypingUserIds((previous) => {
      const next = new Set(previous);
      next.delete(userId);
      return next;
    });
  }, []);

  const handleTypingStart = React.useCallback(
    (event: { userId: string }): void => {
      setTypingUserIds((previous) => {
        const next = new Set(previous);
        next.add(event.userId);
        return next;
      });

      // Clear existing timeout for this user if any
      const existingTimeout = timeoutsRef.current.get(event.userId);
      if (existingTimeout !== undefined) clearTimeout(existingTimeout);

      // Set auto-clear timeout
      timeoutsRef.current.set(
        event.userId,
        setTimeout(() => {
          removeTypingUser(event.userId);
        }, TYPING_TIMEOUT_MS)
      );
    },
    [removeTypingUser]
  );

  const handleTypingStop = React.useCallback((event: { userId: string }): void => {
    const existingTimeout = timeoutsRef.current.get(event.userId);
    if (existingTimeout !== undefined) {
      clearTimeout(existingTimeout);
      timeoutsRef.current.delete(event.userId);
    }

    setTypingUserIds((previous) => {
      const next = new Set(previous);
      next.delete(event.userId);
      return next;
    });
  }, []);

  React.useEffect(() => {
    if (!ws) return;

    const unsubscribes = [
      ws.on('typing:start', handleTypingStart),
      ws.on('typing:stop', handleTypingStop),
    ];

    return (): void => {
      for (const unsub of unsubscribes) unsub();
      // Clear all timeouts on cleanup
      for (const timeout of timeoutsRef.current.values()) {
        clearTimeout(timeout);
      }
      timeoutsRef.current.clear();
    };
  }, [ws, handleTypingStart, handleTypingStop]);

  return typingUserIds;
}
