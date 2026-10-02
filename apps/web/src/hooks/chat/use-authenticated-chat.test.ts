import { createElement } from 'react';
import { renderHook, act, waitFor, render as renderElement } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SMART_MODEL_ID,
  parseAssistantMessage,
  friendlyErrorMessage,
  historyCharacterCount,
  serializeSegments,
  stripReplayHistory,
} from '@hushbox/shared';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { useMessageQueueStore } from '@/stores/chat/message-queue';
import { usePreInferenceActivityStore } from '@/stores/activity/pre-inference';
import { clearEpochKeyCache, processKeyChain } from '@/lib/crypto/epoch-key-cache';
import { turnNoticeForCode, turnNoticeText, type TurnNotice } from '@/lib/chat/turn-notice';
import {
  useAuthenticatedChat,
  shouldStreamFirstTurn,
  resolveDrainDecision,
} from '@/hooks/chat/use-authenticated-chat';
import type { KeyChainVerdict, verifyKeyChain } from '@hushbox/crypto';
import type { Message } from '@/lib/api/api';
import type { KeyChainResponse, ResolvedReasoningEffort } from '@hushbox/shared';
import type { StreamOptions } from '@/hooks/chat/use-chat-stream';

// ---------------------------------------------------------------------------
// Module seams. Everything that is a genuine dependency boundary is mocked;
// the pure helper libs (`@/lib/chat/auth-chat-helpers`, `@/lib/chat/messages`,
// `@/lib/chat/multi-model-stream`, `@/lib/chat/regeneration`), `@/lib/crypto/epoch-key-cache`,
// and `@/hooks/chat/use-optimistic-messages` are exercised for real so behaviour
// is observed rather than stubbed.
// ---------------------------------------------------------------------------

// `@/lib/api/api` runs env validation at import; the hook only type-imports it, so a
// stub keeps any transitive load inert.
vi.mock('@/lib/api/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
  ApiError: class ApiError extends Error {},
}));

const mockFetchJson = vi.fn();
const mockMessagePost = vi.fn((_argument: unknown, _init?: unknown) => ({}) as unknown);
vi.mock('@/lib/api-client', () => ({
  client: {
    chat: {
      ':conversationId': {
        message: {
          $post: (argument: unknown, init?: unknown) => mockMessagePost(argument, init),
        },
      },
    },
  },
  fetchJson: (argument: unknown) => mockFetchJson(argument),
}));

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

// Invoke functional updaters (as applyPrune passes) so their inner filter runs;
// exercise both the populated and the empty-cache arms.
const mockSetQueryData = vi.fn((_key: unknown, updater: unknown) => {
  if (typeof updater === 'function') {
    (updater as (old?: unknown) => unknown)([{ id: 'a1' }, { id: 'keep' }]);
    (updater as (old?: unknown) => unknown)();
  }
});
const mockInvalidateQueries = vi.fn().mockResolvedValue(null);
// Defaults to no cached data; a create-flow test that needs the post-
// invalidation refetch to have landed sets a return value before rendering.
const mockGetQueryData = vi.fn((): unknown => undefined);
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: mockSetQueryData,
    invalidateQueries: mockInvalidateQueries,
    getQueryData: mockGetQueryData,
  }),
}));

const mockToastError = vi.fn();
vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useIsMobile: (): boolean => mockIsMobile,
    toast: { error: (...args: unknown[]): void => mockToastError(...args) },
  };
});
let mockIsMobile = false;

// Deterministic crypto so the create flow runs without real key material.
vi.mock('@hushbox/crypto', () => ({
  createFirstEpoch: vi.fn(() => ({
    epochPublicKey: new Uint8Array(32).fill(10),
    epochPrivateKey: new Uint8Array(32).fill(11),
    confirmationHash: new Uint8Array(32).fill(12),
    memberWraps: [{ wrap: new Uint8Array(32).fill(14) }],
  })),
  getPublicKeyFromPrivate: vi.fn(() => new Uint8Array(32).fill(9)),
  encryptTextForEpoch: vi.fn(() => new Uint8Array(32).fill(20)),
  // Consumed by the real `auth-chat-helpers` / `epoch-key-cache` we keep live.
  decryptTextFromEpoch: vi.fn(() => 'decrypted'),
  verifyKeyChain: (
    keyChain: KeyChainResponse,
    principalPrivateKey: Uint8Array,
    conversationId: string
  ): KeyChainVerdict => mockVerifyKeyChain(keyChain, principalPrivateKey, conversationId),
}));

// The verdict the real epoch-key cache records comes from this verifier.
const mockVerifyKeyChain = vi.fn<typeof verifyKeyChain>();

const mockRequestEpochMaintenanceOnRefusal = vi.fn();
vi.mock('@/hooks/crypto/use-epoch-maintenance', () => ({
  requestEpochMaintenanceOnRefusal: (...args: unknown[]): unknown =>
    mockRequestEpochMaintenanceOnRefusal(...args),
}));

// -- use-chat-page ----------------------------------------------------------
const mockStartStreaming = vi.fn();
const mockStopStreaming = vi.fn();
const mockStopPersisting = vi.fn();
const mockClearInput = vi.fn();
const mockSetInputValue = vi.fn();
let mockInputValue = 'hello world';
vi.mock('@/hooks/chat/use-chat-page', () => ({
  useChatPageState: () => ({
    inputValue: mockInputValue,
    setInputValue: mockSetInputValue,
    clearInput: mockClearInput,
    streamingMessageIds: new Set<string>(),
    streamingMessageIdsRef: { current: new Set<string>() },
    startStreaming: mockStartStreaming,
    stopStreaming: mockStopStreaming,
    persistingMessageIds: new Set<string>(),
    persistingMessageIdsRef: { current: new Set<string>() },
    stopPersisting: mockStopPersisting,
  }),
}));

// -- use-chat-stream (mocked hook + real-shaped error classes) --------------
const mockStartStream = vi.fn();
const mockStartRegenerateStream = vi.fn();
const mockStopRun = vi.fn();
let mockIsStreaming = false;
vi.mock('@/hooks/chat/use-chat-stream', () => {
  class ChatRequestError extends Error {
    constructor(
      public readonly code: string,
      public readonly details?: Record<string, unknown>,
      public readonly status?: number
    ) {
      super(code);
      this.name = 'ChatRequestError';
    }
  }
  class ChatRunFailedError extends Error {
    constructor(
      public readonly code: string,
      public readonly notBilled = true
    ) {
      super(code);
      this.name = 'ChatRunFailedError';
    }
  }
  return {
    useChatStream: () => ({
      isStreaming: mockIsStreaming,
      startStream: mockStartStream,
      startRegenerateStream: mockStartRegenerateStream,
      stopRun: mockStopRun,
    }),
    ChatRequestError,
    ChatRunFailedError,
  };
});

// -- chat query hooks -------------------------------------------------------
const mockCreateConversationMutateAsync = vi.fn();
let mockConversationData:
  | { id: string; callerId?: string; callerPrivilege?: string; title?: string }
  | undefined;
let mockConversationLoading = false;
let mockConversationPaused = false;
let mockMessagesData: Message[] | undefined;
let mockMessagesLoading = false;
let mockMessagesPaused = false;
vi.mock('@/hooks/chat/chat', () => ({
  DECRYPTING_TITLE: 'Decrypting...',
  chatKeys: {
    conversation: (id: string) => ['conversation', id],
    messages: (id: string) => ['messages', id],
  },
  useConversation: () => ({
    data: mockConversationData,
    isLoading: mockConversationLoading,
    isPaused: mockConversationPaused,
  }),
  useMessages: () => ({
    data: mockMessagesData,
    isLoading: mockMessagesLoading,
    isPaused: mockMessagesPaused,
  }),
  useCreateConversation: () => ({ mutateAsync: mockCreateConversationMutateAsync }),
}));

// -- decrypted / fork message pipeline (identity pass-throughs) -------------
vi.mock('@/hooks/crypto/use-decrypted-messages', () => ({
  useDecryptedMessages: (_id: string | null, apiMessages: Message[] | undefined) =>
    apiMessages ?? [],
}));
vi.mock('@/hooks/chat/use-fork-messages', () => ({
  useForkMessages: (decrypted: Message[]) => decrypted,
}));
let mockForksData: unknown[] | undefined = [];
vi.mock('@/hooks/chat/forks', () => ({
  useForks: () => ({ data: mockForksData }),
}));

// -- stores -----------------------------------------------------------------
const mockClearPendingMessage = vi.fn();
let mockPendingMessage: string | null = null;
let mockPendingFundingSource: string | null = null;
vi.mock('@/stores/chat/pending-chat', () => ({
  usePendingChatStore: (selector: (s: unknown) => unknown) =>
    selector({
      pendingMessage: mockPendingMessage,
      pendingFundingSource: mockPendingFundingSource,
      clearPendingMessage: mockClearPendingMessage,
    }),
}));

interface ModelState {
  activeModality: 'text' | 'image' | 'video' | 'audio';
  selections: Record<string, { id: string; name: string }[]>;
  imageConfig: { aspectRatio: string };
  videoConfig: { aspectRatio: string; durationSeconds: number; resolution: string };
  audioConfig: { format: string; maxDurationSeconds: number };
}
const modelState: ModelState = {
  activeModality: 'text',
  selections: {
    text: [{ id: 'test-model', name: 'Test Model' }],
    image: [{ id: 'img-model', name: 'Image Model' }],
    video: [{ id: 'vid-model', name: 'Video Model' }],
    audio: [{ id: 'aud-model', name: 'Audio Model' }],
  },
  imageConfig: { aspectRatio: '4:3' },
  videoConfig: { aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' },
  audioConfig: { format: 'mp3', maxDurationSeconds: 600 },
};
vi.mock('@/stores/model', () => ({
  useModelStore: (selector: (s: ModelState) => unknown) => selector(modelState),
  getPrimaryModel: (entries: { id: string; name: string }[]) =>
    entries[0] ?? { id: 'smart-model', name: 'Smart Model' },
}));

const mockSetError = vi.fn();
const mockClearError = vi.fn();
const mockClearAll = vi.fn();
let mockErrorsByFork: Record<string, { id: string; notice: TurnNotice } | null> = {};
vi.mock('@/stores/chat/error', () => ({
  MAIN_FORK_KEY: 'main',
  useChatErrorStore: Object.assign(
    (
      selector?: (s: {
        errorsByFork: Record<string, { id: string; notice: TurnNotice } | null>;
      }) => unknown
    ) => {
      const state = { errorsByFork: mockErrorsByFork };
      return selector ? selector(state) : state;
    },
    {
      getState: () => ({
        errorsByFork: mockErrorsByFork,
        setError: mockSetError,
        clearError: mockClearError,
        clearAll: mockClearAll,
      }),
    }
  ),
  createChatError: (params: { notice: TurnNotice; failedContent: string }) => ({
    id: 'error-id',
    notice: params.notice,
    failedUserMessage: { id: 'failed-id', content: params.failedContent },
  }),
}));

let mockWebSearchActive = false;
vi.mock('@/hooks/chat/use-web-search', () => ({
  useWebSearch: () => ({ active: mockWebSearchActive }),
}));

let mockReasoningEffective: string | undefined;
vi.mock('@/hooks/chat/use-reasoning-effort', () => ({
  useReasoningEffort: () => ({ effective: mockReasoningEffective }),
}));

vi.mock('@/hooks/billing/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

// The composer's gate. The hook consults it for the queued head's own text, so
// the stub is keyed on `value` — a test can make one message affordable and
// another not, which is what "per message" means.
interface GateStub {
  fundingSource: string;
  hasBlockingError: boolean;
  isOverCapacity: boolean;
  sendRefusal: string | undefined;
  payerSwitch: string | undefined;
}
const AFFORDABLE: GateStub = {
  fundingSource: 'personal_balance',
  hasBlockingError: false,
  isOverCapacity: false,
  sendRefusal: undefined,
  payerSwitch: undefined,
};
const mockPromptBudget = vi.fn((_input: { value: string }) => AFFORDABLE as unknown);
vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: (input: { value: string }) => mockPromptBudget(input),
}));

let mockPrivateKey: Uint8Array | null = new Uint8Array(32).fill(1);
let mockAuthUserId: string | undefined = 'user-1';
let mockCustomInstructions: string | null = null;
let mockInstructionsStatus: 'pending' | 'absent' | 'present' = 'absent';
// The `@/lib/auth/auth` mock factory takes the real module through
// `importOriginal`, and that module registers itself against the app's query
// client at import time; this suite replaces `@tanstack/react-query` wholesale,
// so that client cannot be constructed here.
vi.mock('@/providers/query-provider', () => ({
  queryClient: { clear: vi.fn(), fetchQuery: vi.fn() },
  registerSessionRevocationClearer: vi.fn(),
}));

// The predicate comes from the real module rather than a second copy here: a
// mock that re-implemented it would agree with production only until one of
// them changed.
vi.mock('@/lib/auth/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/auth')>();
  return {
    selectInstructionsReadUnresolved: actual.selectInstructionsReadUnresolved,
    useAuthStore: (selector: (s: unknown) => unknown) =>
      selector({
        privateKey: mockPrivateKey,
        user: mockAuthUserId ? { id: mockAuthUserId } : null,
        customInstructions: mockCustomInstructions,
        customInstructionsStatus: mockInstructionsStatus,
      }),
  };
});

// ---------------------------------------------------------------------------

function makeMessage(
  id: string,
  role: 'user' | 'assistant' = 'user',
  content = `c-${id}`
): Message {
  return {
    id,
    conversationId: 'conv-1',
    role,
    content,
    createdAt: isoAt(TEST_DAY_START),
    ...(role === 'assistant' ? { modelName: 'test-model' } : {}),
  };
}

interface StreamPlan {
  models: { modelId: string; assistantMessageId: string; errorCode?: string }[];
  token?: string;
  resolvedModelId?: string;
  restart?: boolean;
  modelError?: { modelId: string; assistantMessageId: string; code: string };
  media?: { mediaType: 'image' | 'audio' | 'video'; mimeType: string };
  mediaProgress?: number;
  reasoningEffort?: ResolvedReasoningEffort;
}

// Default: two tiles, the first sent under the Smart sentinel so `onModelResolved`
// exercises both the mutate branch (smart tile) and the early-return branch
// (non-smart tile). Fires every optional callback so the stream-callback closures
// are all driven.
let streamPlan: StreamPlan = {
  models: [
    { modelId: SMART_MODEL_ID, assistantMessageId: 'assistant-1' },
    { modelId: 'test-model', assistantMessageId: 'assistant-2' },
  ],
  token: 'tok',
  resolvedModelId: 'anthropic/claude',
  restart: true,
  media: { mediaType: 'image', mimeType: 'image/png' },
};

function fireStart(options: StreamOptions | undefined, plan: StreamPlan): void {
  options?.onStart?.({
    userMessageId: 'user-msg',
    models: plan.models.map((m) => ({
      modelId: m.modelId,
      assistantMessageId: m.assistantMessageId,
    })),
  });
}

function fireMiddle(options: StreamOptions | undefined, plan: StreamPlan, id: string): void {
  if (plan.token !== undefined) options?.onContent?.(plan.token, id);
  if (plan.restart) options?.onRestart?.([id]);
  if (plan.modelError) options?.onModelError?.(plan.modelError);
}

function fireLevel(options: StreamOptions | undefined, plan: StreamPlan, id: string): void {
  if (plan.reasoningEffort === undefined) return;
  options?.onReasoningEffort?.(plan.reasoningEffort, id);
}

function fireResolutions(options: StreamOptions | undefined, plan: StreamPlan, id: string): void {
  if (plan.resolvedModelId === undefined) return;
  // Smart tile → mutate; second tile → early return.
  options?.onModelResolved?.(id, plan.resolvedModelId);
  const second = plan.models[1];
  if (second) options?.onModelResolved?.(second.assistantMessageId, plan.resolvedModelId);
}

function fireMedia(options: StreamOptions | undefined, plan: StreamPlan, id: string): void {
  if (!plan.media) return;
  options?.onModelMediaStart?.({ assistantMessageId: id, ...plan.media });
  // An explicit progress plan models a mid-flight snapshot: the synthetic
  // percent arrives and the run errors before media-done's authoritative 100.
  if (plan.mediaProgress !== undefined) {
    options?.onModelMediaProgress?.({ assistantMessageId: id, percent: plan.mediaProgress });
    return;
  }
  options?.onModelMediaDone?.({ assistantMessageId: id });
}

function driveStream(options: StreamOptions | undefined, plan: StreamPlan): void {
  fireStart(options, plan);
  const first = plan.models[0];
  if (!first) return;
  const id = first.assistantMessageId;
  fireMiddle(options, plan, id);
  fireLevel(options, plan, id);
  fireResolutions(options, plan, id);
  fireMedia(options, plan, id);
  options?.onAllModelsComplete?.();
  options?.onAllStreamsSettled?.();
}

function streamResult(plan: StreamPlan): {
  userMessageId: string;
  models: { modelId: string; assistantMessageId: string; errorCode?: string }[];
  outcome: 'succeeded';
} {
  return {
    userMessageId: 'user-msg',
    models: plan.models.map((m) => ({
      modelId: m.modelId,
      assistantMessageId: m.assistantMessageId,
      ...(m.errorCode !== undefined && { errorCode: m.errorCode }),
    })),
    outcome: 'succeeded',
  };
}

function resetState(): void {
  mockIsMobile = false;
  mockInputValue = 'hello world';
  mockIsStreaming = false;
  mockPendingMessage = null;
  mockPendingFundingSource = null;
  mockConversationData = undefined;
  mockConversationLoading = false;
  mockConversationPaused = false;
  mockMessagesData = undefined;
  mockMessagesLoading = false;
  mockMessagesPaused = false;
  mockErrorsByFork = {};
  mockForksData = [];
  mockWebSearchActive = false;
  mockReasoningEffective = undefined;
  mockPrivateKey = new Uint8Array(32).fill(1);
  mockAuthUserId = 'user-1';
  mockCustomInstructions = null;
  mockInstructionsStatus = 'absent';
  modelState.activeModality = 'text';
  streamPlan = {
    models: [
      { modelId: SMART_MODEL_ID, assistantMessageId: 'assistant-1' },
      { modelId: 'test-model', assistantMessageId: 'assistant-2' },
    ],
    token: 'tok',
    resolvedModelId: 'anthropic/claude',
    restart: true,
    media: { mediaType: 'image', mimeType: 'image/png' },
  };
  mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
    driveStream(options, streamPlan);
    return Promise.resolve(streamResult(streamPlan));
  });
  mockStartRegenerateStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
    driveStream(options, streamPlan);
    return Promise.resolve(streamResult(streamPlan));
  });
  mockStopRun.mockResolvedValue(true);
  mockCreateConversationMutateAsync.mockResolvedValue({
    conversation: { id: 'real-conv' },
    created: true,
    forks: [],
  });
  mockFetchJson.mockResolvedValue({});
  mockPromptBudget.mockImplementation(() => AFFORDABLE as unknown);
  // The message queue is a real singleton store — reset it so a queue populated
  // by one test never leaks into the next.
  useMessageQueueStore.setState({ queuesByConversation: {} });
}

function render(
  input: {
    routeConversationId?: string;
    activeForkId?: string | null;
    privateKeyOverride?: Uint8Array | null;
  } = {}
): ReturnType<typeof renderHook<ReturnType<typeof useAuthenticatedChat>, unknown>> {
  const { routeConversationId = 'conv-1', activeForkId, privateKeyOverride } = input;
  return renderHook(() =>
    useAuthenticatedChat({ routeConversationId, activeForkId, privateKeyOverride })
  );
}

/** The notice the hook hands the error store for one rejected send. */
async function noticeFor(error: unknown): Promise<TurnNotice> {
  mockSetError.mockClear();
  mockStartStream.mockRejectedValue(error);
  const { result, unmount } = render();
  act(() => {
    result.current.handleSend('personal_balance');
  });
  await waitFor(() => {
    expect(mockSetError).toHaveBeenCalled();
  });
  const [, chatError] = mockSetError.mock.calls[0] as [string, { notice: TurnNotice }];
  unmount();
  return chatError.notice;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shouldStreamFirstTurn', () => {
  it('streams the first turn for a freshly created conversation', () => {
    expect(shouldStreamFirstTurn({ created: true })).toBe(true);
  });
  it('does not re-stream an idempotent existing conversation', () => {
    expect(shouldStreamFirstTurn({ created: false })).toBe(false);
  });
});

describe('resolveDrainDecision', () => {
  it('sends with the gate’s own funding source when nothing blocks', () => {
    expect(resolveDrainDecision(AFFORDABLE as never)).toEqual({
      kind: 'send',
      fundingSource: 'personal_balance',
    });
  });

  it('refuses when no wallet is willing to fund the message', () => {
    expect(resolveDrainDecision({ ...AFFORDABLE, fundingSource: 'denied' } as never)).toEqual({
      kind: 'refuse',
    });
  });

  it('refuses when the message overflows the model context', () => {
    expect(
      resolveDrainDecision({ ...AFFORDABLE, isOverCapacity: true, hasBlockingError: true } as never)
    ).toEqual({ kind: 'refuse' });
  });

  it('refuses on a named send refusal', () => {
    expect(
      resolveDrainDecision({
        ...AFFORDABLE,
        hasBlockingError: true,
        sendRefusal: 'prompt_too_long',
      } as never)
    ).toEqual({ kind: 'refuse' });
  });

  it('waits on a hold rather than refusing the message it names', () => {
    expect(
      resolveDrainDecision({
        ...AFFORDABLE,
        hasBlockingError: true,
        sendRefusal: 'funds_held_by_run',
      } as never)
    ).toEqual({ kind: 'wait' });
  });

  it('waits on an unreadable funding read rather than stranding the rest of the queue', () => {
    expect(
      resolveDrainDecision({
        ...AFFORDABLE,
        hasBlockingError: true,
        sendRefusal: 'send_check_unavailable',
      } as never)
    ).toEqual({ kind: 'wait' });
  });

  it('waits when no funding verdict exists rather than spending on the absence', () => {
    // Not a denial and not a source: nothing was read. Sending would hand the
    // API an absence where it expects a wallet, and refusing would latch the
    // drain over a condition that clears itself on the next refetch.
    expect(resolveDrainDecision({ ...AFFORDABLE, fundingSource: 'no_verdict' } as never)).toEqual({
      kind: 'wait',
    });
  });

  it('refuses an over-long prompt while no funding verdict exists', () => {
    // Length is the user's to fix: waiting on it cannot terminate, whatever the
    // funding read is doing.
    expect(
      resolveDrainDecision({
        ...AFFORDABLE,
        fundingSource: 'no_verdict',
        isOverCapacity: true,
      } as never)
    ).toEqual({ kind: 'refuse' });
  });

  it('waits while the gate blocks without naming a cause', () => {
    expect(resolveDrainDecision({ ...AFFORDABLE, hasBlockingError: true } as never)).toEqual({
      kind: 'wait',
    });
  });

  it('hands back a message the owner was funding when the sender now pays for it', () => {
    // The charge has moved to the sender's own wallet since the message was
    // accepted, and nothing has told them. Sending here would be the charge
    // arriving before the sentence describing it.
    expect(
      resolveDrainDecision({ ...AFFORDABLE, payerSwitch: 'group_headroom_insufficient' } as never, {
        payerSwitch: undefined,
      })
    ).toEqual({ kind: 'disclose' });
  });

  it('hands back a message queued before there was a queue entry to read', () => {
    // No recorded sentence is the same standing as a sentence that said someone
    // else pays: nothing told this user the charge is theirs.
    expect(
      resolveDrainDecision({
        ...AFFORDABLE,
        payerSwitch: 'group_headroom_insufficient',
      } as never)
    ).toEqual({ kind: 'disclose' });
  });

  it('sends a message already accepted on the sender’s own wallet', () => {
    // Same payer as when it was queued, and it was stated then; repeating the
    // sentence buys the user nothing and costs them the queue.
    expect(
      resolveDrainDecision({ ...AFFORDABLE, payerSwitch: 'group_headroom_insufficient' } as never, {
        payerSwitch: 'group_headroom_insufficient',
      })
    ).toEqual({ kind: 'send', fundingSource: 'personal_balance' });
  });

  it('sends a message the owner still funds', () => {
    expect(resolveDrainDecision({ ...AFFORDABLE } as never, { payerSwitch: undefined })).toEqual({
      kind: 'send',
      fundingSource: 'personal_balance',
    });
  });
});

describe('useAuthenticatedChat — surface', () => {
  it('exposes the result contract for an existing conversation', () => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1', callerPrivilege: 'owner' };
    mockMessagesData = [makeMessage('u1')];
    const { result } = render();
    expect(result.current.realConversationId).toBe('conv-1');
    expect(result.current.callerId).toBe('owner-1');
    expect(result.current.callerPrivilege).toBe('owner');
    expect(result.current.renderState.type).toBe('ready');
    expect(result.current.messagesReady).toBe(true);
    expect(result.current.inputDisabled).toBe(false);
    expectExposes(result.current, 'handleSend');
  });

  it('falls back to the auth user id when the conversation omits callerId', () => {
    mockConversationData = { id: 'conv-1' };
    const { result } = render();
    expect(result.current.callerId).toBe('user-1');
  });

  it('sums history characters across the merged message list', () => {
    mockConversationData = { id: 'conv-1' };
    mockMessagesData = [makeMessage('u1', 'user', 'abc'), makeMessage('a1', 'assistant', 'de')];
    const { result } = render();
    expect(result.current.historyCharacters).toBe(5);
  });

  it('counts an assistant turn by its answer alone, never its embedded reasoning', () => {
    mockConversationData = { id: 'conv-1' };
    mockMessagesData = [
      makeMessage('u1', 'user', 'abc'),
      makeMessage(
        'a1',
        'assistant',
        serializeSegments([
          { kind: 'reasoning', children: [{ kind: 'text', text: 'chain of thought' }] },
          { kind: 'text', text: 'de' },
        ])
      ),
    ];
    const { result } = render();
    expect(result.current.historyCharacters).toBe(5);
  });

  it('leaves a stored turn notice out of the history count', () => {
    mockConversationData = { id: 'conv-1' };
    mockMessagesData = [makeMessage('u1', 'user', 'abc'), makeMessage('a1', 'assistant', 'de')];
    const withoutNotice = render().result.current.historyCharacters;
    mockErrorsByFork = { main: { id: 'err-1', notice: turnNoticeForCode('INTERNAL') } };
    const withNotice = render().result.current.historyCharacters;
    expect(withNotice).toBe(withoutNotice);
  });

  it('still counts an answered assistant reply beside a stored turn notice', () => {
    mockConversationData = { id: 'conv-1' };
    mockMessagesData = [makeMessage('u1', 'user', 'abc'), makeMessage('a1', 'assistant', 'de')];
    mockErrorsByFork = { main: { id: 'err-1', notice: turnNoticeForCode('INTERNAL') } };
    const { result } = render();
    expect(result.current.historyCharacters).toBe(5);
  });

  it('counts the history the next send carries after a failed turn', async () => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1', callerPrivilege: 'owner' };
    mockMessagesData = [makeMessage('u1', 'user', 'abc'), makeMessage('a1', 'assistant', 'de')];
    mockErrorsByFork = { main: { id: 'err-1', notice: turnNoticeForCode('INTERNAL') } };
    const { result } = render();
    const counted = result.current.historyCharacters;
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [
      { messagesForInference: { role: 'user' | 'assistant'; content: string }[] },
    ];
    const sentHistory = request.messagesForInference.slice(0, -1);
    expect(counted).toBe(historyCharacterCount(stripReplayHistory(sentHistory)));
  });

  it('marks input disabled for a read-only caller', () => {
    mockConversationData = { id: 'conv-1', callerPrivilege: 'read' };
    const { result } = render();
    expect(result.current.inputDisabled).toBe(true);
  });

  it('surfaces the active fork error slot as errorMessageId', () => {
    mockErrorsByFork = { 'fork-9': { id: 'err-42', notice: turnNoticeForCode('INTERNAL') } };
    mockConversationData = { id: 'conv-1' };
    const { result } = render({ activeForkId: 'fork-9' });
    expect(result.current.errorMessageId).toBe('err-42');
  });

  it('clears all fork errors on unmount', () => {
    mockConversationData = { id: 'conv-1' };
    const { unmount } = render();
    unmount();
    expect(mockClearAll).toHaveBeenCalled();
  });
});

describe('useAuthenticatedChat — handleSend', () => {
  beforeEach(() => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1', callerPrivilege: 'owner' };
    mockMessagesData = [makeMessage('u0'), makeMessage('a0', 'assistant')];
  });

  it('is a no-op when the input is blank', async () => {
    mockInputValue = '   ';
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it('streams a turn, driving every optimistic callback and settling', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request, options] = mockStartStream.mock.calls[0] as [
      {
        conversationId: string;
        models: string[];
        fundingSource: string;
        messagesForInference: unknown[];
      },
      StreamOptions,
    ];
    expect(request.conversationId).toBe('conv-1');
    expect(request.models).toEqual(['test-model']);
    expect(request.fundingSource).toBe('personal_balance');
    expectExposes(options, 'onStart');
    expect(mockClearInput).toHaveBeenCalled();
    expect(mockStartStreaming).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
    expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
    expect(mockStopPersisting).toHaveBeenCalledWith(['assistant-1', 'assistant-2']);
    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalled();
    });
  });

  it('sends the turn with no user message id', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ userMessage: unknown }];
    expect(request.userMessage).toEqual({ content: 'hello world' });
  });

  /**
   * A send whose stream holds until the returned `release` runs, so a test can
   * read the optimistic rows before and after `start` arrives.
   */
  function heldSend(): {
    readonly options: () => StreamOptions | undefined;
    readonly release: () => void;
  } {
    let captured: StreamOptions | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStartStream.mockImplementation(async (_req: unknown, options?: StreamOptions) => {
      captured = options;
      await gate;
      return streamResult(streamPlan);
    });
    return { options: () => captured, release };
  }

  function sentUserRows(messages: readonly Message[]): Message[] {
    return messages.filter((m) => m.role === 'user' && m.content === 'hello world');
  }

  it('adopts the run-start user message id for the optimistic row, once, when start arrives', async () => {
    const held = heldSend();
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const beforeStart = sentUserRows(result.current.messages);
    expect(beforeStart).toHaveLength(1);
    expect(beforeStart[0]?.id).not.toBe('server-user-msg');

    act(() => {
      held.options()?.onStart?.({
        userMessageId: 'server-user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
    });

    expect(sentUserRows(result.current.messages).map((m) => m.id)).toEqual(['server-user-msg']);
    const tile = result.current.messages.find((m) => m.id === 'assistant-1');
    expect(tile?.parentMessageId).toBe('server-user-msg');
    await act(async () => {
      held.release();
      await Promise.resolve();
    });
  });

  it('drops the adopted optimistic row once the run settles', async () => {
    const held = heldSend();
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    act(() => {
      held.options()?.onStart?.({
        userMessageId: 'server-user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
    });
    await act(async () => {
      held.release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(sentUserRows(result.current.messages)).toEqual([]);
    });
  });

  /** Starts a held send under `server-user-msg`, then re-keys it to `server-user-msg-2`. */
  async function sendRekeyedOnce(): Promise<{
    readonly messages: () => Message[];
    readonly release: () => Promise<void>;
  }> {
    const held = heldSend();
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const models = [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }];
    act(() => {
      held.options()?.onStart?.({ userMessageId: 'server-user-msg', models });
    });
    act(() => {
      held.options()?.onRekey?.({
        userMessageId: 'server-user-msg-2',
        models,
        previousModels: models,
      });
    });
    return {
      messages: () => result.current.messages,
      release: async () => {
        await act(async () => {
          held.release();
          await Promise.resolve();
        });
      },
    };
  }

  it("moves the optimistic row onto a same-key re-execution's new user message id", async () => {
    const send = await sendRekeyedOnce();

    expect(sentUserRows(send.messages()).map((m) => m.id)).toEqual(['server-user-msg-2']);
    await send.release();
  });

  it("re-parents the turn's tiles to a same-key re-execution's new user message id", async () => {
    const send = await sendRekeyedOnce();

    const tiles = send.messages().filter((m) => m.id === 'assistant-1');
    expect(tiles.map((m) => m.parentMessageId)).toEqual(['server-user-msg-2']);
    await send.release();
  });

  it("moves the turn's tile onto the fresh answer id a same-key re-execution names", async () => {
    const held = heldSend();
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const previousModels = [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }];
    act(() => {
      held.options()?.onStart?.({ userMessageId: 'server-user-msg', models: previousModels });
    });
    act(() => {
      held.options()?.onRekey?.({
        userMessageId: 'server-user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2' }],
        previousModels,
      });
    });

    const tiles = result.current.messages.filter((m) => m.role === 'assistant' && m.content === '');
    expect(tiles.map((m) => m.id)).toEqual(['assistant-2']);
    expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1']);
    expect(mockStopPersisting).toHaveBeenCalledWith(['assistant-1']);
    expect(mockStartStreaming).toHaveBeenLastCalledWith(['assistant-2']);
    await act(async () => {
      held.release();
      await Promise.resolve();
    });
  });

  it('drops the re-keyed tile, not the replaced one, when the turn then fails', async () => {
    let captured: StreamOptions | undefined;
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      captured = options;
      const previousModels = [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }];
      options?.onStart?.({ userMessageId: 'server-user-msg', models: previousModels });
      options?.onRekey?.({
        userMessageId: 'server-user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2' }],
        previousModels,
      });
      return Promise.reject(new Error('boom'));
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(captured).toBeDefined();
    });
    await waitFor(() => {
      expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-2']);
    });
    expect(result.current.messages.some((m) => m.id === 'assistant-2')).toBe(false);
  });

  it('keeps the optimistic row on its local key when the run start names no id', async () => {
    const held = heldSend();
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const localKey = sentUserRows(result.current.messages)[0]?.id;

    act(() => {
      held.options()?.onStart?.({
        userMessageId: null,
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
    });

    expect(sentUserRows(result.current.messages).map((m) => m.id)).toEqual([localKey]);
    await act(async () => {
      held.release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(sentUserRows(result.current.messages)).toEqual([]);
    });
  });

  it('includes web-search, custom instructions, and forkId in the request', async () => {
    mockWebSearchActive = true;
    mockCustomInstructions = 'be terse';
    const { result } = render({ activeForkId: 'fork-1' });
    await act(async () => {
      result.current.handleSend('owner_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [
      { webSearchEnabled?: boolean; customInstructions?: string; forkId?: string },
    ];
    expect(request.webSearchEnabled).toBe(true);
    expect(request.customInstructions).toBe('be terse');
    expect(request.forkId).toBe('fork-1');
  });

  it('includes the effective reasoningEffort in the request when one is engaged', async () => {
    mockReasoningEffective = 'medium';
    const { result } = render();
    await act(async () => {
      result.current.handleSend('owner_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ reasoningEffort?: string }];
    expect(request.reasoningEffort).toBe('medium');
  });

  it('omits reasoningEffort from the request when nothing is engaged', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleSend('owner_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [Record<string, unknown>];
    expect(request).not.toHaveProperty('reasoningEffort');
  });

  it('writes streamed content with its reasoning onto the streaming tile', async () => {
    // Never settles: the tile must stay optimistic so its live content is
    // observable after the streamed content lands.
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      options?.onContent?.(
        serializeSegments([
          { kind: 'reasoning', children: [{ kind: 'text', text: 'thinking hard' }] },
          { kind: 'text', text: 'the answer' },
        ]),
        'assistant-1'
      );
      return new Promise(() => {});
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(parseAssistantMessage(tile?.content ?? '')).toEqual([
        { kind: 'reasoning', children: [{ kind: 'text', text: 'thinking hard' }] },
        { kind: 'text', text: 'the answer' },
      ]);
    });
  });

  it('stamps the live reasoning token count onto the streaming tile', async () => {
    // Never settles: the tile must stay optimistic so the live count landed
    // by the finish frame is observable before the persisted refetch.
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      options?.onContent?.('the answer', 'assistant-1');
      options?.onReasoningTokens?.(1204, 'assistant-1');
      return new Promise(() => {});
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.reasoningTokens).toBe(1204);
    });
  });

  it('stamps the live resolved reasoning level onto the streaming tile', async () => {
    // Never settles: the tile must stay optimistic so the level landed by the
    // finish frame is observable without the reload the history read needs.
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      options?.onContent?.('the answer', 'assistant-1');
      options?.onReasoningEffort?.('high', 'assistant-1');
      return new Promise(() => {});
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.reasoningEffort).toBe('high');
    });
  });

  it('stamps a live off level rather than collapsing it into no level', async () => {
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      options?.onContent?.('the answer', 'assistant-1');
      options?.onReasoningEffort?.('off', 'assistant-1');
      return new Promise(() => {});
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.reasoningEffort).toBe('off');
    });
  });

  it('leaves the streaming tile levelless when no level is streamed', async () => {
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      options?.onContent?.('the answer', 'assistant-1');
      return new Promise(() => {});
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.content).toBe('the answer');
    });
    const tile = result.current.messages.find((m) => m.id === 'assistant-1');
    expect(tile?.reasoningEffort).toBeUndefined();
  });

  it('stamps the media backdrop for an image turn', async () => {
    modelState.activeModality = 'image';
    streamPlan.models = [{ modelId: 'img-model', assistantMessageId: 'assistant-1' }];
    streamPlan.media = { mediaType: 'image', mimeType: 'image/png' };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ imageConfig?: unknown }];
    expect(request.imageConfig).toEqual({ aspectRatio: '4:3' });
  });

  it('applies media-progress percents to the streaming tile', async () => {
    modelState.activeModality = 'video';
    streamPlan = {
      models: [{ modelId: 'video-model', assistantMessageId: 'assistant-1', errorCode: 'X' }],
      modelError: { modelId: 'video-model', assistantMessageId: 'assistant-1', code: 'X' },
      media: { mediaType: 'video', mimeType: 'video/*' },
      mediaProgress: 40,
    };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    // The errored tile survives settlement, still carrying the last live
    // percent the progress frames applied.
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.mediaProgress).toEqual({ percent: 40 });
    });
  });

  it('keeps errored optimistic tiles and drops successful ones', async () => {
    streamPlan = {
      models: [
        { modelId: 'test-model', assistantMessageId: 'assistant-1' },
        { modelId: 'other-model', assistantMessageId: 'assistant-2', errorCode: 'MODEL_ERROR' },
      ],
      modelError: {
        modelId: 'other-model',
        assistantMessageId: 'assistant-2',
        code: 'MODEL_ERROR',
      },
    };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    // Errored tile survives in the rendered list; successful one was removed.
    await waitFor(() => {
      expect(result.current.messages.some((m) => m.id === 'assistant-2')).toBe(true);
    });
  });

  it('builds inference history from lingering optimistic tiles on a follow-up send', async () => {
    // First send leaves an errored optimistic assistant tile in place.
    streamPlan = {
      models: [
        { modelId: 'test-model', assistantMessageId: 'assistant-err', errorCode: 'MODEL_ERROR' },
      ],
      modelError: {
        modelId: 'test-model',
        assistantMessageId: 'assistant-err',
        code: 'MODEL_ERROR',
      },
    };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(result.current.messages.some((m) => m.id === 'assistant-err')).toBe(true);
    });
    // Second send now composes messagesForInference over the optimistic tile.
    streamPlan = { models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2' }] };
    mockStartStream.mockClear();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ messagesForInference: unknown[] }];
    expect(request.messagesForInference.length).toBeGreaterThan(mockMessagesData!.length + 1);
  });

  it('handles an INSUFFICIENT_ADMISSION refusal: invalidates balance and stores its notice', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'u',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      return Promise.reject(new ChatRequestError('INSUFFICIENT_ADMISSION'));
    });
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: turnNoticeForCode('INSUFFICIENT_ADMISSION') })
      );
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
    expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1']);
  });

  it.each(['DAILY_ALLOWANCE_EXHAUSTED', 'GROUP_ALLOCATION_EXHAUSTED'] as const)(
    'invalidates the balance on a %s refusal, which used to ride the admission code',
    async (code) => {
      // Nothing type-checks membership of the codes that trigger this, so a
      // refusal that moved out of INSUFFICIENT_ADMISSION stops refreshing the
      // served numbers the composer prices against unless the check widens with
      // it.
      const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
      mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          userMessageId: 'u',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
        });
        return Promise.reject(new ChatRequestError(code));
      });
      const { result } = render();
      await act(async () => {
        result.current.handleSend('personal_balance');
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
      });
    }
  );

  // One pin over the population rather than one test per code: per-code examples
  // each pass on their own while one arm wording a code differently goes
  // unnoticed. The rows are the codes with a traced producer on the chat path —
  // the run-start refusals, the engine's run-failure projection, and the
  // node-failure reasons that projection carries — and are not a completeness
  // claim about the wire set.
  const ARM_CODES: readonly string[] = [
    'CONCURRENT_RUN',
    'RUN_CAPACITY_REACHED',
    'INSUFFICIENT_ADMISSION',
    'GROUP_ALLOCATION_EXHAUSTED',
    'ADMISSION_UNAVAILABLE',
    'RATE_LIMITED',
    'IDEMPOTENCY_BODY_MISMATCH',
    'UNAVAILABLE',
    'RATE_LIMIT_UNAVAILABLE',
    'INTERNAL',
    'NETWORK_ERROR',
    'MODEL_OUTPUT_INVALID',
    'WORKFLOW_DEFINITION_INVALID',
    'CHAT_STREAM_FAILED',
    'DAILY_ALLOWANCE_EXHAUSTED',
    'TRIAL_CAPACITY_REACHED',
    'VALIDATION',
    'NOT_FOUND',
    'CONTENT_POLICY',
    'CONTEXT_LENGTH_EXCEEDED',
    'NO_REASONING_ENDPOINTS',
    'UNSUPPORTED_DURATION',
  ];

  it('stores the notice its own code words for every code both error arms deliver', async () => {
    const { ChatRequestError, ChatRunFailedError } = await import('@/hooks/chat/use-chat-stream');
    const observed: Record<string, { refusal: TurnNotice; failure: TurnNotice }> = {};
    for (const code of ARM_CODES) {
      observed[code] = {
        refusal: await noticeFor(new ChatRequestError(code)),
        failure: await noticeFor(new ChatRunFailedError(code)),
      };
    }
    expect(observed).toEqual(
      Object.fromEntries(
        ARM_CODES.map((code) => [
          code,
          { refusal: turnNoticeForCode(code), failure: turnNoticeForCode(code) },
        ])
      )
    );
  });

  it('reports a generic (non-Error-class) failure as an internal one and refocuses', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStartStream.mockRejectedValue(new Error('boom'));
    const focus = vi.fn();
    const { result } = render();
    result.current.promptInputRef.current = { focus } as never;
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: turnNoticeForCode('INTERNAL') })
      );
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('claims nothing about billing when the run outcome never reached the client', async () => {
    // The client's own deadline fires when no terminal frame arrived, and the run
    // may have settled server-side — a deadline stop bills its partial. Asserting
    // "you were not billed" here would be a false statement about money.
    const { ChatRunFailedError } = await import('@/hooks/chat/use-chat-stream');
    mockStartStream.mockRejectedValue(new ChatRunFailedError('CHAT_STREAM_FAILED'));
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalled();
    });
    const [, error] = mockSetError.mock.calls.at(-1) as [string, { notice: TurnNotice }];
    expect(turnNoticeText(error.notice).toLowerCase()).not.toContain('billed');
  });

  it('does not refocus the composer on mobile after sending', async () => {
    mockIsMobile = true;
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(mockClearInput).toHaveBeenCalled();
  });

  it('skips startStreaming when a turn produces no assistant tiles', async () => {
    streamPlan = { models: [] };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(mockStartStreaming).not.toHaveBeenCalled();
  });

  it('resolves a null parent when the conversation has no prior messages', async () => {
    mockMessagesData = [];
    mockForksData = undefined;
    streamPlan = { models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }] };
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
  });

  it('advances the pre-inference stage counter exactly once when the Smart tile resolves', async () => {
    // Default plan: one Smart-sentinel tile + one plain tile, and the harness
    // fires onModelResolved for BOTH — only the Smart tile may count.
    const baseline = usePreInferenceActivityStore.getState().preInferenceStagesSeen;
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(usePreInferenceActivityStore.getState().preInferenceStagesSeen).toBe(baseline + 1);
  });

  it('does not advance the pre-inference stage counter for a plain-model turn', async () => {
    streamPlan = {
      models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      resolvedModelId: 'test-model',
    };
    const baseline = usePreInferenceActivityStore.getState().preInferenceStagesSeen;
    const { result } = render();
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(usePreInferenceActivityStore.getState().preInferenceStagesSeen).toBe(baseline);
  });
});

describe('useAuthenticatedChat — the stored row replacing a live tile', () => {
  const answerId = 'server-assistant';
  const userId = 'server-user';
  const storedTurn: Message[] = [
    { ...makeMessage(userId), content: 'hello world' },
    { ...makeMessage(answerId, 'assistant', 'the answer'), parentMessageId: userId },
  ];
  let latest: ReturnType<typeof useAuthenticatedChat> | undefined;

  /** One element per message, keyed by message id as the message list keys its rows. */
  function Rows(): React.ReactElement {
    latest = useAuthenticatedChat({ routeConversationId: 'conv-1' });
    return createElement(
      'div',
      null,
      latest.messages.map((m) => createElement('div', { key: m.id, 'data-message-id': m.id }))
    );
  }

  function rowOf(container: HTMLElement, id: string): Element | null {
    return container.querySelector(`[data-message-id="${id}"]`);
  }

  beforeEach(() => {
    latest = undefined;
    mockConversationData = { id: 'conv-1', callerId: 'owner-1', callerPrivilege: 'owner' };
    mockMessagesData = [];
  });

  it('keeps the assistant row element when the stored row arrives', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const models = [{ modelId: 'test-model', assistantMessageId: answerId }];
    mockStartStream.mockImplementation(async (_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({ userMessageId: userId, models });
      options?.onContent?.('the answer', answerId);
      await gate;
      return { userMessageId: userId, models, outcome: 'succeeded' };
    });
    // The refetch has landed in the query cache by the time its invalidation
    // resolves; the render that shows it comes after.
    mockInvalidateQueries.mockImplementation(() => {
      mockGetQueryData.mockReturnValue(storedTurn);
      return Promise.resolve();
    });
    const view = renderElement(createElement(Rows));
    await act(async () => {
      latest?.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(rowOf(view.container, answerId)).not.toBeNull();
    });
    const live = rowOf(view.container, answerId);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
    });
    await act(async () => {
      await Promise.resolve();
    });
    mockMessagesData = storedTurn;
    view.rerender(createElement(Rows));

    expect(rowOf(view.container, answerId)).toBe(live);
  });
});

describe('useAuthenticatedChat — handleSendUserOnly', () => {
  beforeEach(() => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1' };
    mockMessagesData = [makeMessage('u0')];
  });

  it('posts the user message without streaming and invalidates the conversation', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalled();
    });
    expect(mockMessagePost).toHaveBeenCalledWith(
      { param: { conversationId: 'conv-1' }, json: { content: 'hello world' } },
      { headers: { 'Idempotency-Key': expect.stringMatching(/^[\da-f-]{36}$/) as unknown } }
    );
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['conversation', 'conv-1'] });
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it('includes the active forkId so the message stays on the viewed branch', async () => {
    const { result } = render({ activeForkId: 'fork-3' });
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockMessagePost).toHaveBeenCalled();
    });
    const [request] = mockMessagePost.mock.calls[0] as [
      { json: { forkId?: string; content: string } },
    ];
    expect(request.json.forkId).toBe('fork-3');
  });

  it('omits forkId for a linear (Main) send', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockMessagePost).toHaveBeenCalled();
    });
    const [request] = mockMessagePost.mock.calls[0] as [{ json: Record<string, unknown> }];
    expect(request.json).not.toHaveProperty('forkId');
  });

  it('is a no-op on blank input', async () => {
    mockInputValue = '';
    const { result } = render();
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('resolves a null parent for a user-only send with no prior messages', async () => {
    mockMessagesData = [];
    const { result } = render();
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalled();
    });
  });

  it('refocuses and logs when the user-only post fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockFetchJson.mockRejectedValue(new Error('nope'));
    const focus = vi.fn();
    const { result } = render();
    result.current.promptInputRef.current = { focus } as never;
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith('User-only message failed:', expect.anything());
    });
    consoleSpy.mockRestore();
  });
});

describe('useAuthenticatedChat — handleRegenerate', () => {
  beforeEach(() => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1' };
    // user u1 → assistant a1 (target the user message for retry/edit)
    mockMessagesData = [
      makeMessage('u1', 'user', 'question'),
      makeMessage('a1', 'assistant', 'answer'),
    ];
    streamPlan = {
      models: [{ modelId: 'test-model', assistantMessageId: 'regen-1' }],
      token: 'tk',
    };
  });

  it('bails when there is no real conversation id', () => {
    mockConversationData = undefined;
    const { result } = render({ routeConversationId: 'new' });
    act(() => {
      result.current.handleRegenerate('u1', 'retry');
    });
    expect(mockStartRegenerateStream).not.toHaveBeenCalled();
  });

  it('bails while the account instruction read is unresolved', () => {
    // Regenerate reaches the turn builder without passing the composer's send
    // control, so the hold has to be stated here too.
    mockInstructionsStatus = 'pending';
    const { result } = render();
    act(() => {
      result.current.handleRegenerate('u1', 'retry');
    });
    expect(mockStartRegenerateStream).not.toHaveBeenCalled();
  });

  it('bails when the anchor content is unavailable', () => {
    mockMessagesData = [makeMessage('u1', 'user', '')];
    const { result } = render();
    act(() => {
      result.current.handleRegenerate('u1', 'retry');
    });
    expect(mockStartRegenerateStream).not.toHaveBeenCalled();
  });

  it('carries the effective reasoningEffort on the regenerate request', async () => {
    mockReasoningEffective = 'medium';
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [{ reasoningEffort?: string }];
    expect(request.reasoningEffort).toBe('medium');
  });

  it('omits reasoningEffort from the regenerate request when nothing is engaged', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [{ reasoningEffort?: string }];
    expect(request).not.toHaveProperty('reasoningEffort');
  });

  it('runs a retry regeneration end-to-end', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [
      { conversationId: string; action: string; targetMessageId: string },
    ];
    expect(request.conversationId).toBe('conv-1');
    expect(request.action).toBe('retry');
    expect(request.targetMessageId).toBe('u1');
    expect(mockClearError).toHaveBeenCalledWith('main');
    expect(mockStopStreaming).toHaveBeenCalledWith(['regen-1']);
  });

  it('adds an edited user optimistic message for an edit regeneration', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'edit', 'edited text');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [{ userMessage: unknown }];
    expect(request.userMessage).toEqual({ content: 'edited text' });
  });

  it("adopts the run-start id for an edit's optimistic replacement, then drops it at settle", async () => {
    let captured: StreamOptions | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStartRegenerateStream.mockImplementation(async (_req: unknown, options?: StreamOptions) => {
      captured = options;
      await gate;
      return streamResult(streamPlan);
    });
    const editedRows = (messages: readonly Message[]): Message[] =>
      messages.filter((m) => m.role === 'user' && m.content === 'edited text');
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'edit', 'edited text');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    expect(editedRows(result.current.messages)).toHaveLength(1);

    act(() => {
      captured?.onStart?.({
        userMessageId: 'server-edit-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'regen-1' }],
      });
    });
    expect(editedRows(result.current.messages).map((m) => m.id)).toEqual(['server-edit-msg']);

    await act(async () => {
      release();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(editedRows(result.current.messages)).toEqual([]);
    });
  });

  it("moves an edit's replacement row and its tiles onto a re-execution's new user message id", async () => {
    let captured: StreamOptions | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStartRegenerateStream.mockImplementation(async (_req: unknown, options?: StreamOptions) => {
      captured = options;
      await gate;
      return streamResult(streamPlan);
    });
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'edit', 'edited text');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const models = [{ modelId: 'test-model', assistantMessageId: 'regen-1' }];
    act(() => {
      captured?.onStart?.({ userMessageId: 'server-edit-msg', models });
    });
    act(() => {
      captured?.onRekey?.({ userMessageId: 'server-edit-msg-2', models, previousModels: models });
    });

    const edited = result.current.messages.filter(
      (m) => m.role === 'user' && m.content === 'edited text'
    );
    expect(edited.map((m) => m.id)).toEqual(['server-edit-msg-2']);
    const tiles = result.current.messages.filter((m) => m.id === 'regen-1');
    expect(tiles.map((m) => m.parentMessageId)).toEqual(['server-edit-msg-2']);
    await act(async () => {
      release();
      await Promise.resolve();
    });
  });

  it('scopes regeneration to a single tile when replaceAssistantId is given', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry', undefined, 'a1');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [{ replaceAssistantId?: string }];
    expect(request.replaceAssistantId).toBe('a1');
  });

  it('handles a regeneration admission refusal with billing invalidation and error', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    mockStartRegenerateStream.mockRejectedValue(new ChatRequestError('INSUFFICIENT_ADMISSION'));
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: turnNoticeForCode('INSUFFICIENT_ADMISSION') })
      );
    });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({ queryKey: ['balance'] });
  });

  it('removes placeholder tiles when a regeneration throws after onStart', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStartRegenerateStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'u',
        models: [{ modelId: 'test-model', assistantMessageId: 'regen-ph' }],
      });
      return Promise.reject(new Error('after start'));
    });
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStopStreaming).toHaveBeenCalledWith(['regen-ph']);
    });
    consoleSpy.mockRestore();
  });

  it('cleans up the edited optimistic message when an edit regeneration fails', async () => {
    mockStartRegenerateStream.mockRejectedValue(new Error('regen boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'edit', 'edited');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalled();
    });
    consoleSpy.mockRestore();
  });

  it('edits a non-first message, resolving the preceding message as parent', async () => {
    // Target the assistant at index 1 so `targetIndex > 0` and the previous
    // message becomes the optimistic edit's parent.
    mockMessagesData = [makeMessage('u1', 'user', 'q'), makeMessage('a1', 'assistant', 'a')];
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('a1', 'edit', 'edited text');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
  });

  it('handles a retry on the last message (nothing to prune)', async () => {
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('a1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
  });

  it('threads fork, web-search, and custom instructions into the regenerate request', async () => {
    mockWebSearchActive = true;
    mockCustomInstructions = 'concise';
    const { result } = render({ activeForkId: 'fork-7' });
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartRegenerateStream).toHaveBeenCalled();
    });
    const [request] = mockStartRegenerateStream.mock.calls[0] as [
      { forkId?: string; webSearchEnabled?: boolean; customInstructions?: string },
    ];
    expect(request.forkId).toBe('fork-7');
    expect(request.webSearchEnabled).toBe(true);
    expect(request.customInstructions).toBe('concise');
  });
});

describe('useAuthenticatedChat — an account instruction read that has not landed', () => {
  it('starts no turn while the read is unresolved', async () => {
    mockInstructionsStatus = 'pending';
    const { result } = render();

    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });

    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it('keeps the typed message in the composer while the read is unresolved', async () => {
    mockInstructionsStatus = 'pending';
    const { result } = render();

    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });

    expect(mockClearInput).not.toHaveBeenCalled();
  });

  it('sends the turn once the read lands on an account that stores none', async () => {
    const { result } = render();

    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ customInstructions?: string }];
    expect(request.customInstructions).toBeUndefined();
  });

  it('holds nothing for a sender with no account, whose read was never issued', async () => {
    // The share route mounts this hook for a link guest. No instruction read is
    // ever issued for them, so the store's initial `pending` says nothing about
    // them and must not stop their turn.
    mockAuthUserId = undefined;
    mockInstructionsStatus = 'pending';
    const { result } = render();

    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
  });
});

describe('useAuthenticatedChat — handleStop', () => {
  it('posts a stop for the active conversation', async () => {
    mockConversationData = { id: 'conv-1' };
    const { result } = render();
    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStopRun).toHaveBeenCalledWith('conv-1');
    });
  });

  it('surfaces a refused stop to the user with the wire code sentence', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    mockStopRun.mockRejectedValue(new ChatRequestError('FORBIDDEN'));
    mockConversationData = { id: 'conv-1' };
    const { result } = render();
    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(friendlyErrorMessage('FORBIDDEN'));
    });
  });

  it('surfaces a rate-limited stop with its wait', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    mockStopRun.mockRejectedValue(new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 3 }));
    mockConversationData = { id: 'conv-1' };
    const { result } = render();
    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Too many attempts. Try again in 3 seconds.');
    });
  });

  it('surfaces an unrecognized stop failure with the generic sentence', async () => {
    mockStopRun.mockRejectedValue(new Error('network down'));
    mockConversationData = { id: 'conv-1' };
    const { result } = render();
    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(friendlyErrorMessage('INTERNAL'));
    });
  });

  it('is a no-op with no real conversation', async () => {
    mockPendingMessage = null;
    mockPrivateKey = null;
    const { result } = render({ routeConversationId: 'new' });
    await act(async () => {
      result.current.handleStop();
      await Promise.resolve();
    });
    expect(mockStopRun).not.toHaveBeenCalled();
  });
});

describe('useAuthenticatedChat — render-state effects', () => {
  it('holds the page loading while its conversation read is paused with no data', () => {
    // A read TanStack cannot start while offline is paused, and `isLoading` is
    // false for it: the page must wait for the connection, not call it missing.
    mockConversationPaused = true;
    const { result } = render();
    expect(result.current.renderState.type).toBe('loading');
  });

  it('holds the page loading while its messages read is paused with no data', () => {
    mockConversationData = { id: 'conv-1' };
    mockMessagesPaused = true;
    const { result } = render();
    expect(result.current.renderState.type).toBe('loading');
  });

  it('navigates to the chat list when the create route has nothing to show', async () => {
    mockPendingMessage = null;
    const { result } = render({ routeConversationId: 'new' });
    expect(result.current.renderState.type).toBe('redirecting');
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
  });
});

describe('useAuthenticatedChat — create flow', () => {
  beforeEach(() => {
    mockPendingMessage = 'Hello AI';
    mockPendingFundingSource = 'personal_balance';
    // Create flow streams via hand-written callbacks; drive the create tile.
    streamPlan = {
      models: [{ modelId: SMART_MODEL_ID, assistantMessageId: 'assistant-1' }],
      token: 'hi',
      resolvedModelId: 'anthropic/claude',
      restart: true,
      media: { mediaType: 'image', mimeType: 'image/png' },
    };
    modelState.activeModality = 'image';
  });

  it('does not create when the account private key is missing', () => {
    mockPrivateKey = null;
    render({ routeConversationId: 'new' });
    expect(mockCreateConversationMutateAsync).not.toHaveBeenCalled();
  });

  it('waits while the account instruction read is unresolved, then creates once it lands', async () => {
    mockInstructionsStatus = 'pending';
    const { rerender } = render({ routeConversationId: 'new' });
    expect(mockCreateConversationMutateAsync).not.toHaveBeenCalled();

    mockInstructionsStatus = 'present';
    mockCustomInstructions = 'be terse';
    rerender();

    await waitFor(() => {
      expect(mockCreateConversationMutateAsync).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ customInstructions?: string }];
    expect(request.customInstructions).toBe('be terse');
  });

  it("carries the effective reasoningEffort on the first turn's request", async () => {
    mockReasoningEffective = 'medium';
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ reasoningEffort?: string }];
    expect(request.reasoningEffort).toBe('medium');
  });

  it('creates the conversation, streams the first turn, and navigates', async () => {
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockCreateConversationMutateAsync).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({ to: '/chat/$id', params: { id: 'real-conv' } })
      );
    });
    expect(mockClearPendingMessage).toHaveBeenCalled();
    await waitFor(() => {
      expect(result.current.realConversationId).toBe('real-conv');
    });
    expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1']);
    expect(mockStopPersisting).toHaveBeenCalledWith(['assistant-1']);
  });

  it('streams the first turn with no user message id', async () => {
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ userMessage: unknown }];
    expect(request.userMessage).toEqual({ content: 'Hello AI' });
  });

  it("adopts the run-start id for the first turn's local user row when start arrives", async () => {
    let captured: StreamOptions | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStartStream.mockImplementation(async (_req: unknown, options?: StreamOptions) => {
      captured = options;
      await gate;
      return streamResult(streamPlan);
    });
    const firstTurnRows = (messages: readonly Message[]): Message[] =>
      messages.filter((m) => m.role === 'user' && m.content === 'Hello AI');
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const localKey = firstTurnRows(result.current.messages)[0]?.id;
    expect(localKey).toBeDefined();
    expect(localKey).not.toBe('server-first-msg');

    act(() => {
      captured?.onStart?.({
        userMessageId: 'server-first-msg',
        models: [{ modelId: SMART_MODEL_ID, assistantMessageId: 'assistant-1' }],
      });
    });

    expect(firstTurnRows(result.current.messages).map((m) => m.id)).toEqual(['server-first-msg']);
    await act(async () => {
      release();
      await Promise.resolve();
    });
  });

  /**
   * Starts the first turn under `server-first-msg` and re-keys it to
   * `server-first-msg-2`, as a same-key re-execution does, with `plan`'s models.
   */
  async function firstTurnRekeyedOnce(
    plan: StreamPlan
  ): Promise<{ readonly messages: () => Message[]; readonly release: () => Promise<void> }> {
    streamPlan = plan;
    let captured: StreamOptions | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStartStream.mockImplementation(async (_req: unknown, options?: StreamOptions) => {
      captured = options;
      await gate;
      return { ...streamResult(plan), userMessageId: 'server-first-msg-2' };
    });
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const models = plan.models.map((m) => ({
      modelId: m.modelId,
      assistantMessageId: m.assistantMessageId,
    }));
    act(() => {
      captured?.onStart?.({ userMessageId: 'server-first-msg', models });
    });
    act(() => {
      captured?.onRekey?.({ userMessageId: 'server-first-msg-2', models, previousModels: models });
    });
    return {
      messages: () => result.current.messages,
      release: async () => {
        await act(async () => {
          release();
          await Promise.resolve();
        });
      },
    };
  }

  it("moves the first turn's user row and its tiles onto a re-execution's new user message id", async () => {
    const turn = await firstTurnRekeyedOnce({
      models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
    });

    const userRows = turn.messages().filter((m) => m.role === 'user' && m.content === 'Hello AI');
    expect(userRows.map((m) => m.id)).toEqual(['server-first-msg-2']);
    const tiles = turn.messages().filter((m) => m.id === 'assistant-1');
    expect(tiles.map((m) => m.parentMessageId)).toEqual(['server-first-msg-2']);
    await turn.release();
  });

  it("moves the first turn's tile onto the fresh answer id a re-execution names", async () => {
    let captured: StreamOptions | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fresh = [{ modelId: 'test-model', assistantMessageId: 'assistant-2' }];
    mockStartStream.mockImplementation(async (_req: unknown, options?: StreamOptions) => {
      captured = options;
      await gate;
      return { userMessageId: 'server-first-msg', models: fresh, outcome: 'succeeded' };
    });
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const previousModels = [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }];
    act(() => {
      captured?.onStart?.({ userMessageId: 'server-first-msg', models: previousModels });
    });
    act(() => {
      captured?.onRekey?.({ userMessageId: 'server-first-msg', models: fresh, previousModels });
    });

    const tiles = result.current.messages.filter((m) => m.role === 'assistant');
    expect(tiles.map((m) => [m.id, m.parentMessageId])).toEqual([
      ['assistant-2', 'server-first-msg'],
    ]);
    expect(mockStopStreaming).toHaveBeenCalledWith(['assistant-1']);
    await act(async () => {
      release();
      await Promise.resolve();
    });
  });

  it("parents the first turn's error tile to a re-execution's new user message id", async () => {
    const turn = await firstTurnRekeyedOnce({
      models: [
        { modelId: 'test-model', assistantMessageId: 'assistant-1', errorCode: 'MODEL_ERROR' },
      ],
    });
    await turn.release();

    await waitFor(() => {
      const errorTiles = turn
        .messages()
        .filter((m) => m.id === 'assistant-1' && m.errorCode === 'MODEL_ERROR');
      expect(errorTiles.map((m) => m.parentMessageId)).toEqual(['server-first-msg-2']);
    });
  });

  it("keeps the first turn's local user row on its local key when the start names no id", async () => {
    let captured: StreamOptions | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockStartStream.mockImplementation(async (_req: unknown, options?: StreamOptions) => {
      captured = options;
      await gate;
      return streamResult(streamPlan);
    });
    const firstTurnRows = (messages: readonly Message[]): Message[] =>
      messages.filter((m) => m.role === 'user' && m.content === 'Hello AI');
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const localKey = firstTurnRows(result.current.messages)[0]?.id;

    act(() => {
      captured?.onStart?.({
        userMessageId: null,
        models: [{ modelId: SMART_MODEL_ID, assistantMessageId: 'assistant-1' }],
      });
    });

    expect(firstTurnRows(result.current.messages).map((m) => m.id)).toEqual([localKey]);
    await act(async () => {
      release();
      await Promise.resolve();
    });
  });

  it('binds the created title to the conversation it sends, at the epoch it mints', async () => {
    const crypto = await import('@hushbox/crypto');
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(crypto.encryptTextForEpoch).toHaveBeenCalled();
    });

    const [createRequest] = mockCreateConversationMutateAsync.mock.calls[0] as [{ id: string }];
    const encryptCall = (crypto.encryptTextForEpoch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      string,
      { conversationId: string; epochNumber: number },
    ];
    const location = encryptCall[2];

    expect(location).toEqual({ conversationId: createRequest.id, epochNumber: 1 });
    // The epoch the title claims is the epoch the client actually minted.
    expect(crypto.createFirstEpoch).toHaveBeenCalledWith(
      [expect.any(Uint8Array)],
      createRequest.id,
      location.epochNumber
    );
  });

  it('badges the create-flow first turn with its resolved level, live', async () => {
    streamPlan.reasoningEffort = 'high';
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.reasoningEffort).toBe('high');
    });
  });

  it('advances the pre-inference stage counter when the create-flow Smart tile resolves', async () => {
    const baseline = usePreInferenceActivityStore.getState().preInferenceStagesSeen;
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(usePreInferenceActivityStore.getState().preInferenceStagesSeen).toBe(baseline + 1);
    });
  });

  it('seeds the cache without streaming for an idempotent existing conversation', async () => {
    mockCreateConversationMutateAsync.mockResolvedValue({
      conversation: { id: 'real-conv' },
      created: false,
      forks: [],
    });
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockClearPendingMessage).toHaveBeenCalled();
    });
    expect(mockStartStream).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/chat/$id', params: { id: 'real-conv' } })
    );
  });

  it('navigates back to chat when creation throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockCreateConversationMutateAsync.mockRejectedValue(new Error('create failed'));
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
    consoleSpy.mockRestore();
  });

  it('preserves errored models and reports the failure on a create-flow stream error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockStartStream.mockRejectedValue(new Error('stream failed'));
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: turnNoticeForCode('INTERNAL') })
      );
    });
    consoleSpy.mockRestore();
  });

  it('writes streamed content with its reasoning onto the create-flow tile', async () => {
    modelState.activeModality = 'text';
    // Never settles: the first-turn tile must stay in local message state so
    // its live content is observable after the streamed content lands.
    mockStartStream.mockImplementation((_req: unknown, options?: StreamOptions) => {
      options?.onStart?.({
        userMessageId: 'user-msg',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      });
      options?.onContent?.(
        serializeSegments([
          { kind: 'reasoning', children: [{ kind: 'text', text: 'first thought' }] },
          { kind: 'text', text: 'first answer' },
        ]),
        'assistant-1'
      );
      return new Promise(() => {});
    });
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(parseAssistantMessage(tile?.content ?? '')).toEqual([
        { kind: 'reasoning', children: [{ kind: 'text', text: 'first thought' }] },
        { kind: 'text', text: 'first answer' },
      ]);
    });
  });

  it('keeps an errored create-flow model as an optimistic tile', async () => {
    streamPlan = {
      models: [
        { modelId: 'test-model', assistantMessageId: 'assistant-1', errorCode: 'MODEL_ERROR' },
      ],
      modelError: { modelId: 'test-model', assistantMessageId: 'assistant-1', code: 'MODEL_ERROR' },
    };
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(
        result.current.messages.some((m) => m.id === 'assistant-1' && m.errorCode === 'MODEL_ERROR')
      ).toBe(true);
    });
  });

  it('applies media-progress percents to the create-flow tile', async () => {
    modelState.activeModality = 'video';
    streamPlan = {
      models: [{ modelId: 'video-model', assistantMessageId: 'assistant-1' }],
      media: { mediaType: 'video', mimeType: 'video/*' },
      mediaProgress: 40,
    };
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.mediaProgress).toEqual({ percent: 40 });
    });
  });

  it('flips the create-flow tile to 100% on media-done', async () => {
    modelState.activeModality = 'video';
    streamPlan = {
      models: [{ modelId: 'video-model', assistantMessageId: 'assistant-1' }],
      media: { mediaType: 'video', mimeType: 'video/*' },
    };
    const { result } = render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    await waitFor(() => {
      const tile = result.current.messages.find((m) => m.id === 'assistant-1');
      expect(tile?.mediaProgress).toEqual({ percent: 100 });
    });
  });

  it('streams a text create turn with a non-smart tile and custom instructions', async () => {
    modelState.activeModality = 'text';
    mockCustomInstructions = 'stay factual';
    streamPlan = {
      models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
      token: 'hi',
      resolvedModelId: 'anthropic/claude',
      restart: true,
    };
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const [request] = mockStartStream.mock.calls[0] as [{ customInstructions?: string }];
    expect(request.customInstructions).toBe('stay factual');
  });

  it('defaults the funding source to personal_balance when none is pending', async () => {
    mockPendingFundingSource = null;
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
  });

  it('aborts the create flow when the epoch yields no member wrap', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const crypto = await import('@hushbox/crypto');
    (crypto.createFirstEpoch as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      epochPublicKey: new Uint8Array(32).fill(10),
      epochPrivateKey: new Uint8Array(32).fill(11),
      confirmationHash: new Uint8Array(32).fill(12),
      memberWraps: [],
    });
    render({ routeConversationId: 'new' });
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });
    expect(mockStartStream).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe('useAuthenticatedChat — message queue', () => {
  beforeEach(() => {
    mockConversationData = { id: 'conv-1', callerId: 'owner-1', callerPrivilege: 'owner' };
    mockMessagesData = [makeMessage('u0'), makeMessage('a0', 'assistant')];
    streamPlan = { models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }] };
  });

  function sentContents(): string[] {
    return mockStartStream.mock.calls.map(
      (call) => (call as [{ userMessage: { content: string } }])[0].userMessage.content
    );
  }

  it('enqueues a message for the active conversation via onQueueMessage', () => {
    mockIsStreaming = true;
    const { result } = render();
    act(() => {
      result.current.onQueueMessage('queued text');
    });
    expect(result.current.queueCount).toBe(1);
    expect(result.current.queuedMessages[0]?.text).toBe('queued text');
  });

  it('reports the queue as full at capacity', () => {
    mockIsStreaming = true;
    const { result } = render();
    act(() => {
      for (let index = 0; index < 5; index += 1) result.current.onQueueMessage(`m${String(index)}`);
    });
    expect(result.current.queueCount).toBe(5);
    expect(result.current.queueFull).toBe(true);
    // The store rejects a sixth; the count holds at the cap.
    act(() => {
      result.current.onQueueMessage('overflow');
    });
    expect(result.current.queueCount).toBe(5);
  });

  it('treats queue actions as no-ops when there is no active conversation', () => {
    mockPendingMessage = null;
    const { result } = render({ routeConversationId: 'new' });
    act(() => {
      result.current.onQueueMessage('x');
      result.current.onCancelQueued('y');
    });
    expect(result.current.queueCount).toBe(0);
    expect(result.current.queueFull).toBe(false);
    expect(result.current.queuedMessages).toEqual([]);
  });

  it('cancelling a queued message removes it so it never sends', () => {
    mockIsStreaming = true;
    useMessageQueueStore.getState().enqueue('conv-1', 'to cancel');
    const { result } = render();
    expect(result.current.queueCount).toBe(1);
    const id = result.current.queuedMessages[0]?.id ?? '';
    act(() => {
      result.current.onCancelQueued(id);
    });
    expect(result.current.queueCount).toBe(0);
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it('drains a non-empty queue on mount when the conversation is idle', async () => {
    useMessageQueueStore.getState().enqueue('conv-1', 'resume me');
    render();
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(sentContents()).toContain('resume me');
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
  });

  it('does not drain while a run is streaming', async () => {
    mockIsStreaming = true;
    useMessageQueueStore.getState().enqueue('conv-1', 'held');
    render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockStartStream).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(1);
  });

  it('drains queued messages FIFO, one at a time, oldest first', async () => {
    useMessageQueueStore.getState().enqueue('conv-1', 'first');
    useMessageQueueStore.getState().enqueue('conv-1', 'second');
    render();
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledTimes(2);
    });
    expect(sentContents()).toEqual(['first', 'second']);
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
  });

  it('sends each drained message with post-settle history, not the loop-start snapshot', async () => {
    useMessageQueueStore.getState().enqueue('conv-1', 'first');
    useMessageQueueStore.getState().enqueue('conv-1', 'second');
    // Simulate the post-settle refetch: once the first drained turn settles, its
    // user message and assistant answer become persisted history before the
    // second message drains. A stale-closure loop would miss this.
    mockStartStream.mockImplementation(
      (request: { userMessage: { content: string } }, options?: StreamOptions) => {
        if (request.userMessage.content === 'first') {
          mockMessagesData = [
            ...(mockMessagesData ?? []),
            makeMessage('first-user', 'user', 'first'),
            makeMessage('first-answer', 'assistant', 'answer-to-first'),
          ];
        }
        driveStream(options, streamPlan);
        return Promise.resolve(streamResult(streamPlan));
      }
    );
    render();
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledTimes(2);
    });
    const secondCall = mockStartStream.mock.calls[1] as [
      {
        messagesForInference: { role: string; content: string }[];
        userMessage: { content: string };
      },
    ];
    expect(secondCall[0].userMessage.content).toBe('second');
    const historyContents = secondCall[0].messagesForInference.map((m) => m.content);
    // The second drained send reflects post-settle state: it includes the first
    // drained user turn AND its assistant answer, not the loop-start snapshot.
    expect(historyContents).toContain('first');
    expect(historyContents).toContain('answer-to-first');
  });

  it('drains the queue after a user send fully settles', async () => {
    const { result } = render();
    act(() => {
      useMessageQueueStore.getState().enqueue('conv-1', 'after settle');
    });
    await act(async () => {
      result.current.handleSend('personal_balance');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalledTimes(2);
    });
    // First send is the user's own input; the drained message follows it.
    expect(sentContents()).toEqual(['hello world', 'after settle']);
  });

  it('pauses draining and restores the text when a drained send fails', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    mockStartStream.mockImplementation(() => Promise.reject(new ChatRequestError('BUDGET')));
    useMessageQueueStore.getState().enqueue('conv-1', 'fails');
    useMessageQueueStore.getState().enqueue('conv-1', 'preserved');
    render();
    await waitFor(() => {
      expect(mockSetInputValue).toHaveBeenCalledWith('fails');
    });
    // The failed send did not cascade to the next queued message.
    expect(mockStartStream).toHaveBeenCalledTimes(1);
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(1);
    expect(useMessageQueueStore.getState().queued('conv-1')[0]?.text).toBe('preserved');
  });

  it('ignores a settle event while a drained send is already in flight', async () => {
    useMessageQueueStore.getState().enqueue('conv-1', 'only');
    let resolveStream: ((value: unknown) => void) | undefined;
    mockStartStream.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStream = resolve;
        })
    );

    mockIsStreaming = true;
    const { rerender } = render();
    // Terminal settle: the first drain starts and parks on the pending stream.
    mockIsStreaming = false;
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    expect(mockStartStream).toHaveBeenCalledTimes(1);

    // A second settle event arrives while the drain is still in flight.
    mockIsStreaming = true;
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    mockIsStreaming = false;
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    // The in-flight guard blocked a second send (no double-send).
    expect(mockStartStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveStream?.({
        userMessageId: 'u',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
        outcome: 'succeeded',
      });
      await Promise.resolve();
    });
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
  });

  it('sends a drained message with the funding source resolved for that message', async () => {
    // `owner_balance` is the group-funded payer, and it is what distinguishes a
    // resolved source from the deleted default: the stub answers it for the
    // QUEUED text only, so a drain that assumed a source would send the other one.
    mockPromptBudget.mockImplementation((input: { value: string }) =>
      input.value === 'drain me'
        ? { ...AFFORDABLE, fundingSource: 'owner_balance' }
        : (AFFORDABLE as unknown)
    );
    useMessageQueueStore.getState().enqueue('conv-1', 'drain me');
    render();
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    const request = mockStartStream.mock.calls[0] as [{ fundingSource: string }];
    expect(request[0].fundingSource).toBe('owner_balance');
  });

  it('does not send a queued message whose payer moved to the sender after it was queued', async () => {
    // Queued while the owner's budget was paying, drained after the settling run
    // exhausted it. The charge is now the sender's, and nothing has said so.
    mockPromptBudget.mockImplementation(
      () => ({ ...AFFORDABLE, payerSwitch: 'group_headroom_insufficient' }) as unknown
    );
    useMessageQueueStore.getState().enqueue('conv-1', 'owner was paying');
    render();
    await waitFor(() => {
      expect(mockSetInputValue).toHaveBeenCalledWith('owner was paying');
    });
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it('sends a queued message whose payer is the one it was queued under', async () => {
    // The sender was already paying when they queued it and was told so; the
    // sentence has not changed, so the queue is not worth costing them.
    mockPromptBudget.mockImplementation(
      () => ({ ...AFFORDABLE, payerSwitch: 'group_headroom_insufficient' }) as unknown
    );
    useMessageQueueStore
      .getState()
      .enqueue('conv-1', 'my own balance', 'group_headroom_insufficient');
    render();
    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });
    expect(mockSetInputValue).not.toHaveBeenCalled();
  });

  it('records the payer sentence on screen when the composer queues a message', () => {
    mockPromptBudget.mockImplementation(
      () => ({ ...AFFORDABLE, payerSwitch: 'group_headroom_insufficient' }) as unknown
    );
    const { result } = render();
    act(() => {
      result.current.onQueueMessage('queued under my own balance');
    });
    expect(useMessageQueueStore.getState().queued('conv-1')[0]!.payerSwitch).toBe(
      'group_headroom_insufficient'
    );
  });

  it('does not send a queued message the gate now refuses', async () => {
    mockPromptBudget.mockImplementation(
      () =>
        ({ ...AFFORDABLE, hasBlockingError: true, sendRefusal: 'insufficient_funds' }) as unknown
    );
    useMessageQueueStore.getState().enqueue('conv-1', 'too expensive now');
    render();
    await waitFor(() => {
      expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
    });
    expect(mockStartStream).not.toHaveBeenCalled();
  });

  it('restores a refused queued message to the composer', async () => {
    mockPromptBudget.mockImplementation(
      () =>
        ({ ...AFFORDABLE, hasBlockingError: true, sendRefusal: 'insufficient_funds' }) as unknown
    );
    useMessageQueueStore.getState().enqueue('conv-1', 'too expensive now');
    render();
    await waitFor(() => {
      expect(mockSetInputValue).toHaveBeenCalledWith('too expensive now');
    });
  });

  it('leaves the messages behind a refused one queued', async () => {
    mockPromptBudget.mockImplementation(
      () =>
        ({ ...AFFORDABLE, hasBlockingError: true, sendRefusal: 'insufficient_funds' }) as unknown
    );
    useMessageQueueStore.getState().enqueue('conv-1', 'refused');
    useMessageQueueStore.getState().enqueue('conv-1', 'still queued');
    render();
    await waitFor(() => {
      expect(mockSetInputValue).toHaveBeenCalledWith('refused');
    });
    expect(
      useMessageQueueStore
        .getState()
        .queued('conv-1')
        .map((m) => m.text)
    ).toEqual(['still queued']);
  });

  it('waits rather than refusing while the funding read is still in flight', async () => {
    mockPromptBudget.mockImplementation(
      () => ({ ...AFFORDABLE, hasBlockingError: true }) as unknown
    );
    useMessageQueueStore.getState().enqueue('conv-1', 'not yet priced');
    render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockStartStream).not.toHaveBeenCalled();
    expect(mockSetInputValue).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(1);
  });

  it('does not refuse a queued message on a hold the finished run has already settled', async () => {
    mockPromptBudget.mockImplementation(
      () =>
        ({
          ...AFFORDABLE,
          hasBlockingError: true,
          sendRefusal: 'funds_held_by_run',
        }) as unknown
    );
    useMessageQueueStore.getState().enqueue('conv-1', 'held funds');
    render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockStartStream).not.toHaveBeenCalled();
    expect(mockSetInputValue).not.toHaveBeenCalled();
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(1);
  });

  it('drains the queue on the commit that carries the released funds', async () => {
    mockPromptBudget.mockImplementation(
      () =>
        ({
          ...AFFORDABLE,
          hasBlockingError: true,
          sendRefusal: 'funds_held_by_run',
        }) as unknown
    );
    useMessageQueueStore.getState().enqueue('conv-1', 'waits then sends');
    const { rerender } = render();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockStartStream).not.toHaveBeenCalled();

    // The hold releases: the next funding read carries the settled figure, and
    // the commit publishing it is what re-enters the paused drain.
    mockPromptBudget.mockImplementation(() => AFFORDABLE as unknown);
    await act(async () => {
      rerender();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(sentContents()).toContain('waits then sends');
    });
    expect(useMessageQueueStore.getState().count('conv-1')).toBe(0);
  });

  it('keeps queues isolated per conversation', () => {
    mockIsStreaming = true;
    useMessageQueueStore.getState().enqueue('conv-1', 'mine');
    useMessageQueueStore.getState().enqueue('other-conv', 'theirs');
    const { result } = render();
    expect(result.current.queueCount).toBe(1);
    expect(result.current.queuedMessages[0]?.text).toBe('mine');
  });
});

describe('useAuthenticatedChat — epoch keys', () => {
  const KEY_CHAIN: KeyChainResponse = {
    epochs: [],
    wraps: [],
    currentEpoch: 3,
    rotationPending: false,
  };

  /** Records a verdict in the real cache and lets its notification land inside act. */
  async function recordVerdict(input: {
    rotationPending: boolean;
    rotation: 'ok' | 'bad';
    lastGoodEpoch: number | null;
  }): Promise<void> {
    mockVerifyKeyChain.mockReturnValue({
      epochs: new Map(),
      rotation: input.rotation,
      lastGoodEpoch: input.lastGoodEpoch,
      keys: new Map(),
    });
    await act(async () => {
      processKeyChain(
        'conv-1',
        { ...KEY_CHAIN, rotationPending: input.rotationPending },
        new Uint8Array(32).fill(1)
      );
      await Promise.resolve();
    });
  }

  async function clearVerdicts(): Promise<void> {
    await act(async () => {
      clearEpochKeyCache();
      await Promise.resolve();
    });
  }

  beforeEach(async () => {
    await clearVerdicts();
    mockConversationData = { id: 'conv-1', callerId: 'owner-1', callerPrivilege: 'owner' };
    mockMessagesData = [makeMessage('u1', 'user', 'question'), makeMessage('a1', 'assistant')];
  });

  afterEach(async () => {
    await clearVerdicts();
  });

  it('exposes no verdict before the keychain is verified', () => {
    const { result } = render();
    expect(result.current.epochVerdict).toBeUndefined();
    expect(result.current.inputDisabled).toBe(false);
  });

  it('exposes the verdict of the verified keychain', async () => {
    await recordVerdict({ rotationPending: false, rotation: 'ok', lastGoodEpoch: 3 });
    const { result } = render();
    expect(result.current.epochVerdict).toEqual({
      currentEpoch: 3,
      rotationPending: false,
      rotation: 'ok',
      lastGoodEpoch: 3,
      badEpochs: new Set(),
    });
    expect(result.current.inputDisabled).toBe(false);
  });

  it('disables input while a rotation is pending', async () => {
    await recordVerdict({ rotationPending: true, rotation: 'ok', lastGoodEpoch: 3 });
    const { result } = render();
    expect(result.current.inputDisabled).toBe(true);
  });

  it('disables input while the rotation is bad', async () => {
    await recordVerdict({ rotationPending: false, rotation: 'bad', lastGoodEpoch: 2 });
    const { result } = render();
    expect(result.current.inputDisabled).toBe(true);
  });

  it('re-renders with the verdict once the keychain is verified', async () => {
    const { result } = render();
    await recordVerdict({ rotationPending: true, rotation: 'ok', lastGoodEpoch: 3 });
    await waitFor(() => {
      expect(result.current.epochVerdict?.rotationPending).toBe(true);
    });
  });

  it('hands a refused send to epoch maintenance', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    const refusal = new ChatRequestError('ROTATION_PENDING');
    mockStartStream.mockRejectedValue(refusal);
    const { result } = render();
    act(() => {
      result.current.handleSend('personal_balance');
    });
    await waitFor(() => {
      expect(mockRequestEpochMaintenanceOnRefusal).toHaveBeenCalledWith('conv-1', refusal);
    });
  });

  it('hands a refused user-only send to epoch maintenance', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refusal = new Error('refused');
    mockFetchJson.mockRejectedValue(refusal);
    const { result } = render();
    await act(async () => {
      result.current.handleSendUserOnly();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockRequestEpochMaintenanceOnRefusal).toHaveBeenCalledWith('conv-1', refusal);
    });
    consoleSpy.mockRestore();
  });

  it('hands a refused regeneration to epoch maintenance', async () => {
    const { ChatRequestError } = await import('@/hooks/chat/use-chat-stream');
    const refusal = new ChatRequestError('ROTATION_PENDING');
    mockStartRegenerateStream.mockRejectedValue(refusal);
    const { result } = render();
    await act(async () => {
      result.current.handleRegenerate('u1', 'retry');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(mockRequestEpochMaintenanceOnRefusal).toHaveBeenCalledWith('conv-1', refusal);
    });
  });
});
