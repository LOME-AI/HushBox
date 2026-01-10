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
    };
  } => {
    const onStart = vi.fn();
    const onToken = vi.fn();
    const onError = vi.fn();
    const onDone = vi.fn();
    return {
      handlers: { onStart, onToken, onError, onDone },
      mocks: { onStart, onToken, onError, onDone },
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onStart when start event is received', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: start\n');
    parser.processChunk('data: {"userMessageId":"123","assistantMessageId":"456"}\n\n');

    expect(mocks.onStart).toHaveBeenCalledWith({
      userMessageId: '123',
      assistantMessageId: '456',
    });
  });

  it('calls onToken when token event is received', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: token\n');
    parser.processChunk('data: {"content":"Hello"}\n\n');

    expect(mocks.onToken).toHaveBeenCalledWith('Hello');
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

  it('handles multi-line chunks correctly', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk(
      'event: start\ndata: {"userMessageId":"1","assistantMessageId":"2"}\n\nevent: token\ndata: {"content":"Hi"}\n\n'
    );

    expect(mocks.onStart).toHaveBeenCalledWith({
      userMessageId: '1',
      assistantMessageId: '2',
    });
    expect(mocks.onToken).toHaveBeenCalledWith('Hi');
  });

  it('handles split chunks (data across multiple process calls)', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    // Send event type in one chunk
    parser.processChunk('event: token\n');
    // Send partial data
    parser.processChunk('data: {"content":"Hel');
    // Complete the data
    parser.processChunk('lo"}\n\n');

    expect(mocks.onToken).toHaveBeenCalledWith('Hello');
  });

  it('accumulates content from multiple token events', () => {
    const { handlers, mocks } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: token\ndata: {"content":"Hello"}\n\n');
    parser.processChunk('event: token\ndata: {"content":" world"}\n\n');

    expect(mocks.onToken).toHaveBeenCalledTimes(2);
    expect(mocks.onToken).toHaveBeenNthCalledWith(1, 'Hello');
    expect(mocks.onToken).toHaveBeenNthCalledWith(2, ' world');
    expect(parser.getContent()).toBe('Hello world');
  });

  it('returns accumulated state', () => {
    const { handlers } = createMockHandlers();
    const parser = createSSEParser(handlers);

    parser.processChunk('event: start\ndata: {"userMessageId":"u1","assistantMessageId":"a1"}\n\n');
    parser.processChunk('event: token\ndata: {"content":"Test"}\n\n');

    expect(parser.getUserMessageId()).toBe('u1');
    expect(parser.getAssistantMessageId()).toBe('a1');
    expect(parser.getContent()).toBe('Test');
  });
});
