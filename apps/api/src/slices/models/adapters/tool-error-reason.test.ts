import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { describe, expect, it } from 'vitest';
import { ToolCallLimitError, toolErrorReason } from './tool-error-reason.js';

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort(new Error('run hard-stopped'));
  return controller.signal;
}

describe('toolErrorReason', () => {
  it('classifies a call the budget refused as limit', () => {
    expect(toolErrorReason(new ToolCallLimitError())).toBe('limit');
  });

  it('classifies arguments the SDK rejected as invalid-input', () => {
    const error = new InvalidToolInputError({ toolName: 'webSearch', toolInput: '{}', cause: 1 });
    expect(toolErrorReason(error)).toBe('invalid-input');
  });

  it('classifies a call to a tool the step does not offer as invalid-input', () => {
    expect(toolErrorReason(new NoSuchToolError({ toolName: 'ghost' }))).toBe('invalid-input');
  });

  it('classifies anything an execute threw as failed', () => {
    expect(toolErrorReason(new Error('search backend down'))).toBe('failed');
  });

  it('classifies a thrown non-error as failed', () => {
    expect(toolErrorReason('not an error')).toBe('failed');
  });

  it('gives no reason once the run has aborted', () => {
    expect(toolErrorReason(new Error('aborted mid-search'), abortedSignal())).toBeUndefined();
  });

  it('classifies as usual while the run has not aborted', () => {
    expect(toolErrorReason(new ToolCallLimitError(), new AbortController().signal)).toBe('limit');
  });
});

describe('ToolCallLimitError', () => {
  it('carries a fixed message and no cause', () => {
    const error = new ToolCallLimitError();
    expect(error.name).toBe('ToolCallLimitError');
    expect(error.message).toBe('tool call refused: the call budget is spent');
    expect(error.cause).toBeUndefined();
  });
});
