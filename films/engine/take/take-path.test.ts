import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { takeIdOf } from './take-path.js';

const ROOT = path.join(path.sep, 'repo', 'films');
const REPO = path.dirname(ROOT);

describe('takeIdOf', () => {
  it('reads a path given from the repository root', () => {
    const argument = path.join('films', 'my-film', 'rounds', '01', 'ink');

    expect(takeIdOf(argument, { cwd: REPO, root: ROOT })).toBe('my-film/rounds/01/ink');
  });

  it('reads a path given from the films package', () => {
    expect(takeIdOf('my-film/rounds/01/ink', { cwd: REPO, root: ROOT })).toBe(
      'my-film/rounds/01/ink'
    );
  });

  it('reads a path given from inside a film', () => {
    const cwd = path.join(ROOT, 'my-film');

    expect(takeIdOf(path.join('rounds', '01', 'ink'), { cwd, root: ROOT })).toBe(
      'my-film/rounds/01/ink'
    );
  });

  it('reads an absolute path', () => {
    const argument = path.join(ROOT, 'my-film', 'rounds', '01', 'ink');

    expect(takeIdOf(argument, { cwd: REPO, root: ROOT })).toBe('my-film/rounds/01/ink');
  });

  it('drops a trailing separator', () => {
    expect(takeIdOf(`my-film/rounds/01/ink${path.sep}`, { cwd: REPO, root: ROOT })).toBe(
      'my-film/rounds/01/ink'
    );
  });
});
