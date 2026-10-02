/** One broken rule: the film, the rule, where it broke (a frame, a cue, a text id, a track or a file) and how. */
export interface GateFailure {
  filmId: string;
  rule: string;
  at: string;
  detail: string;
}

/** What one gate found: whether it passed, each failure as its printed line, and what it measured. */
export interface GateResult {
  gate: string;
  passed: boolean;
  failures: string[];
  measured: string[];
}

/** A failure as the line `pnpm films verify` prints and the report lists. */
export function failureLine({ filmId, rule, at, detail }: GateFailure): string {
  return `${filmId}: ${rule}: ${at}: ${detail}`;
}

/** A gate's result from its failures and the measurements it reports either way. */
export function gateResult(
  gate: string,
  failures: readonly GateFailure[],
  measured: readonly string[]
): GateResult {
  return {
    gate,
    passed: failures.length === 0,
    failures: failures.map((failure) => failureLine(failure)),
    measured: [...measured],
  };
}

/**
 * A film that failed at least one gate. Its message opens with the film and the
 * gates that failed and lists every failure line; the CLI prints it and exits 1.
 */
export class QaGateError extends Error {
  readonly filmId: string;

  constructor(filmId: string, results: readonly GateResult[]) {
    const failed = results.filter(({ passed }) => !passed);
    const heading = `${filmId}: verify failed: ${failed.map(({ gate }) => gate).join(', ')}`;
    super([heading, ...failed.flatMap(({ failures }) => failures)].join('\n'));
    this.name = 'QaGateError';
    this.filmId = filmId;
  }
}
