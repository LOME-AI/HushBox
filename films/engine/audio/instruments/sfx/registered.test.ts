import { describe, expect, it } from 'vitest';

import { rand } from '../../../rand/rand.js';
import { INSTRUMENTS } from '../index.js';

import { carriageBell } from './carriage-bell.js';
import { crack } from './crack.js';
import { downlifter } from './downlifter.js';
import { fireRoar } from './fire-roar.js';
import { glassShatter } from './glass-shatter.js';
import { heartbeat } from './heartbeat.js';
import { impact } from './impact.js';
import { matchStrike } from './match-strike.js';
import { pop } from './pop.js';
import { reverseSwell } from './reverse-swell.js';
import { riser } from './riser.js';
import { roomTone } from './room-tone.js';
import { rumble } from './rumble.js';
import { shriek } from './shriek.js';
import { snap } from './snap.js';
import { snuff } from './snuff.js';
import { subPulse } from './sub-pulse.js';
import { tick } from './tick.js';
import { typewriter } from './typewriter.js';
import { whoosh } from './whoosh.js';

import type { Instrument, InstrumentName } from '../index.js';

const SOUNDS: readonly (readonly [InstrumentName, Instrument])[] = [
  ['riser', riser],
  ['downlifter', downlifter],
  ['whoosh', whoosh],
  ['impact', impact],
  ['reverseSwell', reverseSwell],
  ['tick', tick],
  ['pop', pop],
  ['subPulse', subPulse],
  ['heartbeat', heartbeat],
  ['roomTone', roomTone],
  ['matchStrike', matchStrike],
  ['typewriter', typewriter],
  ['carriageBell', carriageBell],
  ['snap', snap],
  ['glassShatter', glassShatter],
  ['shriek', shriek],
  ['fireRoar', fireRoar],
  ['snuff', snuff],
  ['crack', crack],
  ['rumble', rumble],
];

describe('INSTRUMENTS, sound design', () => {
  it.each(SOUNDS)('registers %s under its name', (name, sound) => {
    expect(INSTRUMENTS[name]).toBe(sound);
  });

  it.each(SOUNDS)('fills every parameter of %s from its defaults', (name) => {
    expect(INSTRUMENTS[name].params.safeParse({}).success).toBe(true);
  });

  it.each(SOUNDS)('%s refuses a tempo of NaN frames per beat', (name) => {
    const sound: Instrument = INSTRUMENTS[name];
    expect(() =>
      sound.render(sound.params.parse({}), { rand: rand('registry'), framesPerBeat: Number.NaN })
    ).toThrow(/framesPerBeat/);
  });
});
