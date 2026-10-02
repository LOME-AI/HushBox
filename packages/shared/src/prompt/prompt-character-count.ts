/**
 * The ONE prompt measurement shared by the client composer preview and the
 * server's admission budget — the built system prompt (`buildTurnSystemPrompt`
 * output, base preamble + runnable-documents guidance + optional custom
 * instructions), every resent history turn's content, and the current input.
 * Counts are UTF-16 code units (`.length`), the same unit storage billing counts
 * stored content in.
 *
 * These counters transform nothing, so whether a count matches what the language
 * adapter transmits is the CALLER's obligation: hand them the same bytes the send
 * carries, history already trimmed through `stripReplayHistory`, its neighbour in
 * this `prompt` module.
 */

/** Sums the content length of every resent history turn. */
export function historyCharacterCount(history: readonly { readonly content: string }[]): number {
  return history.reduce((total, message) => total + message.content.length, 0);
}

export interface PromptMeasurement {
  /** The exact system prompt the send carries — always `buildTurnSystemPrompt` output. */
  readonly systemPrompt: string;
  readonly historyCharacters: number;
  /** The current turn's user input. */
  readonly prompt: string;
}

export function promptCharacterCount(input: PromptMeasurement): number {
  return input.systemPrompt.length + input.historyCharacters + input.prompt.length;
}
