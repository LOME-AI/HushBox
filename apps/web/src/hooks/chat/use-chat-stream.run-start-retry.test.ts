import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { SECOND_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  useChatStream,
  ChatRequestError,
  type AuthenticatedStreamRequest,
  type StreamResult,
  type TrialStreamRequest,
} from '@/hooks/chat/use-chat-stream';
import { resetRunOwnershipForTests } from '@/lib/chat/run-ownership';
import { useAppVersionStore } from '@/stores/app-version';
import type { RunFrame } from '@/lib/api/server-frames';

/**
 * The run-start POST under the real app-wide retry policy: the typed client,
 * its fetch wrapper and `@/lib/api/retry` all run for real, and only the
 * network (`fetch`), the conversation sockets and read-aloud are faked.
 */

interface FakeSocket {
  connect: () => void;
  waitForReady: (timeoutMs: number) => Promise<boolean>;
  readonly ready: boolean;
  onRunFrame: (listener: (frame: RunFrame) => void) => () => void;
  onStateChange: (listener: () => void) => () => void;
  emit: (frame: RunFrame) => void;
  /** Drops the connection and brings it back, as a reconnect does. */
  reconnect: () => void;
}

function createFakeSocket(): FakeSocket {
  const frameListeners = new Set<(frame: RunFrame) => void>();
  const stateListeners = new Set<() => void>();
  let ready = true;
  const setReady = (value: boolean): void => {
    ready = value;
    for (const listener of stateListeners) listener();
  };
  return {
    connect: vi.fn(),
    waitForReady: () => Promise.resolve(ready),
    get ready(): boolean {
      return ready;
    },
    onRunFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    emit(frame) {
      for (const listener of frameListeners) listener(frame);
    },
    reconnect() {
      setReady(false);
      setReady(true);
    },
  };
}

const sockets = vi.hoisted(() => ({
  conversation: null as unknown,
  trial: null as unknown,
}));

vi.mock('@/lib/api/conversation-socket-registry', () => ({
  acquireConversationSocket: (): unknown => sockets.conversation,
  releaseConversationSocket: (): void => {},
  acquireTrialSocket: (): unknown => sockets.trial,
  releaseTrialSocket: (): void => {},
}));

vi.mock('@/lib/tts/chat-tts-stream', () => ({
  startChatTtsStream: (): Promise<null> => Promise.resolve(null),
}));

/** Longer than every delay the policy can choose across three sends. */
const RETRIES_ELAPSED_MS = 20 * SECOND_MS;

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {}
): Response {
  return Response.json(body, { status, headers });
}

/** A run start naming the ids a paid run's body carries; the trial parse reads past them. */
const startedResponse = (): Response =>
  jsonResponse(
    {
      runId: 'run-1',
      deadlineAt: Date.now() + 300 * SECOND_MS,
      userMessageId: 'server-user-msg-1',
      assistantMessageIds: ['server-answer-1'],
    },
    201
  );

const unavailableResponse = (headers: Record<string, string> = {}): Response =>
  jsonResponse({ code: 'UNAVAILABLE' }, 503, headers);

function severedAfter(ms: number): Promise<never> {
  return new Promise((_resolve, reject) => {
    setTimeout(() => {
      reject(new TypeError('Failed to fetch'));
    }, ms);
  });
}

/** The Idempotency-Key the nth request carried on the wire. */
function keyOf(call: number): string | null {
  const init = fetchMock.mock.calls[call]?.[1];
  return new Headers(init?.headers).get('Idempotency-Key');
}

function baseRequest(): AuthenticatedStreamRequest {
  return {
    conversationId: 'conv-1',
    models: ['model-a'],
    userMessage: { content: 'hello' },
    messagesForInference: [{ role: 'user', content: 'hello' }],
    fundingSource: 'personal_balance',
  };
}

function trialRequest(): TrialStreamRequest {
  return { messages: [{ role: 'user', content: 'hello' }], model: 'model-a' };
}

/**
 * Detaches a promise so a rejection before the test's own await cannot
 * surface as an unhandled rejection (the test still awaits/asserts it).
 */
function armed(promise: Promise<unknown>): void {
  void (async (): Promise<void> => {
    try {
      await promise;
    } catch {
      // observed by the test's own await/assertion
    }
  })();
}

async function elapse(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function send(mode: 'authenticated' | 'trial'): Promise<StreamResult> {
  const { result } = renderHook(() => useChatStream(mode));
  let promise!: Promise<StreamResult>;
  act(() => {
    promise =
      mode === 'trial'
        ? result.current.startStream(trialRequest())
        : result.current.startStream(baseRequest());
    armed(promise);
  });
  return promise;
}

/** Ends the run, awaiting it inside `act` so the hook's closing state update is wrapped. */
async function settle(socket: FakeSocket, promise: Promise<StreamResult>): Promise<void> {
  await act(async () => {
    socket.emit({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'succeeded' },
    });
    await promise;
  });
}

describe('useChatStream run-start POST retry', () => {
  let conversationSocket: FakeSocket;
  let trialSocket: FakeSocket;

  beforeEach(() => {
    vi.useFakeTimers({ now: TEST_DAY_START });
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    resetRunOwnershipForTests();
    useAppVersionStore.setState({ upgradeRequired: false, currentVersion: null, updateUrl: null });
    localStorage.clear();
    conversationSocket = createFakeSocket();
    trialSocket = createFakeSocket();
    sockets.conversation = conversationSocket;
    sockets.trial = trialSocket;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('re-issues a send that drops 15 s after it began, under the same Idempotency-Key', async () => {
    fetchMock
      .mockImplementationOnce(() => severedAfter(15 * SECOND_MS))
      .mockResolvedValueOnce(startedResponse());

    const promise = send('authenticated');
    await elapse(15 * SECOND_MS + RETRIES_ELAPSED_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
    await settle(conversationSocket, promise);
  });

  it('stops after three sends when every send fails at once, surfacing the transport error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const promise = send('authenticated');
    await elapse(RETRIES_ELAPSED_MS);

    await expect(promise).rejects.toBeInstanceOf(TypeError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('re-sends a 503 UNAVAILABLE answer under the same Idempotency-Key', async () => {
    fetchMock.mockResolvedValueOnce(unavailableResponse()).mockResolvedValueOnce(startedResponse());

    const promise = send('authenticated');
    await elapse(RETRIES_ELAPSED_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
    await settle(conversationSocket, promise);
  });

  it('waits out the server-provided Retry-After before re-sending a 503', async () => {
    fetchMock
      .mockResolvedValueOnce(unavailableResponse({ 'Retry-After': '5' }))
      .mockResolvedValueOnce(startedResponse());

    const promise = send('authenticated');
    await elapse(5 * SECOND_MS - 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await elapse(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await settle(conversationSocket, promise);
  });

  it('surfaces a 503 that outlasts the policy as the refusal it carried', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(unavailableResponse()));

    const promise = send('authenticated');
    await elapse(RETRIES_ELAPSED_MS);

    await expect(promise).rejects.toMatchObject({
      name: 'ChatRequestError',
      code: 'UNAVAILABLE',
      status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not re-send a non-retryable status', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ code: 'CONCURRENT_RUN' }, 409))
    );

    const promise = send('authenticated');
    await elapse(RETRIES_ELAPSED_MS);

    await expect(promise).rejects.toBeInstanceOf(ChatRequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends a refused trial send exactly once', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ code: 'TRIAL_LIMIT_REACHED' }, 429))
    );

    const promise = send('trial');
    await elapse(RETRIES_ELAPSED_MS);

    await expect(promise).rejects.toMatchObject({ code: 'TRIAL_LIMIT_REACHED', status: 429 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('raises the upgrade-required flag when a send is answered 426', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'VERSION_MISMATCH', details: { currentVersion: 'srv-9' } }, 426)
    );

    const promise = send('authenticated');
    await elapse(RETRIES_ELAPSED_MS);

    await expect(promise).rejects.toMatchObject({ code: 'VERSION_MISMATCH', status: 426 });
    expect(useAppVersionStore.getState()).toMatchObject({
      upgradeRequired: true,
      currentVersion: 'srv-9',
    });
  });

  it('re-issues a trial send that drops 15 s after it began, under the same Idempotency-Key', async () => {
    fetchMock
      .mockImplementationOnce(() => severedAfter(15 * SECOND_MS))
      .mockResolvedValueOnce(startedResponse());

    const promise = send('trial');
    await elapse(15 * SECOND_MS + RETRIES_ELAPSED_MS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
    await settle(trialSocket, promise);
  });

  it('resubmits after a reconnect under the turn’s Idempotency-Key', async () => {
    const attached = (): Promise<Response> =>
      Promise.resolve(
        jsonResponse({ outcome: 'attach', userMessageId: null, assistantMessageIds: null }, 200)
      );
    fetchMock.mockImplementationOnce(attached).mockImplementationOnce(attached);

    const promise = send('authenticated');
    await elapse(0);
    act(() => {
      conversationSocket.reconnect();
    });
    await elapse(0);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(keyOf(1)).toBe(keyOf(0));
    await settle(conversationSocket, promise);
  });
});
