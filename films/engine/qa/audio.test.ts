import { describe, expect, it } from 'vitest';

import { FPS, SAMPLE_RATE, SAMPLES_PER_FRAME } from '../time/grid.js';
import { audioGate, levelFailures, startleFailure } from './audio.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { AudioEvidence, MasterLevels } from './audio.js';

const SECONDS = 4;
const LENGTH = SECONDS * SAMPLE_RATE;
/** The peak of a 1 kHz sine that reads −14 LUFS in stereo. */
const TARGET_PEAK = 10 ** (-14 / 20);
const QUIET_PEAK = 10 ** (-40 / 20);

/** A 1 kHz stereo sine whose peak at each sample is `peakAt(sample)`. */
function sine(peakAt: (sample: number) => number, length = LENGTH): StereoBuffer {
  const left = Float32Array.from(
    { length },
    (_, sample) => peakAt(sample) * Math.sin((2 * Math.PI * 1000 * sample) / SAMPLE_RATE)
  );
  return { left, right: Float32Array.from(left) };
}

const STEADY = sine(() => TARGET_PEAK);
/** Quiet for the first two seconds, then at the target. */
const STEP_UP = sine((sample) => (sample < 2 * SAMPLE_RATE ? QUIET_PEAK : TARGET_PEAK));
const STEP_FRAME = 2 * FPS;

/** A stem silent until `onset`, then a full-scale click. */
function stem(onset: number): StereoBuffer {
  const left = new Float32Array(LENGTH);
  left[onset] = 0.5;
  return { left, right: Float32Array.from(left) };
}

function evidence(overrides: Partial<AudioEvidence> = {}): AudioEvidence {
  return {
    cues: [{ id: 'beat', from: 60, kind: 'hit' }],
    silences: [],
    master: STEADY,
    placements: [{ track: 'click', cueId: 'beat', sample: 60 * SAMPLES_PER_FRAME }],
    percussive: [{ track: 'click', gain: 1, stem: stem(60 * SAMPLES_PER_FRAME) }],
    ...overrides,
  };
}

function failuresOf(overrides: Partial<AudioEvidence>, rule: string): string[] {
  return audioGate('film', evidence(overrides)).failures.filter((line) =>
    line.startsWith(`film: ${rule}:`)
  );
}

/** The steady sine's integrated loudness, from which each bound's gain is set. */
function gainTo(lufs: number): number {
  const reading = audioGate('film', evidence()).measured[1] ?? '';
  const measured = Number(/integrated (-?\d+\.\d+) LUFS/.exec(reading)?.[1]);
  return 10 ** ((lufs - measured) / 20);
}

function loudnessLines(lufs: number): string[] {
  const gain = gainTo(lufs);
  return failuresOf({ master: sine(() => TARGET_PEAK * gain) }, 'loudness');
}

/** A 60 Hz low band whose channels correlate by `correlation`. */
/** The phase of a 60 Hz tone at a sample. */
function lowPhase(sample: number): number {
  return (2 * Math.PI * 60 * sample) / SAMPLE_RATE;
}

function lowBand(correlation: number): StereoBuffer {
  const phase = lowPhase;
  const left = Float32Array.from(
    { length: LENGTH },
    (_, sample) => TARGET_PEAK * Math.sin(phase(sample))
  );
  const right = Float32Array.from(
    { length: LENGTH },
    (_, sample) =>
      TARGET_PEAK *
      (correlation * Math.sin(phase(sample)) +
        Math.sqrt(1 - correlation ** 2) * Math.cos(phase(sample)))
  );
  return { left, right };
}

/** Quiet for two seconds, then `db` louder. */
function stepBy(db: number): StereoBuffer {
  return sine((sample) => (sample < 2 * SAMPLE_RATE ? QUIET_PEAK : QUIET_PEAK * 10 ** (db / 20)));
}

describe('audioGate: a master that keeps every rule', () => {
  it('passes', () => {
    expect(audioGate('film', evidence()).failures).toEqual([]);
  });
});

describe('audioGate: placements', () => {
  it('fails a placement off its cue sample, naming the cue and the track', () => {
    const placements = [{ track: 'click', cueId: 'beat', sample: 60 * SAMPLES_PER_FRAME + 1 }];

    expect(failuresOf({ placements }, 'placement')).toEqual([
      'film: placement: cue "beat", track "click": placed at sample 48001, not the cue\'s sample 48000',
    ]);
  });

  it('fails a placement naming a cue the film does not declare', () => {
    const placements = [{ track: 'click', cueId: 'ghost', sample: 0 }];

    expect(failuresOf({ placements }, 'placement')[0]).toContain('names no cue of the film');
  });

  it('fails a placement off the master', () => {
    const placements = [{ track: 'click', cueId: null, sample: LENGTH + 1 }];

    expect(failuresOf({ placements }, 'placement')[0]).toContain(
      `is not a whole sample of the master's ${String(LENGTH)}`
    );
  });

  it("accepts a placement on the master's end boundary", () => {
    const placements = [{ track: 'click', cueId: null, sample: LENGTH }];

    expect(failuresOf({ placements }, 'placement')).toEqual([]);
  });
});

describe('audioGate: percussive stems', () => {
  it('fails a percussive stem heard one sample late, naming the track', () => {
    const percussive = [{ track: 'click', gain: 1, stem: stem(60 * SAMPLES_PER_FRAME + 1) }];

    expect(failuresOf({ percussive }, 'stem-onset')).toEqual([
      'film: stem-onset: track "click": first onset at sample 48001, not its scheduled sample 48000',
    ]);
  });

  it('fails a percussive stem heard one sample early', () => {
    const percussive = [{ track: 'click', gain: 1, stem: stem(60 * SAMPLES_PER_FRAME - 1) }];

    expect(failuresOf({ percussive }, 'stem-onset')).toHaveLength(1);
  });

  it('measures the onset relative to the track gain', () => {
    const quiet = stem(60 * SAMPLES_PER_FRAME);
    quiet.left[60 * SAMPLES_PER_FRAME] = 0.000_05;
    const percussive = [{ track: 'click', gain: 0.01, stem: quiet }];

    expect(failuresOf({ percussive }, 'stem-onset')).toEqual([]);
  });

  it('fails a percussive stem that is never heard', () => {
    const percussive = [{ track: 'click', gain: 1, stem: sine(() => 0) }];

    expect(failuresOf({ percussive }, 'stem-onset')[0]).toContain('never rises above −60 dB');
  });
});

describe('audioGate: master levels', () => {
  it('fails integrated loudness outside −14 ±0.5 LUFS', () => {
    expect(failuresOf({ master: sine(() => TARGET_PEAK / 2) }, 'loudness')[0]).toMatch(
      /^film: loudness: master: integrated loudness -20\.0\d LUFS is outside -14 ±0\.5 LUFS$/
    );
  });

  it('fails a true peak above −1 dBTP', () => {
    const master = sine(() => TARGET_PEAK);
    master.left[1000] = 0.95;

    expect(failuresOf({ master }, 'true-peak')[0]).toMatch(
      /true peak -0\.\d+ dBTP is above -1 dBTP/
    );
  });

  it('fails a sample at full scale', () => {
    const master = sine(() => TARGET_PEAK);
    master.left[1000] = 1;

    expect(failuresOf({ master }, 'clips')[0]).toBe(
      'film: clips: master: 1 sample at or beyond full scale'
    );
  });

  it('fails a DC offset of 0.001', () => {
    const master = sine(() => TARGET_PEAK);
    master.right = master.right.map((sample) => sample + 0.001);

    expect(failuresOf({ master }, 'dc-offset')[0]).toContain('right channel mean 0.00100');
  });

  it('fails a low band out of phase between the channels', () => {
    const left = Float32Array.from(
      { length: LENGTH },
      (_, sample) => TARGET_PEAK * Math.sin((2 * Math.PI * 60 * sample) / SAMPLE_RATE)
    );
    const master = { left, right: left.map((sample) => -sample) };

    expect(failuresOf({ master }, 'low-band')[0]).toContain('below 0.9');
  });
});

describe('audioGate: level bounds', () => {
  it.each([-14.49, -13.51])('accepts integrated loudness of %s LUFS', (lufs) => {
    expect(loudnessLines(lufs)).toEqual([]);
  });

  it.each([-14.51, -13.49])('refuses integrated loudness of %s LUFS', (lufs) => {
    expect(loudnessLines(lufs)).toHaveLength(1);
  });

  it('refuses a silent master, whose loudness is no number', () => {
    expect(failuresOf({ master: sine(() => 0) }, 'loudness')).toHaveLength(1);
  });

  it('accepts a true peak of −1.01 dBTP', () => {
    expect(failuresOf({ master: sine(() => 10 ** (-1.01 / 20)) }, 'true-peak')).toEqual([]);
  });

  it('refuses a true peak of −0.99 dBTP', () => {
    expect(failuresOf({ master: sine(() => 10 ** (-0.99 / 20)) }, 'true-peak')).toHaveLength(1);
  });

  it('accepts a sample just under full scale', () => {
    const master = sine(() => TARGET_PEAK);
    master.left[1000] = 0.999_999_94;

    expect(failuresOf({ master }, 'clips')).toEqual([]);
  });

  it('accepts a DC offset just under 0.001', () => {
    const master = sine(() => TARGET_PEAK);
    master.right = master.right.map((sample) => sample + 0.000_999);

    expect(failuresOf({ master }, 'dc-offset')).toEqual([]);
  });

  it('accepts a low-band correlation just over 0.9', () => {
    expect(failuresOf({ master: lowBand(0.905) }, 'low-band')).toEqual([]);
  });

  it('refuses a low-band correlation just under 0.9', () => {
    expect(failuresOf({ master: lowBand(0.895) }, 'low-band')).toHaveLength(1);
  });
});

/** Levels every rule accepts. */
const PASSING_LEVELS: MasterLevels = {
  integratedLufs: -14,
  truePeakDbtp: -2,
  clips: 0,
  dc: { left: 0, right: 0 },
  lowBandCorrelation: 1,
};

function levelRules(levels: Partial<MasterLevels>): string[] {
  return levelFailures('film', { ...PASSING_LEVELS, ...levels }).failures.map(({ rule }) => rule);
}

describe('levelFailures: measures that are not numbers', () => {
  it('passes levels every rule accepts', () => {
    expect(levelRules({})).toEqual([]);
  });

  it('refuses a loudness that is not a number', () => {
    expect(levelRules({ integratedLufs: Number.NaN })).toEqual(['loudness']);
  });

  it('refuses a true peak that is not a number', () => {
    expect(levelRules({ truePeakDbtp: Number.NaN })).toEqual(['true-peak']);
  });

  it('refuses a clip count that is not a number', () => {
    expect(levelRules({ clips: Number.NaN })).toEqual(['clips']);
  });

  it('refuses a DC offset that is not a number', () => {
    expect(levelRules({ dc: { left: Number.NaN, right: 0 } })).toEqual(['dc-offset']);
  });

  it('refuses a low-band correlation that is not a number', () => {
    expect(levelRules({ lowBandCorrelation: Number.NaN })).toEqual(['low-band']);
  });

  it('accepts a silent low band, which has no correlation', () => {
    expect(levelRules({ lowBandCorrelation: null })).toEqual([]);
  });
});

describe('audioGate: startle', () => {
  const cues = [{ id: 'drop', from: STEP_FRAME, kind: 'hit' as const }];

  it('fails a rise of more than 6 dB into a cue, naming the cue', () => {
    expect(
      failuresOf({ master: STEP_UP, cues, placements: [], percussive: [] }, 'startle')[0]
    ).toMatch(
      /^film: startle: cue "drop": momentary loudness rises \d+\.\d dB from the second before to the 400 ms after, more than 6 dB$/
    );
  });

  it('accepts a rise of 5.9 dB into a cue', () => {
    expect(
      failuresOf({ master: stepBy(5.9), cues, placements: [], percussive: [] }, 'startle')
    ).toEqual([]);
  });

  it('refuses a rise of 6.1 dB into a cue', () => {
    expect(
      failuresOf({ master: stepBy(6.1), cues, placements: [], percussive: [] }, 'startle')
    ).toHaveLength(1);
  });

  it('accepts the same rise into an impact cue', () => {
    const impact = [{ id: 'drop', from: STEP_FRAME, kind: 'impact' as const }];

    expect(
      failuresOf({ master: STEP_UP, cues: impact, placements: [], percussive: [] }, 'startle')
    ).toEqual([]);
  });

  it('accepts a rise 0.8 s after a silence span ends', () => {
    const silences = [{ cueId: 'hush', from: 0, to: STEP_FRAME - 0.8 * FPS }];

    expect(
      failuresOf({ master: STEP_UP, cues, silences, placements: [], percussive: [] }, 'startle')
    ).toEqual([]);
  });

  it('judges a rise one frame later than 0.8 s after a silence span ends', () => {
    const silences = [{ cueId: 'hush', from: 0, to: STEP_FRAME - 0.8 * FPS - 1 }];

    expect(
      failuresOf({ master: STEP_UP, cues, silences, placements: [], percussive: [] }, 'startle')
    ).toHaveLength(1);
  });

  it('accepts a rise within 0.8 s of the film starting, since before the film is silence', () => {
    const opening = [{ id: 'open', from: 0.8 * FPS, kind: 'hit' as const }];
    const master = sine((sample) => (sample < 0.8 * SAMPLE_RATE ? 0 : TARGET_PEAK));

    expect(
      failuresOf({ master, cues: opening, placements: [], percussive: [] }, 'startle')
    ).toEqual([]);
  });

  it('judges a rise from silence later than 0.8 s into the film', () => {
    const late = [{ id: 'late', from: 0.8 * FPS + 1, kind: 'hit' as const }];
    const start = (0.8 * FPS + 1) * SAMPLES_PER_FRAME;
    const master = sine((sample) => (sample < start ? 0 : TARGET_PEAK));

    expect(
      failuresOf({ master, cues: late, placements: [], percussive: [] }, 'startle')
    ).toHaveLength(1);
  });

  it('reports the largest rise into a cue it judged', () => {
    const measured = audioGate(
      'film',
      evidence({ master: STEP_UP, cues, placements: [], percussive: [] })
    ).measured;

    expect(measured.at(-1)).toMatch(
      /^largest rise into a judged cue \d+\.\d dB \(cue "drop"\); 0 cues exempt as impacts or returns from silence$/
    );
  });

  it('leaves exempt cues out of the largest rise', () => {
    const opening = [{ id: 'open', from: 0, kind: 'hit' as const }];
    const measured = audioGate(
      'film',
      evidence({ cues: opening, placements: [], percussive: [] })
    ).measured;

    expect(measured.at(-1)).toBe(
      'no cue judged for a rise; 1 cue exempt as an impact or a return from silence'
    );
  });

  it('passes a cue with digital silence on both sides, which is no rise', () => {
    const silent = sine(() => 0);
    const gate = audioGate(
      'film',
      evidence({ master: silent, cues, placements: [], percussive: [] })
    );

    expect([
      gate.failures.filter((line) => line.includes('startle')),
      gate.measured.at(-1),
    ]).toEqual([
      [],
      'largest rise into a judged cue 0.0 dB (cue "drop"); 0 cues exempt as impacts or returns from silence',
    ]);
  });

  it('fails a rise that is not a number, naming the film, the rule and the cue', () => {
    expect(startleFailure('film', { cueId: 'drop', rise: Number.NaN, exempt: false })).toEqual({
      filmId: 'film',
      rule: 'startle',
      at: 'cue "drop"',
      detail:
        'momentary loudness rises NaN dB from the second before to the 400 ms after, more than 6 dB',
    });
  });

  it('never fails a fall', () => {
    const falling = sine((sample) => (sample < 2 * SAMPLE_RATE ? TARGET_PEAK : QUIET_PEAK));

    expect(
      failuresOf({ master: falling, cues, placements: [], percussive: [] }, 'startle')
    ).toEqual([]);
  });

  it("passes over a cue on the film's end, which has nothing after it", () => {
    const end = [{ id: 'end', from: SECONDS * FPS, kind: 'hit' as const }];

    expect(failuresOf({ cues: end, placements: [], percussive: [] }, 'startle')).toEqual([]);
  });
});
