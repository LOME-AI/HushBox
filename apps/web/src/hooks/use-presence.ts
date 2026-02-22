import * as React from 'react';
import type { ConversationWebSocket } from '../lib/ws-client.js';

interface PresenceMember {
  userId?: string;
  displayName?: string;
  isGuest: boolean;
  connectedAt: number;
}

export function usePresence(ws: ConversationWebSocket | null): Map<string, PresenceMember> {
  const [presenceMap, setPresenceMap] = React.useState<Map<string, PresenceMember>>(new Map());

  React.useEffect(() => {
    if (!ws) return;

    const unsubscribe = ws.on('presence:update', (event) => {
      setPresenceMap(
        new Map(
          event.members
            .filter((m): m is typeof m & { userId: string } => typeof m.userId === 'string')
            .map((m): [string, PresenceMember] => [
              m.userId,
              {
                userId: m.userId,
                ...(m.displayName !== undefined && { displayName: m.displayName }),
                isGuest: m.isGuest,
                connectedAt: m.connectedAt,
              },
            ])
        )
      );
    });

    return unsubscribe;
  }, [ws]);

  return presenceMap;
}
