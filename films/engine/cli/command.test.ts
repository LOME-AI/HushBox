import { describe, expect, it } from 'vitest';

import { DEFAULT_GL, parseCommand } from './command.js';

import type { Parsed } from './command.js';

/** Why the arguments could not be read, or nothing when they were. */
function usageOf(parsed: Parsed): string {
  return 'usage' in parsed ? parsed.usage : '';
}

describe('parseCommand', () => {
  it('asks for a verb when none is given', () => {
    expect(parseCommand([])).toEqual({ usage: 'no verb was given' });
  });

  it('refuses an unknown verb, naming it', () => {
    expect(parseCommand(['dance', 'engine-render'])).toEqual({ usage: 'unknown verb "dance"' });
  });

  it('reads the film a verb acts on', () => {
    expect(parseCommand(['score', 'engine-render'])).toEqual({
      command: { verb: 'score', filmId: 'engine-render' },
    });
  });

  it('asks for the film when none is given', () => {
    expect(parseCommand(['score'])).toEqual({ usage: 'score needs a film id' });
  });

  it('refuses a second film', () => {
    expect(parseCommand(['score', 'engine-render', 'engine-empty'])).toEqual({
      usage: 'score takes one film id, got 2',
    });
  });

  it('renders stills at the probe frames on the default GL backend unless told otherwise', () => {
    expect(parseCommand(['stills', 'engine-render'])).toEqual({
      command: { verb: 'stills', filmId: 'engine-render', frames: null, gl: DEFAULT_GL },
    });
  });

  it('renders on ANGLE by default', () => {
    expect(DEFAULT_GL).toBe('angle');
  });

  it('reads a comma-separated frame list', () => {
    expect(parseCommand(['stills', 'engine-render', '--frames', '0,24,48'])).toMatchObject({
      command: { frames: [0, 24, 48] },
    });
  });

  it('refuses a frame list entry that is not a whole frame number, naming it', () => {
    expect(parseCommand(['stills', 'engine-render', '--frames', '0,2.5'])).toEqual({
      usage: '--frames takes whole frame numbers separated by commas, got "2.5"',
    });
  });

  it('refuses an empty frame list entry', () => {
    expect(parseCommand(['stills', 'engine-render', '--frames', '0,,4'])).toEqual({
      usage: '--frames takes whole frame numbers separated by commas, got ""',
    });
  });

  it('reads the GL backend for stills', () => {
    expect(parseCommand(['stills', 'engine-render', '--gl', 'swangle'])).toMatchObject({
      command: { gl: 'swangle' },
    });
  });

  it('renders the master on the default GL backend unless told otherwise', () => {
    expect(parseCommand(['render', 'engine-render'])).toEqual({
      command: { verb: 'render', filmId: 'engine-render', draft: false, gl: DEFAULT_GL },
    });
  });

  it('reads the draft switch', () => {
    expect(parseCommand(['render', 'engine-render', '--draft'])).toMatchObject({
      command: { draft: true },
    });
  });

  it('reads the GL backend for a render', () => {
    expect(parseCommand(['render', 'engine-render', '--gl', 'swangle'])).toMatchObject({
      command: { gl: 'swangle' },
    });
  });

  it('refuses an option the verb does not take, naming it', () => {
    expect(usageOf(parseCommand(['render', 'engine-render', '--frames', '0']))).toContain(
      "'--frames'"
    );
  });

  it('refuses an option stills does not take, naming it', () => {
    expect(usageOf(parseCommand(['stills', 'engine-render', '--draft']))).toContain("'--draft'");
  });

  it('refuses an option given without its value, naming it', () => {
    expect(usageOf(parseCommand(['stills', 'engine-render', '--frames']))).toContain("'--frames");
  });

  it('refuses an option on score', () => {
    expect(usageOf(parseCommand(['score', 'engine-render', '--draft']))).toContain("'--draft'");
  });

  it('reads verify with its film id and the default GL backend', () => {
    expect(parseCommand(['verify', 'engine-render'])).toEqual({
      command: { verb: 'verify', filmId: 'engine-render', gl: 'angle' },
    });
  });

  it('reads the GL backend verify renders on', () => {
    expect(parseCommand(['verify', 'engine-render', '--gl', 'swangle'])).toEqual({
      command: { verb: 'verify', filmId: 'engine-render', gl: 'swangle' },
    });
  });

  it('refuses verify without a film id', () => {
    expect(usageOf(parseCommand(['verify']))).toBe('verify needs a film id');
  });

  it('refuses an option verify does not take, naming it', () => {
    expect(usageOf(parseCommand(['verify', 'engine-render', '--draft']))).toContain("'--draft'");
  });

  it('reads take with its take path and the default GL backend', () => {
    expect(parseCommand(['take', 'my-film/rounds/01/ink'])).toEqual({
      command: { verb: 'take', takePath: 'my-film/rounds/01/ink', gl: DEFAULT_GL },
    });
  });

  it('reads the GL backend a take renders on', () => {
    expect(parseCommand(['take', 'my-film/rounds/01/ink', '--gl', 'swangle'])).toEqual({
      command: { verb: 'take', takePath: 'my-film/rounds/01/ink', gl: 'swangle' },
    });
  });

  it('asks for the take path when none is given', () => {
    expect(usageOf(parseCommand(['take']))).toBe('take needs a take path');
  });

  it('refuses a second take path', () => {
    expect(usageOf(parseCommand(['take', 'a/rounds/01/b', 'a/rounds/01/c']))).toBe(
      'take takes one take path, got 2'
    );
  });

  it('refuses an option take does not take, naming it', () => {
    expect(usageOf(parseCommand(['take', 'a/rounds/01/b', '--draft']))).toContain("'--draft'");
  });
});
