import { claimsGate } from '../layout/claims.js';

import { audioGate } from './audio.js';
import { containmentGate, contrastGate } from './contrast.js';
import { finalFileGate } from './final-file.js';
import { flashGate } from './flashes.js';
import { framesGate } from './frames.js';
import { purityGate } from './purity.js';
import { restingMarkGate } from './resting-mark.js';
import { stillsMatchGate } from './stills-match.js';

import type { ClaimsEvidence } from '../layout/claims.js';
import type { AudioEvidence } from './audio.js';
import type { ClaimContrast, FrameContainment } from './contrast.js';
import type { FinalFileEvidence } from './final-file.js';
import type { Transition } from './flashes.js';
import type { FramesEvidence } from './frames.js';
import type { GateResult } from './gate.js';
import type { PurityFrame } from './purity.js';
import type { RestingMark } from './resting-mark.js';
import type { JudgedProbe } from './stills-match.js';

/** The gates `pnpm films verify` runs, in the order its report lists them. */
export const GATE_ORDER = [
  'purity',
  'claims',
  'contrast',
  'containment',
  'logo',
  'frames',
  'flashes',
  'stills-match',
  'audio',
  'final-file',
] as const;

/** Everything the gates read, decoded. */
export interface GateInputs {
  purity: readonly PurityFrame[];
  claims: ClaimsEvidence;
  contrast: readonly (readonly ClaimContrast[])[];
  containment: readonly FrameContainment[];
  logo: readonly RestingMark[];
  frames: FramesEvidence;
  transitions: readonly Transition[];
  judged: readonly JudgedProbe[];
  audio: AudioEvidence;
  finalFile: FinalFileEvidence;
}

/** Every gate over its decoded inputs, in {@link GATE_ORDER}. */
export function allGates(filmId: string, inputs: GateInputs): GateResult[] {
  return [
    purityGate(filmId, inputs.purity),
    claimsGate(filmId, inputs.claims),
    contrastGate(filmId, inputs.contrast),
    containmentGate(filmId, inputs.containment),
    restingMarkGate(filmId, inputs.logo),
    framesGate(filmId, inputs.frames),
    flashGate(filmId, inputs.transitions),
    stillsMatchGate(filmId, inputs.judged),
    audioGate(filmId, inputs.audio),
    finalFileGate(filmId, inputs.finalFile),
  ];
}
