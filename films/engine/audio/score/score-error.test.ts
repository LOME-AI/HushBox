import { describe, expect, it } from 'vitest';

import { ScoreError } from './score-error.js';

describe('ScoreError', () => {
  const error = new ScoreError(
    {
      filmId: 'a-film',
      rule: 'unknown-cue',
      subject: 'track "kick" event 2',
      detail: 'names cue "dorp"',
    },
    { cause: new Error('underneath') }
  );

  it('names the film, the rule, the subject and what broke', () => {
    expect(error.message).toBe(
      'film "a-film", score rule "unknown-cue", track "kick" event 2: names cue "dorp"'
    );
  });

  it('carries the film, rule and subject as fields', () => {
    expect({
      filmId: error.filmId,
      rule: error.rule,
      subject: error.subject,
      name: error.name,
    }).toEqual({
      filmId: 'a-film',
      rule: 'unknown-cue',
      subject: 'track "kick" event 2',
      name: 'ScoreError',
    });
  });

  it('keeps its cause', () => {
    expect(error.cause).toEqual(new Error('underneath'));
  });
});
