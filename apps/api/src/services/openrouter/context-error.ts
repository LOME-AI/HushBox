/**
 * OpenRouter context length error parsing.
 *
 * When a request exceeds the model's context length, OpenRouter returns an error message
 * containing the exact numbers. We parse these to enable intelligent retry with correct values.
 */

/**
 * Regex to extract context info from OpenRouter error message.
 *
 * Handles variations:
 * - Text-only: "X of text input, Y in the output"
 * - Text + image: "X of text input, Y of image input, Z in the output"
 * - Text + tool: "X of text input, Y of tool input, Z in the output"
 *
 * The 's' flag enables dotall mode (. matches newlines) for multiline messages.
 */
const CONTEXT_ERROR_REGEX =
  /maximum context length is (\d+) tokens.*?(\d+) of text input.*?(\d+) in the output/s;

export interface ContextLengthError {
  /** Model's maximum context length */
  maxContext: number;
  /** Actual text input tokens (from OpenRouter's count) */
  textInput: number;
  /** Requested output tokens that caused the error */
  requestedOutput: number;
}

/**
 * Parse an OpenRouter context length error message to extract exact token counts.
 *
 * @param message - Error message from OpenRouter (may include "OpenRouter error:" prefix)
 * @returns Parsed token counts, or null if message doesn't match expected format
 */
export function parseContextLengthError(message: string): ContextLengthError | null {
  const match = CONTEXT_ERROR_REGEX.exec(message);
  if (!match) return null;

  const maxContextString = match[1];
  const textInputString = match[2];
  const requestedOutputString = match[3];

  if (!maxContextString || !textInputString || !requestedOutputString) return null;

  return {
    maxContext: Number.parseInt(maxContextString, 10),
    textInput: Number.parseInt(textInputString, 10),
    requestedOutput: Number.parseInt(requestedOutputString, 10),
  };
}
