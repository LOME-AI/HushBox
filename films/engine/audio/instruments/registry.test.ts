import { describe, expect, it } from 'vitest';

import { rand } from '../../rand/rand.js';

import { braam } from './braam.js';
import { clap } from './clap.js';
import { fmBell } from './fm-bell.js';
import { hat } from './hat.js';
import { INSTRUMENTS } from './index.js';
import { firstOnset, renderWith } from './instrument-test-support.js';
import { kick } from './kick.js';
import { organ } from './organ.js';
import { pad } from './pad.js';
import { snare } from './snare.js';
import { sub808 } from './sub808.js';
import { supersaw } from './supersaw.js';
import { tom } from './tom.js';

import type { Instrument, InstrumentName } from './index.js';

const MUSIC: readonly (readonly [InstrumentName, Instrument])[] = [
  ['kick', kick],
  ['snare', snare],
  ['clap', clap],
  ['hat', hat],
  ['tom', tom],
  ['sub808', sub808],
  ['organ', organ],
  ['pad', pad],
  ['supersaw', supersaw],
  ['braam', braam],
  ['fmBell', fmBell],
];

/**
 * Every entry's declaration: percussive exactly when its first sample above
 * −60 dBFS falls on its anchor for every seed at every legal parameter set.
 * `registry.property.test.ts` holds the true ones to that across seeds at the
 * corners of their parameters; {@link OFF_ANCHOR} shows each false one heard off
 * its anchor.
 */
const DECLARED = {
  kick: true,
  snare: true,
  clap: true,
  hat: true,
  tom: true,
  sub808: false,
  organ: false,
  pad: false,
  supersaw: false,
  braam: false,
  fmBell: false,
  riser: false,
  downlifter: true,
  whoosh: false,
  impact: true,
  reverseSwell: false,
  tick: true,
  pop: true,
  subPulse: false,
  heartbeat: true,
  roomTone: false,
  matchStrike: true,
  typewriter: true,
  carriageBell: true,
  snap: true,
  glassShatter: true,
  shriek: false,
  fireRoar: false,
  snuff: false,
  crack: true,
  rumble: false,
} satisfies Record<InstrumentName, boolean>;

/**
 * For each entry declared not percussive, parameters and a seed at which its
 * first sample above −60 dBFS falls off its anchor. The organ's and the FM
 * bell's keys name seeds found to start late; on most seeds both start on the
 * anchor, so each is a witness that the sound is not percussive, not that it is
 * sustained.
 */
const OFF_ANCHOR: readonly (readonly [InstrumentName, Record<string, unknown>, string])[] = [
  ['sub808', {}, 'contract'],
  ['organ', {}, 'late-5'],
  ['pad', {}, 'contract'],
  ['supersaw', {}, 'contract'],
  ['braam', {}, 'contract'],
  ['fmBell', { note: 48, decay: 0.1 }, 'late-1810'],
  ['riser', {}, 'contract'],
  ['whoosh', {}, 'contract'],
  ['reverseSwell', {}, 'contract'],
  ['subPulse', {}, 'contract'],
  ['roomTone', {}, 'contract'],
  ['shriek', {}, 'contract'],
  ['fireRoar', {}, 'contract'],
  ['snuff', {}, 'contract'],
  ['rumble', {}, 'contract'],
];

function byName(a: string, b: string): number {
  return a.localeCompare(b);
}

describe('INSTRUMENTS, percussive declarations', () => {
  const declared = new Map<string, boolean>(Object.entries(DECLARED));

  it.each(Object.entries(INSTRUMENTS))(
    '%s declares whether it is percussive',
    (name, instrument) => {
      expect(instrument.percussive).toBe(declared.get(name));
    }
  );

  it('witnesses every entry declared not percussive heard off its anchor', () => {
    const sustained = Object.entries(INSTRUMENTS)
      .filter(([, instrument]) => !instrument.percussive)
      .map(([name]) => name);
    expect(OFF_ANCHOR.map(([name]) => name).toSorted(byName)).toEqual(sustained.toSorted(byName));
  });

  it.each(OFF_ANCHOR)('%s at %j, seed %s, is first heard off its anchor', (name, raw, key) => {
    const { buffer, anchorOffset } = renderWith(INSTRUMENTS[name], raw, { key });
    expect(firstOnset(buffer)).not.toBe(anchorOffset);
  });
});

describe('INSTRUMENTS', () => {
  it.each(MUSIC)('registers %s under its name', (name, instrument) => {
    expect(INSTRUMENTS[name]).toBe(instrument);
  });

  it.each(MUSIC)('fills every parameter of %s from its defaults', (name) => {
    expect(INSTRUMENTS[name].params.safeParse({}).success).toBe(true);
  });

  it.each(MUSIC)('%s refuses a tempo of NaN frames per beat', (name) => {
    const instrument: Instrument = INSTRUMENTS[name];
    expect(() =>
      instrument.render(instrument.params.parse({}), {
        rand: rand('registry'),
        framesPerBeat: Number.NaN,
      })
    ).toThrow(/framesPerBeat/);
  });

  it('renders a registered instrument through its own schema, by name alone', () => {
    const name: InstrumentName = 'snare';
    const instrument: Instrument = INSTRUMENTS[name];
    const rendered = instrument.render(instrument.params.parse({ decay: 0.1 }), {
      rand: rand('registry'),
      framesPerBeat: 24,
    });
    expect(rendered.buffer.left.length).toBeGreaterThan(0);
  });
});
