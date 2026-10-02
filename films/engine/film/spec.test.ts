import { describe, expect, it } from 'vitest';

import { FilmSpecError, defineFilm, filmSpecInputSchema } from './spec.js';

import type { CueKind, FilmSpec, FilmSpecInput } from './spec.js';

type ShotInput = NonNullable<FilmSpecInput['shots']>[number];
type TextInput = FilmSpecInput['text'][number];
type CueInput = FilmSpecInput['cues'][number];

/**
 * Two shots of four beats at 150 BPM (192 frames), with a riser ending on the
 * same frame a silence starts, and a silence that runs to the end.
 */
function validInput(): FilmSpecInput & { shots: ShotInput[] } {
  return {
    id: 'two-shots',
    title: 'Two shots',
    seed: 'two-shots',
    grid: { framesPerBeat: 24, beatsPerBar: 4 },
    beats: 8,
    shots: [
      {
        id: 'open',
        fromBeat: 0,
        toBeat: 4,
        reads: [
          { fromBeat: 0, toBeat: 2, what: 'the room' },
          { fromBeat: 2, toBeat: 4, what: 'the question' },
        ],
      },
      {
        id: 'close',
        fromBeat: 4,
        toBeat: 8,
        reads: [{ fromBeat: 4.5, toBeat: 8, what: 'the mark' }],
      },
    ],
    text: [
      {
        id: 'q',
        shotId: 'open',
        words: 'Do you like AI companies?',
        role: 'headline',
        inBeat: 0.5,
        outBeat: 4,
        basis: { kind: 'opinion' },
      },
      { id: 'sign', shotId: 'close', words: 'OPEN', role: 'imagery', inBeat: 4, outBeat: 4.25 },
      {
        id: 'lock',
        shotId: 'close',
        words: 'Locked.',
        role: 'support',
        inBeat: 4,
        outBeat: 6,
        basis: { kind: 'fact', source: 'README.md:58' },
      },
      {
        id: 'wm',
        shotId: 'close',
        words: 'HushBox',
        role: 'cta',
        inBeat: 5,
        outBeat: 8,
        basis: { kind: 'brand', source: 'README.md:7' },
      },
    ],
    cues: [
      { id: 'strike', beat: 0, kind: 'hit', anchor: 'start' },
      { id: 'windup', beat: 3.5, kind: 'riser-end', anchor: 'end' },
      { id: 'gap', beat: 3.5, kind: 'silence', anchor: 'start' },
      { id: 'drop', beat: 4, kind: 'impact', anchor: 'start' },
      { id: 'tail', beat: 7.75, kind: 'silence', anchor: 'start' },
    ],
  };
}

describe('defineFilm', () => {
  it('resolves every beat of a valid multi-shot spec to integer frames', () => {
    const expected: FilmSpec = {
      id: 'two-shots',
      title: 'Two shots',
      seed: 'two-shots',
      grid: { framesPerBeat: 24, beatsPerBar: 4 },
      beats: 8,
      durationInFrames: 192,
      bpm: 150,
      shots: [
        {
          id: 'open',
          fromBeat: 0,
          toBeat: 4,
          from: 0,
          to: 96,
          reads: [
            { fromBeat: 0, toBeat: 2, what: 'the room', from: 0, to: 48 },
            { fromBeat: 2, toBeat: 4, what: 'the question', from: 48, to: 96 },
          ],
        },
        {
          id: 'close',
          fromBeat: 4,
          toBeat: 8,
          from: 96,
          to: 192,
          reads: [{ fromBeat: 4.5, toBeat: 8, what: 'the mark', from: 108, to: 192 }],
        },
      ],
      text: [
        {
          id: 'q',
          shotId: 'open',
          words: 'Do you like AI companies?',
          role: 'headline',
          inBeat: 0.5,
          outBeat: 4,
          basis: { kind: 'opinion' },
          from: 12,
          to: 96,
        },
        {
          id: 'sign',
          shotId: 'close',
          words: 'OPEN',
          role: 'imagery',
          inBeat: 4,
          outBeat: 4.25,
          from: 96,
          to: 102,
        },
        {
          id: 'lock',
          shotId: 'close',
          words: 'Locked.',
          role: 'support',
          inBeat: 4,
          outBeat: 6,
          basis: { kind: 'fact', source: 'README.md:58' },
          from: 96,
          to: 144,
        },
        {
          id: 'wm',
          shotId: 'close',
          words: 'HushBox',
          role: 'cta',
          inBeat: 5,
          outBeat: 8,
          basis: { kind: 'brand', source: 'README.md:7' },
          from: 120,
          to: 192,
        },
      ],
      cues: [
        { id: 'strike', beat: 0, kind: 'hit', anchor: 'start', from: 0, to: 0 },
        { id: 'windup', beat: 3.5, kind: 'riser-end', anchor: 'end', from: 84, to: 84 },
        { id: 'gap', beat: 3.5, kind: 'silence', anchor: 'start', from: 84, to: 84 },
        { id: 'drop', beat: 4, kind: 'impact', anchor: 'start', from: 96, to: 96 },
        { id: 'tail', beat: 7.75, kind: 'silence', anchor: 'start', from: 186, to: 186 },
      ],
      silences: [
        { cueId: 'gap', from: 84, to: 96 },
        { cueId: 'tail', from: 186, to: 192 },
      ],
    };

    expect(defineFilm(validInput())).toEqual(expected);
  });
});

/** `validInput()` with `change` applied to the shot whose id is `id`. */
function withShot(id: string, change: Partial<ShotInput>): FilmSpecInput & { shots: ShotInput[] } {
  const input = validInput();
  return {
    ...input,
    shots: input.shots.map((shot) => (shot.id === id ? { ...shot, ...change } : shot)),
  };
}

/** `validInput()` with `change` applied to the text block whose id is `id`. */
function withText(id: string, change: Partial<TextInput>): FilmSpecInput {
  const input = validInput();
  return {
    ...input,
    text: input.text.map((block) => (block.id === id ? { ...block, ...change } : block)),
  };
}

/** `validInput()` with `change` applied to the cue whose id is `id`. */
function withCue(id: string, change: Partial<CueInput>): FilmSpecInput {
  const input = validInput();
  return { ...input, cues: input.cues.map((cue) => (cue.id === id ? { ...cue, ...change } : cue)) };
}

/** The duration of `framedFilm()`, in frames. */
const FRAMED_DURATION = 192;

/** A 192-frame film at one frame per beat, so a beat is a frame: one shot, `whole`, and nothing else. */
function framedFilm(): FilmSpecInput {
  return {
    ...validInput(),
    grid: { framesPerBeat: 1, beatsPerBar: 4 },
    beats: FRAMED_DURATION,
    shots: [{ id: 'whole', fromBeat: 0, toBeat: FRAMED_DURATION, reads: [] }],
    text: [],
    cues: [],
  };
}

/** `framedFilm()` with its shot ending at frame `to`. */
function shotEndingAt(to: number): FilmSpecInput {
  return { ...framedFilm(), shots: [{ id: 'whole', fromBeat: 0, toBeat: to, reads: [] }] };
}

/** `framedFilm()` with one read, `the mark`, from frame 96 to frame `to`. */
function readEndingAt(to: number): FilmSpecInput {
  const reads = [{ fromBeat: 96, toBeat: to, what: 'the mark' }];
  return { ...framedFilm(), shots: [{ id: 'whole', fromBeat: 0, toBeat: FRAMED_DURATION, reads }] };
}

/** `framedFilm()` with one cta, `wm`, from frame 96 to frame `to`. */
function textEndingAt(to: number): FilmSpecInput {
  const block: TextInput = {
    id: 'wm',
    shotId: 'whole',
    words: 'HushBox',
    role: 'cta',
    inBeat: 96,
    outBeat: to,
    basis: { kind: 'brand', source: 'README.md:7' },
  };
  return { ...framedFilm(), text: [block] };
}

/** `framedFilm()` with one cue, `last`, at `frame`. */
function cueAt(frame: number, anchor: CueInput['anchor']): FilmSpecInput {
  return { ...framedFilm(), cues: [{ id: 'last', beat: frame, kind: 'hit', anchor }] };
}

/** Asserts `defineFilm` refuses `input` with a `FilmSpecError` naming `rule` and `subject`. */
function expectRefusal(input: FilmSpecInput, rule: string, subject: string): void {
  expect(() => defineFilm(input)).toThrow(FilmSpecError);
  expect(() => defineFilm(input)).toThrow(`rule "${rule}"`);
  expect(() => defineFilm(input)).toThrow(subject);
}

describe('shape rule', () => {
  it('refuses a film id that is not kebab-case, naming it', () => {
    expectRefusal({ ...validInput(), id: 'Two_Shots' }, 'shape', 'film "Two_Shots"');
  });

  it('names the text block whose beat is negative', () => {
    expectRefusal(withText('lock', { inBeat: -1 }), 'shape', 'text "lock"');
  });

  it('names the shot whose read has a negative beat', () => {
    const reads = [{ fromBeat: -0.5, toBeat: 8, what: 'the mark' }];

    expectRefusal(withShot('close', { reads }), 'shape', 'shot "close"');
  });

  it('refuses a cue kind outside the set, naming the cue', () => {
    const cues: unknown[] = [{ id: 'buzz', beat: 0, kind: 'buzz', anchor: 'start' }];

    // Object.assign carries a value the input type forbids, as an untyped caller could.
    expectRefusal(Object.assign(validInput(), { cues }), 'shape', 'cue "buzz"');
  });

  it('names the spec when a collection is not a list', () => {
    // Object.assign carries a value the input type forbids, as an untyped caller could.
    expectRefusal(Object.assign(validInput(), { text: 'none' }), 'shape', 'the spec');
  });

  it('refuses a fact basis with no source, naming the text block', () => {
    expectRefusal(
      withText('lock', { basis: { kind: 'fact', source: '' } }),
      'shape',
      'text "lock"'
    );
  });

  it('refuses a non-integer framesPerBeat', () => {
    expectRefusal(
      { ...validInput(), grid: { framesPerBeat: 24.5, beatsPerBar: 4 } },
      'shape',
      'the spec'
    );
  });
});

describe('cue kinds', () => {
  it('accepts every cue kind', () => {
    const kinds: CueKind[] = [
      'hit',
      'impact',
      'whoosh',
      'tick',
      'silence',
      'stutter',
      'flash',
      'riser-end',
    ];
    const cues = kinds.map((kind): CueInput => ({ id: kind, beat: 1, kind, anchor: 'peak' }));

    expect(defineFilm({ ...validInput(), cues }).cues.map((cue) => cue.kind)).toEqual(kinds);
  });

  it('exposes the input schema for a caller holding untyped data', () => {
    expect(filmSpecInputSchema.safeParse(validInput()).success).toBe(true);
  });
});

describe('unique-ids rule', () => {
  it('refuses two shots sharing an id', () => {
    expectRefusal(withShot('close', { id: 'open' }), 'unique-ids', 'shot "open"');
  });

  it('refuses two text blocks sharing an id', () => {
    expectRefusal(withText('wm', { id: 'q' }), 'unique-ids', 'text "q"');
  });

  it('refuses two cues sharing an id', () => {
    expectRefusal(withCue('tail', { id: 'gap' }), 'unique-ids', 'cue "gap"');
  });

  it('accepts one id used once in each collection', () => {
    const input = withCue('drop', { id: 'close' });

    expect(defineFilm(input).cues.map((cue) => cue.id)).toContain('close');
  });
});

describe('cut-on-beat rule', () => {
  it('refuses a shot that ends between beats', () => {
    const input = withShot('open', { toBeat: 3.5 });

    expectRefusal(
      {
        ...input,
        shots: input.shots.map((shot) => (shot.id === 'close' ? { ...shot, fromBeat: 3.5 } : shot)),
      },
      'cut-on-beat',
      'shot "open"'
    );
  });
});

describe('frame-grid rule', () => {
  it('refuses a cue whose beat lands between frames', () => {
    expectRefusal(withCue('drop', { beat: 4.01 }), 'frame-grid', 'cue "drop"');
  });

  it('refuses a text block whose beat lands between frames', () => {
    expectRefusal(withText('q', { inBeat: 0.51 }), 'frame-grid', 'text "q"');
  });

  it('refuses a read whose beat lands between frames, naming its shot', () => {
    const reads = [{ fromBeat: 4.51, toBeat: 8, what: 'the mark' }];

    expectRefusal(withShot('close', { reads }), 'frame-grid', 'shot "close" read "the mark"');
  });
});

describe('empty-span rule', () => {
  it('refuses a shot that ends where it starts', () => {
    expectRefusal(withShot('close', { fromBeat: 4, toBeat: 4 }), 'empty-span', 'shot "close"');
  });

  it('refuses a read that ends where it starts', () => {
    const reads = [{ fromBeat: 6, toBeat: 6, what: 'the mark' }];

    expectRefusal(withShot('close', { reads }), 'empty-span', 'shot "close" read "the mark"');
  });

  it('refuses a text block that ends before it starts', () => {
    expectRefusal(withText('sign', { outBeat: 3.75 }), 'empty-span', 'text "sign"');
  });
});

describe('past-end rule', () => {
  it('accepts a shot ending at durationInFrames', () => {
    expect(defineFilm(shotEndingAt(FRAMED_DURATION)).shots[0]?.to).toBe(FRAMED_DURATION);
  });

  it('refuses a shot ending at durationInFrames + 1', () => {
    expectRefusal(shotEndingAt(FRAMED_DURATION + 1), 'past-end', 'shot "whole"');
  });

  it('accepts a read ending at durationInFrames', () => {
    expect(defineFilm(readEndingAt(FRAMED_DURATION)).shots[0]?.reads[0]?.to).toBe(FRAMED_DURATION);
  });

  it('refuses a read ending at durationInFrames + 1', () => {
    expectRefusal(readEndingAt(FRAMED_DURATION + 1), 'past-end', 'shot "whole" read "the mark"');
  });

  it('accepts a text block ending at durationInFrames', () => {
    expect(defineFilm(textEndingAt(FRAMED_DURATION)).text[0]?.to).toBe(FRAMED_DURATION);
  });

  it('refuses a text block ending at durationInFrames + 1', () => {
    expectRefusal(textEndingAt(FRAMED_DURATION + 1), 'past-end', 'text "wm"');
  });

  it.each(['start', 'peak'] as const)(
    'accepts a %s-anchored cue on the last frame, durationInFrames - 1',
    (anchor) => {
      expect(defineFilm(cueAt(FRAMED_DURATION - 1, anchor)).cues[0]?.from).toBe(
        FRAMED_DURATION - 1
      );
    }
  );

  it.each(['start', 'peak'] as const)('refuses a %s-anchored cue at durationInFrames', (anchor) => {
    expectRefusal(cueAt(FRAMED_DURATION, anchor), 'past-end', 'cue "last"');
  });

  it('accepts an end-anchored cue at durationInFrames', () => {
    expect(defineFilm(cueAt(FRAMED_DURATION, 'end')).cues[0]?.from).toBe(FRAMED_DURATION);
  });

  it('refuses an end-anchored cue at durationInFrames + 1', () => {
    expectRefusal(cueAt(FRAMED_DURATION + 1, 'end'), 'past-end', 'cue "last"');
  });
});

describe('shots-tile rule', () => {
  it('refuses a gap between two shots', () => {
    expectRefusal(withShot('close', { fromBeat: 5 }), 'shots-tile', 'shot "close"');
  });

  it('refuses two shots that overlap', () => {
    expectRefusal(withShot('close', { fromBeat: 3 }), 'shots-tile', 'shot "close"');
  });

  it('refuses a first shot that starts after frame 0', () => {
    expectRefusal(withShot('open', { fromBeat: 1 }), 'shots-tile', 'shot "open"');
  });

  it('refuses shots that stop short of the end', () => {
    expectRefusal(withShot('close', { toBeat: 7 }), 'shots-tile', 'shot "close"');
  });

  it('accepts shots declared out of time order', () => {
    const input = validInput();

    expect(defineFilm({ ...input, shots: input.shots.toReversed() }).shots[0]?.id).toBe('close');
  });
});

describe('reads-overlap rule', () => {
  it('refuses two reads in one shot that overlap', () => {
    const reads = [
      { fromBeat: 0, toBeat: 2, what: 'the room' },
      { fromBeat: 1.5, toBeat: 4, what: 'the question' },
    ];

    expectRefusal(withShot('open', { reads }), 'reads-overlap', 'shot "open" read "the question"');
  });
});

describe('text-in-shot rule', () => {
  it('refuses a text block that starts before its shot', () => {
    expectRefusal(withText('lock', { inBeat: 3.5 }), 'text-in-shot', 'text "lock"');
  });

  it('refuses a text block that ends after its shot', () => {
    expectRefusal(withText('q', { outBeat: 4.5 }), 'text-in-shot', 'text "q"');
  });

  it('refuses a text block that names no declared shot', () => {
    expectRefusal(withText('q', { shotId: 'nowhere' }), 'text-in-shot', 'text "q"');
  });
});

/** `validInput()` with no shots and no text row naming one. */
function shotless(): FilmSpecInput {
  const { id, title, seed, grid, beats, text, cues } = validInput();
  const unshot = text.map(({ shotId: _shotId, ...block }) => block);
  return { id, title, seed, grid, beats, text: unshot, cues };
}

describe('a spec without shots', () => {
  it('validates, resolving to no shots', () => {
    expect(defineFilm(shotless()).shots).toEqual([]);
  });

  it('validates with an empty shot list', () => {
    expect(defineFilm({ ...shotless(), shots: [] }).shots).toEqual([]);
  });

  it('keeps its text rows, resolved to frames', () => {
    expect(defineFilm(shotless()).text.find(({ id }) => id === 'q')).toMatchObject({
      from: 12,
      to: 96,
    });
  });

  it('accepts a text row that names a shot, since no shot check runs', () => {
    const input = shotless();

    expect(
      defineFilm({ ...input, text: input.text.map((block) => ({ ...block, shotId: 'later' })) })
        .text
    ).toHaveLength(4);
  });

  it('still holds a copy line to its reading time', () => {
    const input = shotless();
    const text = input.text.map((block) => (block.id === 'q' ? { ...block, outBeat: 1 } : block));

    expectRefusal({ ...input, text }, 'text-hold', 'text "q"');
  });
});

describe('a spec with shots', () => {
  it('refuses a text row that names no shot', () => {
    const input = validInput();
    const text = input.text.map(({ shotId, ...block }) =>
      block.id === 'q' ? block : { ...block, shotId }
    );

    expectRefusal({ ...input, text }, 'text-in-shot', 'text "q"');
  });
});

describe('a shot row', () => {
  it('carries its framing, camera, event and seam', () => {
    const direction = {
      framing: 'close on the hands',
      camera: 'slow push in',
      event: 'the lock turns',
      seam: 'hard cut',
    };

    expect(defineFilm(withShot('open', direction)).shots[0]).toMatchObject(direction);
  });

  it('refuses an empty framing, naming the shot', () => {
    expectRefusal(withShot('close', { framing: '' }), 'shape', 'shot "close"');
  });

  it('refuses a seam that is not text, naming the shot', () => {
    // Object.assign carries a value the input type forbids, as an untyped caller could.
    const shots = validInput().shots.map((shot) =>
      shot.id === 'open' ? Object.assign(shot, { seam: 3 }) : shot
    );

    expectRefusal({ ...validInput(), shots }, 'shape', 'shot "open"');
  });
});

/** `validInput()` whose only text block is `block`. */
function withOnlyText(block: TextInput): FilmSpecInput {
  return { ...validInput(), text: [block] };
}

describe('text-basis rule', () => {
  it.each(['headline', 'support', 'cta'] as const)('refuses a %s line with no basis', (role) => {
    const block: TextInput = {
      id: 'bare',
      shotId: 'open',
      words: 'Hello.',
      role,
      inBeat: 0,
      outBeat: 4,
    };

    expectRefusal(withOnlyText(block), 'text-basis', 'text "bare"');
  });

  it('exempts imagery text from the basis rule', () => {
    const block: TextInput = {
      id: 'stamp',
      shotId: 'open',
      words: 'FOR SALE',
      role: 'imagery',
      inBeat: 0,
      outBeat: 4,
    };

    expect(defineFilm(withOnlyText(block)).text).toHaveLength(1);
  });
});

/** One shot of 600 frames at one frame per beat, so beats count frames, holding one text block. */
function heldText(words: string, role: TextInput['role'], frames: number): FilmSpecInput {
  return {
    id: 'held-text',
    title: 'Held text',
    seed: 'held-text',
    grid: { framesPerBeat: 1, beatsPerBar: 4 },
    beats: 600,
    shots: [{ id: 'only', fromBeat: 0, toBeat: 600, reads: [] }],
    text: [
      {
        id: 'line',
        shotId: 'only',
        words,
        role,
        inBeat: 0,
        outBeat: frames,
        basis: { kind: 'opinion' },
      },
    ],
    cues: [],
  };
}

const SHORT_LINE = 'Like them?';
const LONG_LINE = 'Your saved chats are locked. Even from HushBox.';

describe('text-hold rule', () => {
  it('accepts a 10-character line held for the 0.8 s minimum of 48 frames', () => {
    expect(defineFilm(heldText(SHORT_LINE, 'headline', 48)).text[0]?.to).toBe(48);
  });

  it('refuses a 10-character line held 47 frames', () => {
    expectRefusal(heldText(SHORT_LINE, 'headline', 47), 'text-hold', 'text "line"');
  });

  it('accepts a 47-character line held 141 frames, 20 characters per second', () => {
    expect(defineFilm(heldText(LONG_LINE, 'headline', 141)).text[0]?.to).toBe(141);
  });

  it('refuses a 47-character line held 140 frames', () => {
    expectRefusal(heldText(LONG_LINE, 'headline', 140), 'text-hold', 'text "line"');
  });

  it.each(['support', 'cta'] as const)('refuses a %s line held under its floor', (role) => {
    expectRefusal(heldText(SHORT_LINE, role, 47), 'text-hold', 'text "line"');
  });

  it('counts characters as code points, not UTF-16 units', () => {
    expect(defineFilm(heldText('🔒'.repeat(21), 'headline', 63)).text[0]?.to).toBe(63);
  });

  it('exempts imagery text from the hold floor', () => {
    expect(defineFilm(heldText(LONG_LINE, 'imagery', 1)).text[0]?.to).toBe(1);
  });
});

describe('silences', () => {
  it('ends a silence at the next strictly later cue, past a cue on its own frame', () => {
    expect(defineFilm(validInput()).silences[0]).toEqual({ cueId: 'gap', from: 84, to: 96 });
  });

  it('ends the last silence at durationInFrames', () => {
    expect(defineFilm(validInput()).silences[1]).toEqual({ cueId: 'tail', from: 186, to: 192 });
  });

  it('lists silences in frame order whatever the cue order', () => {
    const input = validInput();

    expect(
      defineFilm({ ...input, cues: input.cues.toReversed() }).silences.map(
        (silence) => silence.cueId
      )
    ).toEqual(['gap', 'tail']);
  });
});

describe('duration', () => {
  it('counts 75 beats at 24 frames per beat as 1800 frames at 150 BPM, ending mid-bar', () => {
    const input: FilmSpecInput = {
      ...validInput(),
      beats: 75,
      shots: [{ id: 'whole', fromBeat: 0, toBeat: 75, reads: [] }],
      text: [],
    };

    expect(defineFilm(input)).toMatchObject({ durationInFrames: 1800, bpm: 150 });
  });
});
