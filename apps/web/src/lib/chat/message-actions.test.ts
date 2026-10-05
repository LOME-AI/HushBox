import { describe, it, expect } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  resolveMessageActions,
  buildChatContext,
  regenerateRefusalOf,
  rerunGateScope,
  type MessageAction,
  type ChatContext,
  type MessageContext,
} from './message-actions.js';

describe('regenerateRefusalOf', () => {
  it('carries a money refusal through', () => {
    expect(
      regenerateRefusalOf({
        sendRefusal: 'insufficient_funds',
        fundingSource: 'personal_balance',
      })
    ).toBe('insufficient_funds');
  });

  it('carries a hold refusal through so the transient reason still shows', () => {
    expect(
      regenerateRefusalOf({ sendRefusal: 'funds_held_by_run', fundingSource: 'personal_balance' })
    ).toBe('funds_held_by_run');
  });

  it('refuses a regenerate while the payer’s funding cannot be read', () => {
    expect(
      regenerateRefusalOf({
        sendRefusal: 'send_check_unavailable',
        fundingSource: 'personal_balance',
      })
    ).toBe('send_check_unavailable');
  });

  it('refuses a regenerate when no funding verdict exists for the payer', () => {
    expect(regenerateRefusalOf({ sendRefusal: undefined, fundingSource: 'no_verdict' })).toBe(
      'send_check_unavailable'
    );
  });

  it('exempts a regenerate from the signed-in premium entitlement gate', () => {
    expect(
      regenerateRefusalOf({
        sendRefusal: 'premium_requires_credit',
        fundingSource: 'personal_balance',
      })
    ).toBeUndefined();
  });

  it('exempts a regenerate from the account-required premium gate', () => {
    expect(
      regenerateRefusalOf({
        sendRefusal: 'premium_requires_account',
        fundingSource: 'personal_balance',
      })
    ).toBeUndefined();
  });

  it('refuses nothing when the send gate refuses nothing', () => {
    expect(
      regenerateRefusalOf({ sendRefusal: undefined, fundingSource: 'personal_balance' })
    ).toBeUndefined();
  });
});

function makeMessage(
  overrides: Partial<{
    id: string;
    role: 'user' | 'assistant';
    senderId: string;
    parentMessageId: string | null;
    awaitingStoredRow: true;
    unsavedQuestion: true;
  }> = {}
): MessageContext['message'] {
  const base: MessageContext['message'] = {
    id: overrides.id ?? 'm1',
    conversationId: 'conv-1',
    role: overrides.role ?? 'assistant',
    content: 'Hello',
    createdAt: isoAt(TEST_DAY_START),
    parentMessageId: overrides.parentMessageId ?? null,
  };
  if (overrides.senderId !== undefined) {
    base.senderId = overrides.senderId;
  }
  if (overrides.awaitingStoredRow !== undefined) {
    base.awaitingStoredRow = overrides.awaitingStoredRow;
  }
  if (overrides.unsavedQuestion !== undefined) {
    base.unsavedQuestion = overrides.unsavedQuestion;
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
      awaitingStoredRow: true;
      unsavedQuestion: true;
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

  describe('a message-link reader', () => {
    const readRow: ChatContext = {
      mode: 'link-guest',
      privilege: 'read',
      currentUserId: undefined,
      isGroupChat: false,
    };

    it('takes the read-only link row when signed out', () => {
      const ctx = buildChatContext({
        isAuthenticated: false,
        isLinkGuest: false,
        isMessageLink: true,
        privilege: undefined,
        currentUserId: undefined,
        isGroupChat: false,
      });

      expect(ctx).toEqual(readRow);
    });

    it('takes the read-only link row when signed in', () => {
      const ctx = buildChatContext({
        isAuthenticated: true,
        isLinkGuest: false,
        isMessageLink: true,
        privilege: undefined,
        currentUserId: 'reader-1',
        isGroupChat: false,
      });

      expect(ctx).toEqual(readRow);
    });

    it('takes the read-only link row whatever privilege or group the caller names', () => {
      const ctx = buildChatContext({
        isAuthenticated: true,
        isLinkGuest: true,
        isMessageLink: true,
        privilege: 'owner',
        currentUserId: 'reader-1',
        isGroupChat: true,
      });

      expect(ctx).toEqual(readRow);
    });

    it('is offered Copy alone on a reply when signed in', () => {
      const ctx = buildChatContext({
        isAuthenticated: true,
        isLinkGuest: false,
        isMessageLink: true,
        privilege: undefined,
        currentUserId: 'reader-1',
        isGroupChat: false,
      });

      const actions = resolveMessageActions(
        ctx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });

    it('is offered Copy alone on a reply when signed out', () => {
      const ctx = buildChatContext({
        isAuthenticated: false,
        isLinkGuest: false,
        isMessageLink: true,
        privilege: undefined,
        currentUserId: undefined,
        isGroupChat: false,
      });

      const actions = resolveMessageActions(
        ctx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });
  });

  describe('every other viewer resolves as it did without the message-link flag', () => {
    const viewers: {
      viewer: string;
      options: Omit<Parameters<typeof buildChatContext>[0], 'isMessageLink'>;
      context: ChatContext;
    }[] = [
      {
        viewer: 'a solo owner',
        options: {
          isAuthenticated: true,
          isLinkGuest: false,
          privilege: 'owner',
          currentUserId: 'user-1',
          isGroupChat: false,
        },
        context: { mode: 'solo', privilege: 'owner', currentUserId: 'user-1', isGroupChat: false },
      },
      {
        viewer: 'a group member who may write',
        options: {
          isAuthenticated: true,
          isLinkGuest: false,
          privilege: 'write',
          currentUserId: 'user-1',
          isGroupChat: true,
        },
        context: { mode: 'group', privilege: 'write', currentUserId: 'user-1', isGroupChat: true },
      },
      {
        viewer: 'a group member who may only read',
        options: {
          isAuthenticated: true,
          isLinkGuest: false,
          privilege: 'read',
          currentUserId: 'user-1',
          isGroupChat: true,
        },
        context: { mode: 'group', privilege: 'read', currentUserId: 'user-1', isGroupChat: true },
      },
      {
        viewer: 'a write-link guest',
        options: {
          isAuthenticated: false,
          isLinkGuest: true,
          privilege: 'write',
          currentUserId: 'guest-1',
          isGroupChat: true,
        },
        context: {
          mode: 'link-guest',
          privilege: 'write',
          currentUserId: 'guest-1',
          isGroupChat: true,
        },
      },
      {
        viewer: 'a read-link guest',
        options: {
          isAuthenticated: false,
          isLinkGuest: true,
          privilege: 'read',
          currentUserId: 'guest-1',
          isGroupChat: true,
        },
        context: {
          mode: 'link-guest',
          privilege: 'read',
          currentUserId: 'guest-1',
          isGroupChat: true,
        },
      },
      {
        viewer: 'a trial visitor',
        options: {
          isAuthenticated: false,
          isLinkGuest: false,
          privilege: undefined,
          currentUserId: undefined,
          isGroupChat: false,
        },
        context: {
          mode: 'trial',
          privilege: undefined,
          currentUserId: undefined,
          isGroupChat: false,
        },
      },
    ];

    it.each(viewers)('$viewer keeps their row when the flag is false', ({ options, context }) => {
      expect(buildChatContext({ ...options, isMessageLink: false })).toEqual(context);
    });

    it.each(viewers)('$viewer keeps their row when the flag is absent', ({ options, context }) => {
      expect(buildChatContext(options)).toEqual(context);
    });
  });
});

describe('rerunGateScope', () => {
  const rows: { row: string; context: ChatContext; grants: boolean }[] = [
    {
      row: 'solo owner',
      context: { mode: 'solo', privilege: 'owner', currentUserId: 'u', isGroupChat: false },
      grants: true,
    },
    {
      row: 'group owner',
      context: { mode: 'group', privilege: 'owner', currentUserId: 'u', isGroupChat: true },
      grants: true,
    },
    {
      row: 'group admin',
      context: { mode: 'group', privilege: 'admin', currentUserId: 'u', isGroupChat: true },
      grants: true,
    },
    {
      row: 'group write',
      context: { mode: 'group', privilege: 'write', currentUserId: 'u', isGroupChat: true },
      grants: true,
    },
    {
      row: 'group read',
      context: { mode: 'group', privilege: 'read', currentUserId: 'u', isGroupChat: true },
      grants: false,
    },
    {
      row: 'trial',
      context: {
        mode: 'trial',
        privilege: undefined,
        currentUserId: undefined,
        isGroupChat: false,
      },
      grants: true,
    },
    {
      row: 'link-guest write',
      context: { mode: 'link-guest', privilege: 'write', currentUserId: 'g', isGroupChat: false },
      grants: false,
    },
    {
      row: 'link-guest read',
      context: { mode: 'link-guest', privilege: 'read', currentUserId: 'g', isGroupChat: false },
      grants: false,
    },
  ];

  it.each(rows.filter((r) => r.grants))(
    'prices a re-run on the $row row against the conversation and the privilege',
    ({ context }) => {
      expect(rerunGateScope(context, 'conv-1', 'write')).toEqual({
        conversationId: 'conv-1',
        currentUserPrivilege: 'write',
      });
    }
  );

  it.each(rows.filter((r) => !r.grants))('grants no re-run on the $row row', ({ context }) => {
    expect(rerunGateScope(context, 'conv-1', 'read')).toBeUndefined();
  });

  it('names nothing the caller does not hold', () => {
    const solo: ChatContext = {
      mode: 'solo',
      privilege: 'owner',
      currentUserId: 'u',
      isGroupChat: false,
    };
    expect(rerunGateScope(solo)).toEqual({});
  });
});

describe('resolveMessageActions', () => {
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

    it('shows copy, retry, edit on own user message', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'user', senderId: 'user-1' } })
      );

      expect(actions.has('copy')).toBe(true);
      expect(actions.has('retry')).toBe(true);
      expect(actions.has('edit')).toBe(true);
      expect(actions.has('fork')).toBe(false);
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

    it('keeps copy and regenerate available on errored AI message (replaces the deleted Retry button)', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

      expect(actions.has('copy')).toBe(true);
      expect(actions.has('regenerate')).toBe(true);
    });

    it('hides fork and share on errored AI message (no successful turn to branch from)', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

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

    it('shows regenerate even when isMultiModel is true (multi-model per-tile regenerate-one)', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'assistant' }, isMultiModel: true })
      );

      expect(actions.has('regenerate')).toBe(true);
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
      expect(actions.has('fork')).toBe(false);
    });
  });

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
      expect(actions.has('fork')).toBe(false);
    });

    it('shows only copy on other user message', () => {
      const actions = resolveMessageActions(
        groupWriteCtx,
        makeMsgContext({ message: { role: 'user', senderId: 'user-2' } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
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

    it('keeps copy available on errored message (so readers can quote the error)', () => {
      const actions = resolveMessageActions(
        groupReadCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });
  });

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

    it('shows copy, edit, and retry on user message', () => {
      const actions = resolveMessageActions(
        trialCtx,
        makeMsgContext({ message: { role: 'user' } })
      );

      expect(actionsArray(actions)).toEqual(['copy', 'edit', 'retry']);
    });

    it('does not show fork or share', () => {
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
      expect(aiActions.has('edit')).toBe(false);
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

  describe('link-guest (write privilege)', () => {
    // A write-link guest sends through the guest chat route; every re-run and fork route accepts
    // signed-in members only, so Copy is the one action the guest can complete on a message.
    const linkWriteCtx: ChatContext = {
      mode: 'link-guest',
      privilege: 'write',
      currentUserId: 'guest-1',
      isGroupChat: true,
    };

    it('offers Copy alone on a reply', () => {
      const actions = resolveMessageActions(
        linkWriteCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });

    it('offers Copy alone on its own question', () => {
      const actions = resolveMessageActions(
        linkWriteCtx,
        makeMsgContext({ message: { role: 'user', senderId: 'guest-1' } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });

    it('offers Copy alone on an errored reply', () => {
      const actions = resolveMessageActions(
        linkWriteCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });
  });

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

    it('keeps copy available on errored message (link-guest read)', () => {
      const actions = resolveMessageActions(
        linkReadCtx,
        makeMsgContext({ message: { role: 'assistant' }, isError: true })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });
  });

  describe('the full action set each row offers', () => {
    const rows: {
      row: string;
      context: ChatContext;
      reply: MessageAction[];
      ownQuestion: MessageAction[];
    }[] = [
      {
        row: 'solo owner',
        context: { mode: 'solo', privilege: 'owner', currentUserId: 'me', isGroupChat: false },
        reply: ['copy', 'fork', 'regenerate', 'share'],
        ownQuestion: ['copy', 'edit', 'retry'],
      },
      {
        row: 'group owner',
        context: { mode: 'group', privilege: 'owner', currentUserId: 'me', isGroupChat: true },
        reply: ['copy', 'fork', 'regenerate', 'share'],
        ownQuestion: ['copy', 'edit', 'retry'],
      },
      {
        row: 'group admin',
        context: { mode: 'group', privilege: 'admin', currentUserId: 'me', isGroupChat: true },
        reply: ['copy', 'fork', 'regenerate', 'share'],
        ownQuestion: ['copy', 'edit', 'retry'],
      },
      {
        row: 'group write',
        context: { mode: 'group', privilege: 'write', currentUserId: 'me', isGroupChat: true },
        reply: ['copy', 'fork', 'regenerate', 'share'],
        ownQuestion: ['copy', 'edit', 'retry'],
      },
      {
        row: 'group read',
        context: { mode: 'group', privilege: 'read', currentUserId: 'me', isGroupChat: true },
        reply: ['copy'],
        ownQuestion: ['copy'],
      },
      {
        row: 'trial',
        context: {
          mode: 'trial',
          privilege: undefined,
          currentUserId: undefined,
          isGroupChat: false,
        },
        reply: ['copy', 'regenerate'],
        ownQuestion: ['copy', 'edit', 'retry'],
      },
      {
        row: 'link-guest write',
        context: { mode: 'link-guest', privilege: 'write', currentUserId: 'me', isGroupChat: true },
        reply: ['copy'],
        ownQuestion: ['copy'],
      },
      {
        row: 'link-guest read',
        context: { mode: 'link-guest', privilege: 'read', currentUserId: 'me', isGroupChat: true },
        reply: ['copy'],
        ownQuestion: ['copy'],
      },
    ];

    it.each(rows)(
      'the $row row offers its reply and own-question actions',
      ({ context, reply, ownQuestion }) => {
        const onReply = resolveMessageActions(
          context,
          makeMsgContext({ message: { role: 'assistant' } })
        );
        const onOwnQuestion = resolveMessageActions(
          context,
          makeMsgContext({ message: { role: 'user', senderId: 'me' } })
        );

        expect({ reply: actionsArray(onReply), ownQuestion: actionsArray(onOwnQuestion) }).toEqual({
          reply,
          ownQuestion,
        });
      }
    );
  });

  describe("a watcher's tile waiting for its stored row", () => {
    const groupWriteCtx: ChatContext = {
      mode: 'group',
      privilege: 'write',
      currentUserId: 'user-1',
      isGroupChat: true,
    };

    it('resolves no actions for an answer awaiting its stored row', () => {
      const actions = resolveMessageActions(
        groupWriteCtx,
        makeMsgContext({ message: { role: 'assistant', awaitingStoredRow: true } })
      );

      expect(actionsArray(actions)).toEqual([]);
    });

    it('resolves the usual answer actions once no flag marks it as waiting', () => {
      const actions = resolveMessageActions(
        groupWriteCtx,
        makeMsgContext({ message: { role: 'assistant' } })
      );

      expect(actionsArray(actions)).toEqual(['copy', 'fork', 'regenerate', 'share']);
    });
  });

  describe("a failed turn's question drawn from its record", () => {
    const soloCtx: ChatContext = {
      mode: 'solo',
      privilege: 'owner',
      currentUserId: 'user-1',
      isGroupChat: false,
    };

    it('offers Copy and nothing else', () => {
      const actions = resolveMessageActions(
        soloCtx,
        makeMsgContext({ message: { role: 'user', unsavedQuestion: true } })
      );

      expect(actionsArray(actions)).toEqual(['copy']);
    });

    it('leaves a stored question its usual actions', () => {
      const actions = resolveMessageActions(soloCtx, makeMsgContext({ message: { role: 'user' } }));

      expect(actionsArray(actions)).toEqual(['copy', 'edit', 'retry']);
    });
  });

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

    it('isMultiModel allows retry and edit on user message (retry-all/edit-all)', () => {
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

      expect(actions.has('retry')).toBe(true);
      expect(actions.has('edit')).toBe(true);
      expect(actions.has('fork')).toBe(false);
    });
  });
});
