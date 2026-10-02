import { InvalidToolInputError, NoSuchToolError } from 'ai';
import type { ToolErrorReason } from '@hushbox/shared';

/**
 * A tool call the inference's call budget refused before its `execute` ran. The
 * message is fixed, so neither the call's arguments nor any result can ride it.
 */
export class ToolCallLimitError extends Error {
  constructor() {
    super('tool call refused: the call budget is spent');
    this.name = 'ToolCallLimitError';
  }
}

/**
 * Why a tool call produced no result, from what the call failed with: the
 * budget refused it, the SDK rejected its arguments or its tool name, or its
 * `execute` threw. A run whose signal has aborted gets no reason at all, so an
 * abort never surfaces as a tool failure.
 */
export function toolErrorReason(error: unknown): ToolErrorReason;
export function toolErrorReason(
  error: unknown,
  signal: AbortSignal | undefined
): ToolErrorReason | undefined;
export function toolErrorReason(error: unknown, signal?: AbortSignal): ToolErrorReason | undefined {
  if (signal?.aborted === true) return undefined;
  if (error instanceof ToolCallLimitError) return 'limit';
  if (InvalidToolInputError.isInstance(error) || NoSuchToolError.isInstance(error)) {
    return 'invalid-input';
  }
  return 'failed';
}
