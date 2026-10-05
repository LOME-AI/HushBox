import { describe, it, expect, vi } from 'vitest';
import { serializeSegments } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  getMobileInputStyle,
  getContentAreaStyle,
  getWebSocketAttributes,
  resolveChatLayoutDerivedState,
  resolveBranchSwitcherHandlers,
  buildMemberSidebarProps,
} from '@/components/chat/layout/chat-layout-helpers';
import type { Message } from '@/lib/api/api';
import type { GroupChatProps } from '@/components/chat/layout/chat-layout';

describe('getMobileInputStyle', () => {
  it('returns undefined when not mobile', () => {
    expect(
      getMobileInputStyle({ isMobile: false, keyboardOffset: 10, isKeyboardVisible: true })
    ).toBeUndefined();
  });

  it('returns fixed-position style with keyboard offset when mobile', () => {
    const style = getMobileInputStyle({
      isMobile: true,
      keyboardOffset: 42,
      isKeyboardVisible: false,
    });

    expect(style).toMatchObject({
      position: 'fixed',
      bottom: '42px',
      transition: 'bottom 0.2s ease-out',
      zIndex: 10,
    });
  });

  it('disables transition while the keyboard is visible', () => {
    const style = getMobileInputStyle({
      isMobile: true,
      keyboardOffset: 0,
      isKeyboardVisible: true,
    });

    expect(style?.transition).toBe('none');
  });
});

describe('getContentAreaStyle', () => {
  it('returns a bottom margin equal to the input height on mobile', () => {
    expect(getContentAreaStyle(true, 64)).toEqual({ marginBottom: 64 });
  });

  it('returns undefined on mobile when the input height is zero', () => {
    expect(getContentAreaStyle(true, 0)).toBeUndefined();
  });

  it('returns undefined when not mobile', () => {
    expect(getContentAreaStyle(false, 64)).toBeUndefined();
  });
});

describe('getWebSocketAttributes', () => {
  it('returns "true" for connected and ready when both are true', () => {
    expect(getWebSocketAttributes({ connected: true, ready: true })).toEqual({
      wsConnected: 'true',
      wsReady: 'true',
    });
  });

  it('returns undefined attributes when ws is undefined', () => {
    const noWs: { connected: boolean; ready: boolean } | undefined = undefined;
    expect(getWebSocketAttributes(noWs)).toEqual({
      wsConnected: undefined,
      wsReady: undefined,
    });
  });

  it('returns undefined for a flag that is false', () => {
    expect(getWebSocketAttributes({ connected: false, ready: true })).toEqual({
      wsConnected: undefined,
      wsReady: 'true',
    });
  });
});

describe('resolveChatLayoutDerivedState', () => {
  const baseMessage: Message = {
    id: 'm1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'hello',
    createdAt: isoAt(TEST_DAY_START),
  };

  it('passes premiumIds through untouched', () => {
    const premiumIds = new Set(['gpt-5']);
    const result = resolveChatLayoutDerivedState({
      premiumIds,
      shareMessageId: null,
      messages: [],
    });

    expect(result.premiumIds).toBe(premiumIds);
  });

  it('hands over no shared reply while no message is selected', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      shareMessageId: null,
      messages: [baseMessage],
    });

    expect(result.sharedMessage).toBeNull();
  });

  it('hands over no shared reply when the selected id matches no message', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      shareMessageId: 'missing',
      messages: [baseMessage],
    });

    expect(result.sharedMessage).toBeNull();
  });

  /** A thread message carrying every field the link publishes and every field it withholds. */
  const THREAD_MESSAGE: Message = {
    ...baseMessage,
    id: 'shared',
    content: 'shared content',
    modelName: 'anthropic/claude-sonnet-4.5',
    isSmartModel: true,
    reasoningTokens: 1204,
    reasoningEffort: 'high',
    reasoningDurationMs: 9000,
    deleted: false,
    epochNumber: 7,
    wrappedContentKey: 'wrapped-key',
    mediaItems: [],
    senderId: 'sender-42',
    cost: '1234567890',
    inputTokens: 4321,
    outputTokens: 8765,
    resolvedModelName: 'Claude Sonnet 4.5',
  };

  it('hands over exactly the fields the link publishes', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      shareMessageId: 'shared',
      messages: [baseMessage, THREAD_MESSAGE],
    });

    expect(result.sharedMessage).toStrictEqual({
      id: 'shared',
      content: 'shared content',
      createdAt: baseMessage.createdAt,
      modelName: 'anthropic/claude-sonnet-4.5',
      isSmartModel: true,
      reasoningTokens: 1204,
      reasoningEffort: 'high',
      reasoningDurationMs: 9000,
      deleted: false,
      epochNumber: 7,
      wrappedContentKey: 'wrapped-key',
      mediaItems: [],
      senderId: 'sender-42',
    });
  });

  it('leaves out the cost, the token counts and the resolved name the link withholds', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      shareMessageId: 'shared',
      messages: [THREAD_MESSAGE],
    });

    const keys = Object.keys(result.sharedMessage ?? {});
    expect(keys).not.toContain('cost');
    expect(keys).not.toContain('inputTokens');
    expect(keys).not.toContain('outputTokens');
    expect(keys).not.toContain('resolvedModelName');
  });

  it('adds no key for a published field the message does not carry', () => {
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      shareMessageId: 'm1',
      messages: [baseMessage],
    });

    expect(result.sharedMessage).toStrictEqual({
      id: 'm1',
      content: 'hello',
      createdAt: baseMessage.createdAt,
    });
  });

  it('keeps the framed text whole, reasoning included', () => {
    // A share link publishes the reasoning, so the preview must be able to
    // show it. The raw framed text travels and the display surface parses it,
    // exactly as the public share page parses the same field.
    const raw = serializeSegments([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'private thoughts' }] },
      { kind: 'text', text: 'the answer' },
    ]);
    const shared: Message = { ...baseMessage, id: 'shared', content: raw };
    const result = resolveChatLayoutDerivedState({
      premiumIds: new Set(),
      shareMessageId: 'shared',
      messages: [shared],
    });

    expect(result.sharedMessage?.content).toBe(raw);
  });
});

describe('resolveBranchSwitcherHandlers', () => {
  it('names no current branch and falls back to no-op handlers when nothing is provided', () => {
    const resolved = resolveBranchSwitcherHandlers({
      activeForkId: undefined,
      onForkSelect: undefined,
      onForkRename: undefined,
      onForkDelete: undefined,
    });

    expect(resolved.currentForkId).toBeNull();
    expect(() => {
      resolved.onSelect('x');
      resolved.onRename('x', 'y');
      resolved.onDelete('x');
    }).not.toThrow();
  });

  it('forwards the active fork and the page handlers', () => {
    const onForkSelect = vi.fn<(forkId: string) => void>();
    const onForkRename = vi.fn<(forkId: string, currentName: string) => void>();
    const onForkDelete = vi.fn<(forkId: string) => void>();

    const resolved = resolveBranchSwitcherHandlers({
      activeForkId: 'f1',
      onForkSelect,
      onForkRename,
      onForkDelete,
    });

    expect(resolved.currentForkId).toBe('f1');
    expect(resolved.onSelect).toBe(onForkSelect);
    expect(resolved.onRename).toBe(onForkRename);
    expect(resolved.onDelete).toBe(onForkDelete);
  });
});

describe('buildMemberSidebarProps', () => {
  function makeGroupChat(overrides: Partial<GroupChatProps> = {}): GroupChatProps {
    return {
      conversationId: 'conv-1',
      members: [{ id: 'm1', userId: 'u1', username: 'a', privilege: 'owner' }],
      links: [],
      onlineMemberIds: new Set(['u1']),
      currentUserId: 'u1',
      currentUserLinkId: null,
      currentUserPrivilege: 'owner',
      currentEpochKey: { epochNumber: 1, privateKey: new Uint8Array(32) },
      ...overrides,
    };
  }

  it('returns an empty object when there is no group chat', () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- groupChat is a required positional arg
    expect(buildMemberSidebarProps(undefined)).toEqual({});
  });

  it('maps core fields and omits optional callbacks that are absent', () => {
    const result = buildMemberSidebarProps(makeGroupChat());

    expect(result.members).toHaveLength(1);
    expect(result.currentUserId).toBe('u1');
    expect(result.currentUserLinkId).toBeNull();
    expect(result).not.toHaveProperty('onRemoveMember');
    expect(result).not.toHaveProperty('onChangePrivilege');
    expect(result).not.toHaveProperty('onRevokeLinkClick');
    expect(result).not.toHaveProperty('onSaveLinkName');
    expect(result).not.toHaveProperty('onChangeLinkPrivilege');
    expect(result).not.toHaveProperty('onLeaveClick');
  });

  it('forwards every optional callback when the group chat provides them', () => {
    const onRemoveMember = vi.fn();
    const onChangePrivilege = vi.fn();
    const onRevokeLinkClick = vi.fn();
    const onSaveLinkName = vi.fn();
    const onChangeLinkPrivilege = vi.fn();
    const onLeave = vi.fn();

    const result = buildMemberSidebarProps(
      makeGroupChat({
        currentUserLinkId: 'link-9',
        onRemoveMember,
        onChangePrivilege,
        onRevokeLinkClick,
        onSaveLinkName,
        onChangeLinkPrivilege,
        onLeave,
      })
    );

    expect(result.currentUserLinkId).toBe('link-9');
    expect(result.onRemoveMember).toBe(onRemoveMember);
    expect(result.onChangePrivilege).toBe(onChangePrivilege);
    expect(result.onRevokeLinkClick).toBe(onRevokeLinkClick);
    expect(result.onSaveLinkName).toBe(onSaveLinkName);
    expect(result.onChangeLinkPrivilege).toBe(onChangeLinkPrivilege);
    expect(result.onLeaveClick).toBe(onLeave);
  });
});
