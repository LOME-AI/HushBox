/** The rules a score is held to; every refusal names the one broken. */
export type ScoreRule =
  | 'shape'
  | 'unique-ids'
  | 'unknown-bus'
  | 'unknown-cue'
  | 'params'
  | 'sample-grid'
  | 'past-end'
  | 'render'
  | 'master';

/** What broke: the film, the rule, the track, event, bus or effect at fault, and how. */
interface ScoreBreak {
  filmId: string;
  rule: ScoreRule;
  subject: string;
  detail: string;
}

/** A score that breaks a rule, naming the film, the rule and what broke it. */
export class ScoreError extends Error {
  readonly filmId: string;
  readonly rule: ScoreRule;
  readonly subject: string;

  constructor({ filmId, rule, subject, detail }: ScoreBreak, options?: ErrorOptions) {
    super(`film ${JSON.stringify(filmId)}, score rule "${rule}", ${subject}: ${detail}`, options);
    this.name = 'ScoreError';
    this.filmId = filmId;
    this.rule = rule;
    this.subject = subject;
  }
}
