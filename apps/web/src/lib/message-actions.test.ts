import { describe, it, expect } from 'vitest';
import {
  resolveMessageActions,
  buildChatContext,
  type MessageAction,
  type ChatContext,
  type MessageContext,
} from './message-actions.js';

function makeMessage(
  overrides: Partial<{
    id: string;
    role: 'user' | 'assistant';
    senderId: string;
    parentMessageId: string | null;
  }> = {}
): MessageContext['message'] {
  const base: MessageContext['message'] = {
    id: overrides.id ?? 'm1',
    conversationId: 'conv-1',
    role: overrides.role ?? 'assistant',
    content: 'Hello',
    createdAt: '2026-01-01T00:00:00Z',
    parentMessageId: overrides.parentMessageId ?? null,
  };
  if (overrides.senderId !== undefined) {
    base.senderId = overrides.senderId;
  }
  return base;
}

function makeMsgContext(
  overrides: {
    message?: Partial<{
      id: string;
      role: 'user' | 'assistant';
      senderId: string;
      parentMessageId: string | null;
    }>;
    isStreaming?: boolean;
    isError?: boolean;
    isMultiModel?: boolean;
    canRegenerate?: boolean;
  } = {}
): MessageContext {
  const { message: msgOverrides, ...rest } = overrides;
  return {
    message: makeMessage(msgOverrides),
    isStreaming: false,
    isError: false,
    isMultiModel: false,
    canRegenerate: true,
    ...rest,
  };
}

function actionsArray(set: Set<MessageAction>): MessageAction[] {
  return [...set].toSorted((a, b) => a.localeCompare(b));
}

describe('buildChatContext', () => {
  it('returns trial mode for unauthenticated non-link-guest', () => {
    const ctx = buildChatContext({
      isAuthenticated: false,
      isLinkGuest: false,
      privilege: undefined,
      currentUserId: undefined,
      isGroupChat: false,
    });

    expect(ctx).toEqual({
      mode: 'trial',
      privilege: undefined,
      currentUserId: undefined,
      isGroupChat: false,
    });
  });

  it('returns link-guest mode with privilege', () => {
    const ctx = buildChatContext({
      isAuthenticated: false,
      isLinkGuest: true,
      privilege: 'write',
      currentUserId: 'guest-1',
      isGroupChat: false,
    });

    expect(ctx.mode).toBe('link-guest');
    expect(ctx.privilege).toBe('write');
  });

  it('defaults link-guest privilege to read', () => {
    const ctx = buildChatContext({
      isAuthenticated: false,
      isLinkGuest: true,
      privilege: undefined,
      currentUserId: undefined,
      isGroupChat: false,
    });

    expect(ctx.privilege).toBe('read');
  });

  it('returns group mode for authenticated group chat', () => {
    const ctx = buildChatContext({
      isAuthenticated: true,
      isLinkGuest: false,
      privilege: 'write',
      currentUserId: 'user-1',
      isGroupChat: true,
    });

    expect(ctx).toEqual({
      mode: 'group',
      privilege: 'write',
      currentUserId: 'user-1',
      isGroupChat: true,
    });
  });

  it('returns solo mode for authenticated non-group chat', () => {
    const ctx = buildChatContext({
      isAuthenticated: true,
      isLinkGuest: false,
      privilege: 'owner',
      currentUserId: 'user-1',
      isGroupChat: false,
    });

    expect(ctx).toEqual({
      mode: 'solo',
      privilege: 'owner',
      currentUserId: 'user-1',
      isGroupChat: false,
    });
  });
});

describe('resolveMessageActions', () => {
  // ─── Solo Chat ─────────────────────────────────────────────

  describe('solo chat', () => {
    const soloCtx: ChatContext = {
      mode: 'solo',
      privilege: 'owner',
      currentUserId: 'user-1',
      isGroupChat: false,
    };

    it('shows copy, regenerate, fork, share on AI message', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actions.has('copy')).toBe(true);
      expect(actions.has('regenerate')).toBe(true);
      expect(actions.has('fork')).toBe(true);
      expect(actions.has('share')).toBe(true);
    });

    it('shows copy, retry, edit, fork on own user message', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'user', senderId: 'user-1' } })
      );

      expect(actions.has('copy')).toBe(true);
      expect(actions.has('retry')).toBe(true);
      expect(actions.has('edit')).toBe(true);
      expect(actions.has('fork')).toBe(true);
    });

    it('does not show regenerate on user message', () => {
      const actions = resolveMessageActions(soloCtx, makeMsgContext({ message: { role: 'user' } }));

      expect(actions.has('regenerate')).toBe(false);
    });

    it('does not show share on user message', () => {
      const actions = resolveMessageActions(soloCtx, makeMsgContext({ message: { role: 'user' } }));

      expect(actions.has('share')).toBe(false);
    });

    it('does not show retry/edit on AI message', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actions.has('retry')).toBe(false);
      expect(actions.has('edit')).toBe(false);
    });

    it('shows retry-error on error AI message', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

      expect(actions.has('retry-error')).toBe(true);
    });

    it('hides all normal actions on error message', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

      expect(actions.has('copy')).toBe(false);
      expect(actions.has('regenerate')).toBe(false);
      expect(actions.has('fork')).toBe(false);
      expect(actions.has('share')).toBe(false);
    });

    it('hides all actions on streaming message', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'assistant' }, isStreaming: true })
      );

      expect(actions.size).toBe(0);
    });

    it('hides regenerate when isMultiModel is true', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'assistant' }, isMultiModel: true })
      );

      expect(actions.has('regenerate')).toBe(false);
      expect(actions.has('copy')).toBe(true);
      expect(actions.has('fork')).toBe(true);
    });

    it('hides retry/edit when canRegenerate is false', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'user' }, canRegenerate: false })
      );

      expect(actions.has('retry')).toBe(false);
      expect(actions.has('edit')).toBe(false);
      expect(actions.has('copy')).toBe(true);
      expect(actions.has('fork')).toBe(true);
    });
  });

  // ─── Group Chat (write+) ──────────────────────────────────

  describe('group chat (write privilege)', () => {
    const groupWriteCtx: ChatContext = {
      mode: 'group',
      privilege: 'write',
      currentUserId: 'user-1',
      isGroupChat: true,
    };

    it('shows full actions on own user message', () => {
      const actions = resolveMessageActions(
        groupWriteCtx,
        makeMsgContext({ message: { role: 'user', senderId: 'user-1' } })
      );

      expect(actions.has('copy')).toBe(true);
      expect(actions.has('retry')).toBe(true);
      expect(actions.has('edit')).toBe(true);
      expect(actions.has('fork')).toBe(true);
    });

    it('shows only copy and fork on other user message', () => {
      const actions = resolveMessageActions(
        groupWriteCtx,
        makeMsgContext({ message: { role: 'user', senderId: 'user-2' } })
      );

      expect(actionsArray(actions)).toEqual(['copy', 'fork']);
    });

    it('shows full AI actions including share', () => {
      const actions = resolveMessageActions(
        groupWriteCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actions.has('copy')).toBe(true);
      expect(actions.has('regenerate')).toBe(true);
      expect(actions.has('fork')).toBe(true);
      expect(actions.has('share')).toBe(true);
    });
  });

  describe('group chat (admin privilege)', () => {
    const groupAdminCtx: ChatContext = {
      mode: 'group',
      privilege: 'admin',
      currentUserId: 'user-1',
      isGroupChat: true,
    };

    it('has same actions as write on AI message', () => {
      const actions = resolveMessageActions(
        groupAdminCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actions.has('regenerate')).toBe(true);
      expect(actions.has('share')).toBe(true);
    });
  });

  describe('group chat (owner privilege)', () => {
    const groupOwnerCtx: ChatContext = {
      mode: 'group',
      privilege: 'owner',
      currentUserId: 'user-1',
      isGroupChat: true,
    };

    it('has same actions as write on AI message', () => {
      const actions = resolveMessageActions(
        groupOwnerCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actions.has('regenerate')).toBe(true);
      expect(actions.has('share')).toBe(true);
    });
  });

  // ─── Group Chat (read) ────────────────────────────────────

  describe('group chat (read privilege)', () => {
    const groupReadCtx: ChatContext = {
      mode: 'group',
      privilege: 'read',
      currentUserId: 'user-1',
      isGroupChat: true,
    };

    it('shows only copy on AI message', () => {
      const actions = resolveMessageActions(
        groupReadCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });

    it('shows only copy on user message', () => {
      const actions = resolveMessageActions(
        groupReadCtx,
        makeMsgContext({ message: { role: 'user', senderId: 'user-2' } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });

    it('shows no actions on streaming message', () => {
      const actions = resolveMessageActions(
        groupReadCtx,
        makeMsgContext({ message: { role: 'assistant' }, isStreaming: true })
      );

      expect(actions.size).toBe(0);
    });

    it('shows no actions on error message', () => {
      const actions = resolveMessageActions(
        groupReadCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

      expect(actions.size).toBe(0);
    });
  });

  // ─── Trial Chat ────────────────────────────────────────────

  describe('trial chat', () => {
    const trialCtx: ChatContext = {
      mode: 'trial',
      privilege: undefined,
      currentUserId: undefined,
      isGroupChat: false,
    };

    it('shows copy and regenerate on AI message', () => {
      const actions = resolveMessageActions(
        trialCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actionsArray(actions)).toEqual(['copy', 'regenerate']);
    });

    it('shows copy and retry on user message', () => {
      const actions = resolveMessageActions(
        trialCtx,
        makeMsgContext({ message: { role: 'user' } })
      );

      expect(actionsArray(actions)).toEqual(['copy', 'retry']);
    });

    it('does not show edit, fork, or share', () => {
      const aiActions = resolveMessageActions(
        trialCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );
      const userActions = resolveMessageActions(
        trialCtx,
        makeMsgContext({ message: { role: 'user' } })
      );

      expect(aiActions.has('fork')).toBe(false);
      expect(aiActions.has('share')).toBe(false);
      expect(userActions.has('edit')).toBe(false);
      expect(userActions.has('fork')).toBe(false);
    });

    it('shows no actions on streaming message', () => {
      const actions = resolveMessageActions(
        trialCtx,
        makeMsgContext({ message: { role: 'assistant' }, isStreaming: true })
      );

      expect(actions.size).toBe(0);
    });

    it('hides regenerate when canRegenerate is false', () => {
      const actions = resolveMessageActions(
        trialCtx,
        makeMsgContext({ message: { role: 'assistant' }, canRegenerate: false })
      );

      expect(actions.has('regenerate')).toBe(false);
      expect(actions.has('copy')).toBe(true);
    });
  });

  // ─── Link Guest (write) ───────────────────────────────────

  describe('link-guest (write privilege)', () => {
    const linkWriteCtx: ChatContext = {
      mode: 'link-guest',
      privilege: 'write',
      currentUserId: 'guest-1',
      isGroupChat: false,
    };

    it('shows copy, regenerate, fork on AI message (no share)', () => {
      const actions = resolveMessageActions(
        linkWriteCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actions.has('copy')).toBe(true);
      expect(actions.has('regenerate')).toBe(true);
      expect(actions.has('fork')).toBe(true);
      expect(actions.has('share')).toBe(false);
    });

    it('shows copy, retry, edit, fork on own user message', () => {
      const actions = resolveMessageActions(
        linkWriteCtx,
        makeMsgContext({ message: { role: 'user', senderId: 'guest-1' } })
      );

      expect(actions.has('copy')).toBe(true);
      expect(actions.has('retry')).toBe(true);
      expect(actions.has('edit')).toBe(true);
      expect(actions.has('fork')).toBe(true);
    });

    it('shows retry-error on error AI message', () => {
      const actions = resolveMessageActions(
        linkWriteCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

      expect(actions.has('retry-error')).toBe(true);
    });
  });

  // ─── Link Guest (read) ────────────────────────────────────

  describe('link-guest (read privilege)', () => {
    const linkReadCtx: ChatContext = {
      mode: 'link-guest',
      privilege: 'read',
      currentUserId: undefined,
      isGroupChat: false,
    };

    it('shows only copy on AI message', () => {
      const actions = resolveMessageActions(
        linkReadCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });

    it('shows only copy on user message', () => {
      const actions = resolveMessageActions(
        linkReadCtx,
        makeMsgContext({ message: { role: 'user' } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });

    it('shows no actions on streaming message', () => {
      const actions = resolveMessageActions(
        linkReadCtx,
        makeMsgContext({ message: { role: 'assistant' }, isStreaming: true })
      );

      expect(actions.size).toBe(0);
    });

    it('shows no actions on error message', () => {
      const actions = resolveMessageActions(
        linkReadCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

      expect(actions.size).toBe(0);
    });
  });

  // ─── Edge Cases ────────────────────────────────────────────

  describe('edge cases', () => {
    it('returns empty set for unknown privilege', () => {
      const ctx: ChatContext = {
        mode: 'group',
        privilege: 'nonexistent' as never,
        currentUserId: 'user-1',
        isGroupChat: true,
      };
      const actions = resolveMessageActions(ctx, makeMsgContext());

      expect(actions.size).toBe(0);
    });

    it('canRegenerate false hides regenerate on AI message', () => {
      const ctx: ChatContext = {
        mode: 'solo',
        privilege: 'owner',
        currentUserId: 'user-1',
        isGroupChat: false,
      };
      const actions = resolveMessageActions(
        ctx,
        makeMsgContext({ message: { role: 'assistant' }, canRegenerate: false })
      );

      expect(actions.has('regenerate')).toBe(false);
      expect(actions.has('copy')).toBe(true);
    });

    it('isMultiModel hides retry and edit on user message', () => {
      const ctx: ChatContext = {
        mode: 'solo',
        privilege: 'owner',
        currentUserId: 'user-1',
        isGroupChat: false,
      };
      const actions = resolveMessageActions(
        ctx,
        makeMsgContext({ message: { role: 'user' }, isMultiModel: true })
      );

      expect(actions.has('retry')).toBe(false);
      expect(actions.has('edit')).toBe(false);
      expect(actions.has('fork')).toBe(true);
    });
  });
});
