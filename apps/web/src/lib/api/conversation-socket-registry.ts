/**
 * Refcounted shared sockets, one per conversation (or trial session). The
 * `@/lib/chat/run` transport and the group-realtime hooks must observe the SAME
 * socket — separate sockets would double presence and split the per-stream
 * cursors each connection declares at setup — so acquisition goes through this
 * registry and the last holder's release disconnects.
 */
import { ConversationWebSocket } from './ws-client.js';

interface Entry {
  socket: ConversationWebSocket;
  refs: number;
}

const entries = new Map<string, Entry>();

const TRIAL_KEY_PREFIX = 'trial\u0000';

function acquire(key: string, create: () => ConversationWebSocket): ConversationWebSocket {
  const existing = entries.get(key);
  if (existing) {
    existing.refs += 1;
    return existing.socket;
  }
  const socket = create();
  entries.set(key, { socket, refs: 1 });
  socket.connect();
  return socket;
}

function release(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  entries.delete(key);
  entry.socket.disconnect();
}

export function acquireConversationSocket(conversationId: string): ConversationWebSocket {
  return acquire(conversationId, () => new ConversationWebSocket({ conversationId }));
}

export function releaseConversationSocket(conversationId: string): void {
  release(conversationId);
}

/**
 * The trial socket upgrades at `/chat/trial/websocket`, keyed by the trial
 * token rather than a conversation id. The token rides a query parameter
 * because a browser WebSocket cannot set the `x-trial-token` header.
 */
export function acquireTrialSocket(trialToken: string): ConversationWebSocket {
  return acquire(
    `${TRIAL_KEY_PREFIX}${trialToken}`,
    () =>
      new ConversationWebSocket({
        conversationId: `trial:${trialToken}`,
        wsPath: `/chat/trial/websocket?trialToken=${encodeURIComponent(trialToken)}`,
      })
  );
}

export function releaseTrialSocket(trialToken: string): void {
  release(`${TRIAL_KEY_PREFIX}${trialToken}`);
}

/** Test-only: drops every entry without disconnect bookkeeping. */
export function resetSocketRegistryForTests(): void {
  entries.clear();
}
