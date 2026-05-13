import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSSELine, createSSEParser, type SSEHandlers } from './sse-client';

describe('parseSSELine', () => {
  it('parses event lines', () => {
    const result = parseSSELine('event: token');
    expect(result).toEqual({ type: 'event', value: 'token' });
  });

  it('parses data lines', () => {
    const result = parseSSELine('data: {"content":"hello"}');
    expect(result).toEqual({ type: 'data', value: '{"content":"hello"}' });
  });

  it('returns null for empty lines', () => {
    expect(parseSSELine('')).toBeNull();
    expect(parseSSELine('   ')).toBeNull();
  });

  it('returns null for comment lines', () => {
    expect(parseSSELine(': keep-alive')).toBeNull();
  });

  it('returns null for unknown line types', () => {
    expect(parseSSELine('unknown: value')).toBeNull();
  });
});

describe('createSSEParser', () => {
  const createMockHandlers = (): {
    handlers: SSEHandlers;
    mocks: {
      onStart: ReturnType<typeof vi.fn>;
      onToken: ReturnType<typeof vi.fn>;
      onError: ReturnType<typeof vi.fn>;
      onDone: ReturnType<typeof vi.fn>;
      onModelDone: ReturnType<typeof vi.fn>;
      onModelError: ReturnType<typeof vi.fn>;
      onModelMediaStart: ReturnType<typeof vi.fn>;
      onModelMediaProgress: ReturnType<typeof vi.fn>;
      onStageStart: ReturnType<typeof vi.fn>;
      onStageDone: ReturnType<typeof vi.fn>;
      onStageError: ReturnType<typeof vi.fn>;
    };
  } => {
    const onStart = vi.fn();
    const onToken = vi.fn();
    const onError = vi.fn();
    const onDone = vi.fn();
    const onModelDone = vi.fn();
    const onModelError = vi.fn();
    const onModelMediaStart = vi.fn();
    const onModelMediaProgress = vi.fn();
    const onStageStart = vi.fn();
    const onStageDone = vi.fn();
    const onStageError = vi.fn();
    return {
      handlers: {
        onStart,
        onToken,
        onError,
        onDone,
        onModelDone,
        onModelError,
        onModelMediaStart,
        onModelMediaProgress,
        onStageStart,
        onStageDone,
        onStageError,
      },
      mocks: {
        onStart,
        onToken,
        onError,
        onDone,
        onModelDone,
        onModelError,
        onModelMediaStart,
        onModelMediaProgress,
        onStageStart,
        onStageDone,
        onStageError,
      },
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onStart when start event is received', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: start\n');
    parser.processChunk(
      'data: {"userMessageId":"123","models":[{"modelId":"openai/gpt-4o","assistantMessageId":"456"}]}\n\n'
    );

    expect(mocks.onStart).toHaveBeenCalledWith({
      userMessageId: '123',
      models: [{ modelId: 'openai/gpt-4o', assistantMessageId: '456' }],
    });
  });

  it('calls onToken when token event is received', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: token\n');
    parser.processChunk('data: {"modelId":"openai/gpt-4o","content":"Hello"}\n\n');

    expect(mocks.onToken).toHaveBeenCalledWith({
      modelId: 'openai/gpt-4o',
      content: 'Hello',
    });
  });

  it('calls onError when error event is received', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: error\n');
    parser.processChunk('data: {"message":"Something went wrong","code":"ERR"}\n\n');

    expect(mocks.onError).toHaveBeenCalledWith({
      message: 'Something went wrong',
      code: 'ERR',
    });
  });

  it('calls onDone when done event is received', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: done\n');
    parser.processChunk('data: {}\n\n');

    expect(mocks.onDone).toHaveBeenCalled();
  });

  it('calls onStageStart when stage:start event is received', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: stage:start\n');
    parser.processChunk('data: {"stageId":"smart-model","assistantMessageId":"asst-1"}\n\n');

    expect(mocks.onStageStart).toHaveBeenCalledWith({
      stageId: 'smart-model',
      assistantMessageId: 'asst-1',
    });
  });

  it('calls onStageDone with the discriminated payload when stage:done event is received', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: stage:done\n');
    parser.processChunk(
      'data: {"assistantMessageId":"asst-1","payload":{"stageId":"smart-model","resolvedModelId":"a/m","resolvedModelName":"AM"}}\n\n'
    );

    expect(mocks.onStageDone).toHaveBeenCalledWith({
      assistantMessageId: 'asst-1',
      payload: {
        stageId: 'smart-model',
        resolvedModelId: 'a/m',
        resolvedModelName: 'AM',
      },
    });
  });

  it('calls onStageError when stage:error event is received', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: stage:error\n');
    parser.processChunk(
      'data: {"stageId":"smart-model","assistantMessageId":"asst-1","errorCode":"CLASSIFIER_FAILED"}\n\n'
    );

    expect(mocks.onStageError).toHaveBeenCalledWith({
      stageId: 'smart-model',
      assistantMessageId: 'asst-1',
      errorCode: 'CLASSIFIER_FAILED',
    });
  });

  it('handles multi-line chunks correctly', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk(
      'event: start\ndata: {"userMessageId":"1","models":[{"modelId":"openai/gpt-4o","assistantMessageId":"2"}]}\n\nevent: token\ndata: {"modelId":"openai/gpt-4o","content":"Hi"}\n\n'
    );

    expect(mocks.onStart).toHaveBeenCalledWith({
      userMessageId: '1',
      models: [{ modelId: 'openai/gpt-4o', assistantMessageId: '2' }],
    });
    expect(mocks.onToken).toHaveBeenCalledWith({
      modelId: 'openai/gpt-4o',
      content: 'Hi',
    });
  });

  it('handles split chunks (data across multiple process calls)', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: token\n');
    parser.processChunk('data: {"modelId":"openai/gpt-4o","content":"Hel');
    parser.processChunk('lo"}\n\n');

    expect(mocks.onToken).toHaveBeenCalledWith({
      modelId: 'openai/gpt-4o',
      content: 'Hello',
    });
  });

  it('accumulates content from multiple token events', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: token\ndata: {"modelId":"openai/gpt-4o","content":"Hello"}\n\n');
    parser.processChunk('event: token\ndata: {"modelId":"openai/gpt-4o","content":" world"}\n\n');

    expect(mocks.onToken).toHaveBeenCalledTimes(2);
    expect(mocks.onToken).toHaveBeenNthCalledWith(1, {
      modelId: 'openai/gpt-4o',
      content: 'Hello',
    });
    expect(mocks.onToken).toHaveBeenNthCalledWith(2, {
      modelId: 'openai/gpt-4o',
      content: ' world',
    });
    expect(parser.getModelContent('openai/gpt-4o')).toBe('Hello world');
  });

  it('returns accumulated state', () => {
    const { handlers } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk(
      'event: start\ndata: {"userMessageId":"u1","models":[{"modelId":"openai/gpt-4o","assistantMessageId":"a1"}]}\n\n'
    );
    parser.processChunk('event: token\ndata: {"modelId":"openai/gpt-4o","content":"Test"}\n\n');

    expect(parser.getUserMessageId()).toBe('u1');
    expect(parser.getModelContent('openai/gpt-4o')).toBe('Test');
  });

  describe('model-tagged events', () => {
    it('passes modelId and content to onToken handler', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: token\n');
      parser.processChunk('data: {"modelId":"openai/gpt-4o","content":"Hello"}\n\n');

      expect(mocks.onToken).toHaveBeenCalledWith({
        modelId: 'openai/gpt-4o',
        content: 'Hello',
      });
    });

    it('calls onModelDone when model:done event is received (no per-event cost)', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: model:done\n');
      parser.processChunk('data: {"modelId":"openai/gpt-4o","assistantMessageId":"asst-1"}\n\n');

      expect(mocks.onModelDone).toHaveBeenCalledWith({
        modelId: 'openai/gpt-4o',
        assistantMessageId: 'asst-1',
      });
    });

    it('calls onModelError when model:error event is received with required code', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: model:error\n');
      parser.processChunk(
        'data: {"modelId":"openai/gpt-4o","message":"Model unavailable","code":"STREAM_ERROR"}\n\n'
      );

      expect(mocks.onModelError).toHaveBeenCalledWith({
        modelId: 'openai/gpt-4o',
        message: 'Model unavailable',
        code: 'STREAM_ERROR',
      });
    });

    it('skips malformed token payload via Zod parse and logs in dev', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: token\n');
      // Missing modelId/content — should fail the schema.
      parser.processChunk('data: {"foo":"bar"}\n\n');

      expect(mocks.onToken).not.toHaveBeenCalled();
    });

    it('emits onModelMediaStart for model:media:start event', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: model:media:start\n');
      parser.processChunk(
        'data: {"modelId":"google/imagen-4","assistantMessageId":"asst-1","mediaType":"image","mimeType":"image/png"}\n\n'
      );

      expect(mocks.onModelMediaStart).toHaveBeenCalledWith({
        modelId: 'google/imagen-4',
        assistantMessageId: 'asst-1',
        mediaType: 'image',
        mimeType: 'image/png',
      });
    });

    it('emits onModelMediaProgress for model:media:progress event', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: model:media:progress\n');
      parser.processChunk(
        'data: {"modelId":"google/veo-3","assistantMessageId":"asst-2","percent":42}\n\n'
      );

      expect(mocks.onModelMediaProgress).toHaveBeenCalledWith({
        modelId: 'google/veo-3',
        assistantMessageId: 'asst-2',
        percent: 42,
      });
    });

    it('skips malformed model:media:start payload via Zod parse', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: model:media:start\n');
      // Missing required `assistantMessageId` and bad mediaType.
      parser.processChunk(
        'data: {"modelId":"google/imagen-4","mediaType":"document","mimeType":"image/png"}\n\n'
      );

      expect(mocks.onModelMediaStart).not.toHaveBeenCalled();
    });

    it('skips malformed model:media:progress payload via Zod parse', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: model:media:progress\n');
      // percent above max of 100.
      parser.processChunk(
        'data: {"modelId":"google/veo-3","assistantMessageId":"asst-2","percent":120}\n\n'
      );

      expect(mocks.onModelMediaProgress).not.toHaveBeenCalled();
    });

    it('accumulates content per model', () => {
      const { handlers } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: token\ndata: {"modelId":"openai/gpt-4o","content":"Hello"}\n\n');
      parser.processChunk('event: token\ndata: {"modelId":"anthropic/claude","content":"Hi"}\n\n');
      parser.processChunk('event: token\ndata: {"modelId":"openai/gpt-4o","content":" world"}\n\n');

      expect(parser.getModelContent('openai/gpt-4o')).toBe('Hello world');
      expect(parser.getModelContent('anthropic/claude')).toBe('Hi');
    });
  });

  describe('schema-validated stage and done payloads', () => {
    it('skips malformed stage:start payload via Zod parse', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: stage:start\n');
      // Missing required `assistantMessageId`.
      parser.processChunk('data: {"stageId":"smart-model"}\n\n');

      expect(mocks.onStageStart).not.toHaveBeenCalled();
    });

    it('skips malformed stage:done payload via Zod parse', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: stage:done\n');
      // Missing `payload.resolvedModelId` / `resolvedModelName` — should fail the schema.
      parser.processChunk(
        'data: {"assistantMessageId":"asst-1","payload":{"stageId":"smart-model"}}\n\n'
      );

      expect(mocks.onStageDone).not.toHaveBeenCalled();
    });

    it('skips malformed stage:error payload via Zod parse', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: stage:error\n');
      // Missing required `errorCode`.
      parser.processChunk('data: {"stageId":"smart-model","assistantMessageId":"asst-1"}\n\n');

      expect(mocks.onStageError).not.toHaveBeenCalled();
    });

    it('skips malformed done payload via Zod parse', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      parser.processChunk('event: done\n');
      // `aiSequence` must be a non-negative integer; -1 is rejected.
      parser.processChunk('data: {"aiSequence":-1}\n\n');

      expect(mocks.onDone).not.toHaveBeenCalled();
    });

    it('parses a full done event with userEnvelope and models', () => {
      const { handlers, mocks } = createMockHandlers();
      const parser = createSSEParser(handlers);

      const done = {
        userMessageId: 'u-1',
        assistantMessageId: 'a-1',
        userSequence: 1,
        aiSequence: 2,
        epochNumber: 1,
        cost: '0.00500000',
        userEnvelope: { wrappedContentKey: 'd3JhcA==', contentItems: [] },
        models: [
          {
            modelId: 'openai/gpt-4o',
            assistantMessageId: 'a-1',
            aiSequence: 2,
            cost: '0.00200000',
            wrappedContentKey: 'd3JhcA==',
            contentItems: [],
          },
        ],
      };

      parser.processChunk('event: done\n');
      parser.processChunk(`data: ${JSON.stringify(done)}\n\n`);

      expect(mocks.onDone).toHaveBeenCalledTimes(1);
      const callArgument = mocks.onDone.mock.calls[0]?.[0] as { models?: { modelId: string }[] };
      expect(callArgument.models?.[0]?.modelId).toBe('openai/gpt-4o');
    });
  });
});
