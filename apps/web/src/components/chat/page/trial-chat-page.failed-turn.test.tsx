import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { TEST_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import { ChatRunFailedError } from '@/hooks/chat/use-chat-stream';
import { resolveMessageActions } from '@/lib/chat/message-actions';
import { useChatEditStore } from '@/stores/chat/edit';
import { useChatErrorStore } from '@/stores/chat/error';
import { useTrialChatStore } from '@/stores/chat/trial-chat';
import { createModelStoreStub } from '@/test-utils/model-store-mock';
import { TrialChatPage } from '@/components/chat/page/trial-chat-page';
import type { FormFactor } from '@hushbox/ui/platform';
import type { Message } from '@/lib/api/api';
import type { MessageAction } from '@/lib/chat/message-actions';
import type { StreamOptions, StreamResult, TrialStreamRequest } from '@/hooks/chat/use-chat-stream';
import type { TrialMessage } from '@/stores/chat/trial-chat';
import type { ModelStoreStub } from '@/test-utils/model-store-mock';

vi.mock('@/lib/api/api', () => ({
  getApiUrl: (): string => 'http://localhost:8787',
}));

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to }: { to: string }): React.JSX.Element => (
    <div data-testid="navigate" data-to={to} />
  ),
}));

let shownMessages: Message[] = [];
let pressRegenerate: ((messageId: string) => void) | undefined;
let beginEdit: ((messageId: string, content: string) => void) | undefined;

vi.mock('@/components/chat/layout/chat-layout', () => ({
  ChatLayout: ({
    messages,
    onSubmit,
    inputValue,
    onInputChange,
    onRegenerate,
    onEdit,
  }: {
    messages: Message[];
    onSubmit: () => void;
    inputValue: string;
    onInputChange: (value: string) => void;
    onRegenerate?: (messageId: string) => void;
    onEdit?: (messageId: string, content: string) => void;
  }): React.JSX.Element => {
    shownMessages = messages;
    pressRegenerate = onRegenerate;
    beginEdit = onEdit;
    return (
      <div>
        <input
          data-testid="input"
          value={inputValue}
          onChange={(event) => {
            onInputChange(event.target.value);
          }}
        />
        <button data-testid="submit" onClick={onSubmit}>
          Submit
        </button>
      </div>
    );
  },
}));

vi.mock('@hushbox/ui/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/ui/platform')>()),
  useFormFactor: (): FormFactor => ({ band: 'desktop', pointer: 'fine' }),
}));

vi.mock('@/lib/auth/auth', () => ({
  useSession: (): { data: null; isPending: boolean } => ({ data: null, isPending: false }),
}));

let modelStore: ModelStoreStub = createModelStoreStub();
vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  return {
    ...actual,
    useModelStore: (selector?: (state: ModelStoreStub) => unknown): unknown =>
      selector ? selector(modelStore) : modelStore,
  };
});

const startStream =
  vi.fn<(request: TrialStreamRequest, options?: StreamOptions) => Promise<StreamResult>>();
vi.mock('@/hooks/chat/use-chat-stream', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/chat/use-chat-stream')>()),
  useChatStream: (): {
    isStreaming: boolean;
    startStream: (request: TrialStreamRequest, options?: StreamOptions) => Promise<StreamResult>;
  } => ({ isStreaming: false, startStream }),
}));

let effort: string | undefined;
vi.mock('@/hooks/chat/use-reasoning-effort', () => ({
  useReasoningEffort: (): { effective: string | undefined } => ({ effective: effort }),
}));

const SUCCEEDED: StreamResult = { userMessageId: null, models: [], outcome: 'succeeded' };

function row(id: string, role: TrialMessage['role'], content: string): TrialMessage {
  return { id, conversationId: 'trial', role, content, createdAt: isoAt(TEST_DAY_START) };
}

function selectModel(id: string): void {
  modelStore = createModelStoreStub({
    selections: { text: [{ id, name: id }], image: [], audio: [], video: [] },
  });
}

function failOnce(): void {
  startStream.mockRejectedValueOnce(new ChatRunFailedError('CHAT_STREAM_FAILED'));
}

/** Resolves after the stream announces one reply and writes its text. */
function answerWith(answerId: string, text: string): void {
  startStream.mockImplementationOnce((_request, options) => {
    options?.onStart?.({
      userMessageId: null,
      models: [{ modelId: 'test-model', assistantMessageId: answerId }],
    });
    options?.onContent?.(text, answerId);
    return Promise.resolve(SUCCEEDED);
  });
}

function shownThread(): { role: string; content: string }[] {
  return shownMessages.map((m) => ({
    role: m.turnNotice === undefined ? m.role : 'notice',
    content: m.turnNotice === undefined ? m.content : '',
  }));
}

function noticeId(): string {
  const notice = shownMessages.find((m) => m.turnNotice !== undefined);
  if (notice === undefined) throw new Error('no turn notice is shown');
  return notice.id;
}

async function waitForNotice(): Promise<void> {
  await waitFor(() => {
    expect(shownMessages.some((m) => m.turnNotice !== undefined)).toBe(true);
  });
}

/** The controls the thread offers on the shown row whose text is `content`. */
function actionsOn(content: string): MessageAction[] {
  const message = shownMessages.find((m) => m.turnNotice === undefined && m.content === content);
  if (message === undefined) throw new Error(`no row reads "${content}"`);
  return [
    ...resolveMessageActions(
      { mode: 'trial', privilege: undefined, currentUserId: undefined, isGroupChat: false },
      { message, isStreaming: false, isError: false, isMultiModel: false, canRegenerate: true }
    ),
  ];
}

function editAndFail(messageId: string, original: string, edited: string): void {
  act(() => {
    beginEdit?.(messageId, original);
  });
  submitText(edited);
}

function submitText(text: string): void {
  fireEvent.change(screen.getByTestId('input'), { target: { value: text } });
  fireEvent.click(screen.getByTestId('submit'));
}

function sentRequest(call: number): TrialStreamRequest | undefined {
  return startStream.mock.calls[call]?.[0];
}

describe('TrialChatPage, a failed turn', () => {
  beforeEach(() => {
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });
    startStream.mockReset();
    selectModel('test-model');
    effort = undefined;
    useTrialChatStore.getState().reset();
    useChatErrorStore.getState().clearAll();
    useChatEditStore.getState().clearEditing();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps the previous answer on screen when a regenerate fails', async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'What is X'), row('a1', 'assistant', 'X is a letter')]);
    failOnce();
    const { rerender } = render(<TrialChatPage />);

    act(() => {
      pressRegenerate?.('a1');
    });
    await waitForNotice();
    rerender(<TrialChatPage />);

    expect(shownThread()).toEqual([
      { role: 'user', content: 'What is X' },
      { role: 'assistant', content: 'X is a letter' },
      { role: 'notice', content: '' },
    ]);
  });

  it('shows the edited text in the question row once an edit is sent', async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'What is X'), row('a1', 'assistant', 'X is a letter')]);
    answerWith('a2', 'Y is a letter');
    render(<TrialChatPage />);

    act(() => {
      beginEdit?.('u1', 'What is X');
    });
    submitText('What is Y');

    await waitFor(() => {
      expect(shownThread()).toEqual([
        { role: 'user', content: 'What is Y' },
        { role: 'assistant', content: 'Y is a letter' },
      ]);
    });
  });

  it("re-runs a failed edit's own request: the edited text, the history before it, its model and effort", async () => {
    useTrialChatStore
      .getState()
      .setMessages([
        row('u1', 'user', 'Hello'),
        row('a1', 'assistant', 'Hi'),
        row('u2', 'user', 'What is X'),
        row('a2', 'assistant', 'X is a letter'),
      ]);
    effort = 'high';
    failOnce();
    answerWith('a3', 'Y is a letter');
    const { rerender } = render(<TrialChatPage />);

    act(() => {
      beginEdit?.('u2', 'What is X');
    });
    submitText('What is Y');
    await waitForNotice();
    selectModel('other-model');
    effort = 'low';
    rerender(<TrialChatPage />);

    act(() => {
      pressRegenerate?.(noticeId());
    });

    await waitFor(() => {
      expect(startStream).toHaveBeenCalledTimes(2);
    });
    expect(sentRequest(1)).toEqual({
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'What is Y' },
      ],
      model: 'test-model',
      reasoningEffort: 'high',
    });
  });

  it("re-runs a failed send's own request after the composer's model and effort change", async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'Hello'), row('a1', 'assistant', 'Hi')]);
    effort = 'medium';
    failOnce();
    answerWith('a2', 'Sure');
    const { rerender } = render(<TrialChatPage />);

    submitText('Follow up');
    await waitForNotice();
    selectModel('other-model');
    effort = 'low';
    rerender(<TrialChatPage />);

    act(() => {
      pressRegenerate?.(noticeId());
    });

    await waitFor(() => {
      expect(startStream).toHaveBeenCalledTimes(2);
    });
    expect(sentRequest(1)).toEqual(sentRequest(0));
  });

  it('keeps the failed question once above its notice, with no second copy after a retry', async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'Hello'), row('a1', 'assistant', 'Hi')]);
    failOnce();
    answerWith('a2', 'Sure');
    render(<TrialChatPage />);

    submitText('Follow up');
    await waitForNotice();
    act(() => {
      pressRegenerate?.(noticeId());
    });

    await waitFor(() => {
      expect(shownThread()).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'Follow up' },
        { role: 'assistant', content: 'Sure' },
      ]);
    });
  });

  it('keeps a failed first question on screen above its notice', async () => {
    useTrialChatStore.getState().setPendingMessage('Hello');
    failOnce();
    render(<TrialChatPage />);

    await waitForNotice();

    expect(shownThread()).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'notice', content: '' },
    ]);
  });

  it('keeps a failed later question on screen above its notice', async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'Hello'), row('a1', 'assistant', 'Hi')]);
    failOnce();
    render(<TrialChatPage />);

    submitText('Follow up');
    await waitForNotice();

    expect(shownThread()).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Follow up' },
      { role: 'notice', content: '' },
    ]);
  });

  it("re-runs a failed first turn's own request after the composer's model and effort change", async () => {
    useTrialChatStore.getState().setPendingMessage('Hello');
    effort = 'high';
    failOnce();
    answerWith('a1', 'Hi');
    const { rerender } = render(<TrialChatPage />);

    await waitForNotice();
    selectModel('other-model');
    effort = 'low';
    rerender(<TrialChatPage />);
    act(() => {
      pressRegenerate?.(noticeId());
    });

    await waitFor(() => {
      expect(startStream).toHaveBeenCalledTimes(2);
    });
    expect(sentRequest(1)).toEqual({
      messages: [{ role: 'user', content: 'Hello' }],
      model: 'test-model',
      reasoningEffort: 'high',
    });
  });

  it('cuts the previous answer again while a failed regenerate is retried', async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'What is X'), row('a1', 'assistant', 'X is a letter')]);
    failOnce();
    let rowsWhileRunning: TrialMessage[] = [];
    startStream.mockImplementationOnce(() => {
      rowsWhileRunning = useTrialChatStore.getState().messages;
      return Promise.resolve(SUCCEEDED);
    });
    render(<TrialChatPage />);

    act(() => {
      pressRegenerate?.('a1');
    });
    await waitForNotice();
    act(() => {
      pressRegenerate?.(noticeId());
    });

    await waitFor(() => {
      expect(startStream).toHaveBeenCalledTimes(2);
    });
    expect(rowsWhileRunning.map((m) => m.id)).toEqual(['u1']);
  });

  it('draws the notice after the turn it belongs to when an earlier turn fails to regenerate', async () => {
    useTrialChatStore
      .getState()
      .setMessages([
        row('u1', 'user', 'Hello'),
        row('a1', 'assistant', 'Hi'),
        row('u2', 'user', 'What is X'),
        row('a2', 'assistant', 'X is a letter'),
      ]);
    failOnce();
    render(<TrialChatPage />);

    act(() => {
      pressRegenerate?.('a1');
    });
    await waitForNotice();

    expect(shownThread()).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'notice', content: '' },
      { role: 'user', content: 'What is X' },
      { role: 'assistant', content: 'X is a letter' },
    ]);
  });

  it('clears the notice when its Regenerate is pressed', async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'Hello'), row('a1', 'assistant', 'Hi')]);
    failOnce();
    startStream.mockImplementationOnce(() => new Promise<StreamResult>(() => {}));
    render(<TrialChatPage />);

    submitText('Follow up');
    await waitForNotice();
    act(() => {
      pressRegenerate?.(noticeId());
    });

    await waitFor(() => {
      expect(shownMessages.some((m) => m.turnNotice !== undefined)).toBe(false);
    });
  });

  it("draws a failed edit's text above its notice, after the turn it edited", async () => {
    useTrialChatStore
      .getState()
      .setMessages([
        row('u1', 'user', 'Hello'),
        row('a1', 'assistant', 'Hi'),
        row('u2', 'user', 'What is X'),
        row('a2', 'assistant', 'X is a letter'),
      ]);
    failOnce();
    render(<TrialChatPage />);

    editAndFail('u1', 'Hello', 'Hello there');
    await waitForNotice();

    expect(shownThread()).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Hello there' },
      { role: 'notice', content: '' },
      { role: 'user', content: 'What is X' },
      { role: 'assistant', content: 'X is a letter' },
    ]);
  });

  it("offers Copy alone on a failed edit's drawn text", async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'What is X'), row('a1', 'assistant', 'X is a letter')]);
    failOnce();
    render(<TrialChatPage />);

    editAndFail('u1', 'What is X', 'What is Y');
    await waitForNotice();

    expect(actionsOn('What is Y')).toEqual(['copy']);
  });

  it('keeps the stored question its ordinary controls beside the drawn edit', async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'What is X'), row('a1', 'assistant', 'X is a letter')]);
    failOnce();
    render(<TrialChatPage />);

    editAndFail('u1', 'What is X', 'What is Y');
    await waitForNotice();

    expect(actionsOn('What is X')).toEqual(['copy', 'retry', 'edit']);
  });

  it("draws a failed edit's text once when its retry fails too", async () => {
    useTrialChatStore
      .getState()
      .setMessages([row('u1', 'user', 'What is X'), row('a1', 'assistant', 'X is a letter')]);
    failOnce();
    failOnce();
    render(<TrialChatPage />);

    editAndFail('u1', 'What is X', 'What is Y');
    await waitForNotice();
    act(() => {
      pressRegenerate?.(noticeId());
    });
    await waitFor(() => {
      expect(startStream).toHaveBeenCalledTimes(2);
    });
    await waitForNotice();

    expect(shownThread()).toEqual([
      { role: 'user', content: 'What is X' },
      { role: 'assistant', content: 'X is a letter' },
      { role: 'user', content: 'What is Y' },
      { role: 'notice', content: '' },
    ]);
  });
});
