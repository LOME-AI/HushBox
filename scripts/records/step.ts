/**
 * The one shape every records failure takes: `records: <step> failed: <cause>`.
 * A failure already named for its own step keeps that name when an enclosing
 * step reports it, so the message names the innermost step that failed.
 */

export class StepFailure extends Error {
  constructor(step: string, detail: string, options?: ErrorOptions) {
    super(`records: ${step} failed: ${detail}`, options);
    this.name = 'StepFailure';
  }
}

function failureOf(step: string, error: unknown): unknown {
  return error instanceof StepFailure
    ? error
    : new StepFailure(step, String(error), { cause: error });
}

/** Runs `action`, reporting its failure as a failure of `step`. */
export function atStep<T>(step: string, action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw failureOf(step, error);
  }
}

/** {@link atStep} for an action that resolves later. */
export async function duringStep<T>(step: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw failureOf(step, error);
  }
}
