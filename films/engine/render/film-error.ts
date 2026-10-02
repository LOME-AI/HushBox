/** What broke in rendering a film: the film, the rule it broke, and how. */
interface FilmRenderBreak {
  filmId: string;
  rule: string;
  detail: string;
}

/**
 * A render, still or mux that failed with a named cause. Its message names the
 * film, the rule and the frame or file that broke it; the CLI prints it and
 * exits non-zero.
 */
export class FilmRenderError extends Error {
  readonly filmId: string;
  readonly rule: string;

  constructor({ filmId, rule, detail }: FilmRenderBreak, options?: ErrorOptions) {
    super(`${filmId}: ${rule}: ${detail}`, options);
    this.name = 'FilmRenderError';
    this.filmId = filmId;
    this.rule = rule;
  }
}
