import { braam } from './braam.js';
import { clap } from './clap.js';
import { fmBell } from './fm-bell.js';
import { hat } from './hat.js';
import { kick } from './kick.js';
import { organ } from './organ.js';
import { pad } from './pad.js';
import { carriageBell } from './sfx/carriage-bell.js';
import { crack } from './sfx/crack.js';
import { downlifter } from './sfx/downlifter.js';
import { fireRoar } from './sfx/fire-roar.js';
import { glassShatter } from './sfx/glass-shatter.js';
import { heartbeat } from './sfx/heartbeat.js';
import { impact } from './sfx/impact.js';
import { matchStrike } from './sfx/match-strike.js';
import { pop } from './sfx/pop.js';
import { reverseSwell } from './sfx/reverse-swell.js';
import { riser } from './sfx/riser.js';
import { roomTone } from './sfx/room-tone.js';
import { rumble } from './sfx/rumble.js';
import { shriek } from './sfx/shriek.js';
import { snap } from './sfx/snap.js';
import { snuff } from './sfx/snuff.js';
import { subPulse } from './sfx/sub-pulse.js';
import { tick } from './sfx/tick.js';
import { typewriter } from './sfx/typewriter.js';
import { whoosh } from './sfx/whoosh.js';
import { snare } from './snare.js';
import { sub808 } from './sub808.js';
import { supersaw } from './supersaw.js';
import { tom } from './tom.js';

import type { Instrument } from './instrument.js';

/**
 * Every instrument, under the name a score calls it by. An instrument joins by
 * one entry here, and its key joins `InstrumentName` with it.
 */
const REGISTERED = {
  kick,
  snare,
  clap,
  hat,
  tom,
  sub808,
  organ,
  pad,
  supersaw,
  braam,
  fmBell,
  riser,
  downlifter,
  whoosh,
  impact,
  reverseSwell,
  tick,
  pop,
  subPulse,
  heartbeat,
  roomTone,
  matchStrike,
  typewriter,
  carriageBell,
  snap,
  glassShatter,
  shriek,
  fireRoar,
  snuff,
  crack,
  rumble,
} satisfies Record<string, Instrument>;

export type InstrumentName = keyof typeof REGISTERED;

export const INSTRUMENTS: Record<InstrumentName, Instrument> = REGISTERED;
