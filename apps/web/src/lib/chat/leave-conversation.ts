/**
 * Leave a conversation. A leave is a pure departure: the server records it (or,
 * for the owner, deletes the conversation), and the conversation becomes
 * rotation-pending until a remaining member's epoch maintenance rotates the key
 * the leaver held. The leaver builds no rotation and caches no key, so it never
 * holds a key minted after it left.
 *
 * Navigation after success is the caller's responsibility — member-sidebar
 * always navigates (the user is by definition viewing the leaving
 * conversation), but chat-item only navigates when leaving the active chat.
 */

type LeaveCallback = (params: { conversationId: string }) => Promise<unknown>;

interface LeaveConversationInput {
  conversationId: string;
  leave: LeaveCallback;
}

export async function leaveConversation(input: LeaveConversationInput): Promise<void> {
  await input.leave({ conversationId: input.conversationId });
}
