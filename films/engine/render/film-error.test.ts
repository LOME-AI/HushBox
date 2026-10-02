import { describe, expect, it } from 'vitest';

import { FilmRenderError } from './film-error.js';

describe('FilmRenderError', () => {
  const error = new FilmRenderError({
    filmId: 'engine-render',
    rule: 'render',
    detail: 'frame 49 did not finish',
  });

  it('names the film, the rule and what broke, in that order', () => {
    expect(error.message).toBe('engine-render: render: frame 49 did not finish');
  });

  it('carries the film id', () => {
    expect(error.filmId).toBe('engine-render');
  });

  it('carries the rule', () => {
    expect(error.rule).toBe('render');
  });

  it('is named for its class', () => {
    expect(error.name).toBe('FilmRenderError');
  });

  it('keeps its cause', () => {
    const cause = new Error('the renderer timed out');

    expect(new FilmRenderError({ filmId: 'x', rule: 'render', detail: 'd' }, { cause }).cause).toBe(
      cause
    );
  });
});
