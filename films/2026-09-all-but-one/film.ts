import { defineFilm } from '../engine/film/spec.js';
import { BEATS, CUES, GRID, SCORE } from './score.js';

import type { FilmDefinition, FilmSpecInput } from '../engine/film/spec.js';

type Basis = NonNullable<FilmSpecInput['text'][number]['basis']>;

/** The Devil in character, and what he says of AI companies in general. */
const OPINION: Basis = { kind: 'opinion' };
const STORY: Basis = {
  kind: 'brand',
  source:
    'films/2026-09-all-but-one/brief.md: the interview, the Devil, and the one company he cannot use',
};
const ENCRYPTED: Basis = {
  kind: 'fact',
  source:
    'apps/api/src/slices/chat/domain/messages/message-write.ts (persistEncryptedMessage): every message is encrypted under a fresh content key, wrapped to the conversation\'s epoch public key, before its row is written; README.md:56, "Your messages are encrypted ... before they\'re stored."',
};
const UNREADABLE: Basis = {
  kind: 'fact',
  source:
    'README.md:58, "Our servers can\'t read your stored conversations because they never hold the decryption key."; the server holds only the epoch public key (apps/api/src/slices/chat/domain/messages/message-write.ts), and stored messages are decrypted in the web client (apps/web/src/hooks/crypto/use-decrypted-messages.ts). Scoped to stored chats: the server reads a message in flight for inference (README.md:60).',
};
const NOT_SOLD: Basis = {
  kind: 'fact',
  source:
    'the privacy policy at hushbox.ai/privacy (apps/marketing/src/pages/privacy.astro, which renders PRIVACY_SECTIONS from packages/shared/src/legal/privacy-sections.ts), "How We Use Your Data": "We do not sell your data." A policy commitment: no code can prove it.',
};
const WORDMARK: Basis = {
  kind: 'brand',
  source: 'packages/ui/src/components/composites/logo.tsx: Hush, then Box in the brand red',
};
const TAGLINE: Basis = {
  kind: 'brand',
  source: 'packages/shared/src/brand/tagline.ts (PRODUCT_TAGLINE_SENTENCES)',
};

type TextRow = FilmSpecInput['text'][number];
type ShotRow = NonNullable<FilmSpecInput['shots']>[number];

/** A text row as the film writes it: its span as a pair of beats, a headline unless it says otherwise. */
interface Line {
  id: string;
  shotId: string;
  words: string;
  beats: readonly [number, number];
  basis: Basis;
  role?: TextRow['role'];
}

function line({
  id,
  shotId,
  words,
  beats: [inBeat, outBeat],
  basis,
  role = 'headline',
}: Line): TextRow {
  return { id, shotId, words, role, inBeat, outBeat, basis };
}

/** A shot as the film writes it: its span as a pair of beats, and each read as a triple of beats and words. */
interface Shot {
  id: string;
  beats: readonly [number, number];
  reads: readonly (readonly [number, number, string])[];
  framing: string;
  camera: string;
  event: string;
  seam: string;
}

function shot({
  id,
  beats: [fromBeat, toBeat],
  reads,
  framing,
  camera,
  event,
  seam,
}: Shot): ShotRow {
  return {
    id,
    fromBeat,
    toBeat,
    reads: reads.map(([a, b, what]) => ({ fromBeat: a, toBeat: b, what })),
    framing,
    camera,
    event,
    seam,
  };
}

const SHOTS: ShotRow[] = [
  shot({
    id: 'file',
    beats: [0, 4],
    reads: [
      [0, 2.5, 'the question types: DO YOU LIKE AI COMPANIES?'],
      [2.5, 4, 'two eyes open in the dark and fix on you'],
    ],
    framing: 'black; the interview file HUD; the question in the safe box',
    camera: 'a slow push into the dark',
    event: 'the question types itself; on 2.5 two eyes snap open and track the viewer',
    seam: 'the lamp comes up',
  }),
  shot({
    id: 'of-course',
    beats: [4, 8],
    reads: [
      [4, 6, 'OF COURSE I DO.'],
      [6, 8, 'his smirk splits into a grin, one brow arching'],
    ],
    framing: 'close on his face under the lamp, eyes on the viewer',
    camera: 'slow push, the eyes tracking against it',
    event:
      'the lamp comes up on him; the head tilts while the eyes stay on you; on 6 the closed smirk splits into the full grin and his left brow arches',
    seam: 'hard cut',
  }),
  shot({
    id: 'not-to-like',
    beats: [8, 12],
    reads: [
      [8, 10.5, 'WHAT\u2019S NOT TO LIKE? the jaw opens on rows of teeth'],
      [10.5, 12, 'the jaw snaps shut at the lens'],
    ],
    framing: 'extreme close on the mouth',
    camera: 'creep in; a punch on the chomp',
    event:
      'the jaw opens slowly on row after row of teeth and snaps shut on 10.5, the eyes narrowing',
    seam: 'hard cut',
  }),
  shot({
    id: 'save',
    beats: [12, 15],
    reads: [[12, 15, 'THEY SAVE ALL YOUR DATA: messages file into an archive']],
    framing: 'wide: an archive wall, messages dropping into drawers',
    camera: 'tilt down the wall',
    event: 'personal messages fall into the drawers on the 16ths; the counter climbs',
    seam: 'hard cut',
  }),
  shot({
    id: 'watch',
    beats: [15, 18],
    reads: [[15, 18, 'THEY WATCH FOR WRONG OPINIONS: the eye stamps thoughts FLAGGED']],
    framing: 'navy radar: a giant eye, scribbled thought bubbles orbiting',
    camera: 'slow orbit roll',
    event: 'the eye opens; the sweep stamps a thought FLAGGED on each half beat from 16',
    seam: 'hard cut',
  }),
  shot({
    id: 'leak',
    beats: [18, 21],
    reads: [
      [18, 19, 'AND THEY LEAK IT: the eye stares, close'],
      [19, 21, 'the lids snap shut into a seam of light, which kinks into a crack'],
    ],
    framing: 'extreme close: the watching eye',
    camera: 'creep in; a punch on each crack',
    event:
      'the iris darts; on 19 the lids snap shut into a white-hot seam across the frame; on 20 the seam kinks into a zig-zag crack that opens and throws off branch cracks',
    seam: 'hard cut',
  }),
  shot({
    id: 'world-to-see',
    beats: [21, 24],
    reads: [
      [21, 23.5, 'FOR THE WORLD TO SEE. over the crack, which opens wider on each hit'],
      [23.5, 24, 'the crack draws in, dark, in silence'],
    ],
    framing: 'black: the crack across the frame, the copy high',
    camera: 'push on each crack; inhale on the silence',
    event:
      'the crack opens wider on 22 and 23, its branches running further; on 23.5 it draws in to a dark line in silence; on 24 it bursts',
    seam: 'the crack bursts and the flock escapes',
  }),
  shot({
    id: 'flock',
    beats: [24, 32],
    reads: [
      [24, 24.25, 'a seam of light bursts where his eyes were'],
      [24.25, 26.25, 'a demon carries a secret: I’m in love with my best friend.'],
      [26.5, 28.5, 'a demon carries a secret: I practise my Oscar speech in the shower.'],
      [28.75, 30.75, 'a demon carries a secret: I still have the other phone.'],
      [30.75, 32, 'the flock lines up as the Devil’s face'],
    ],
    framing: 'hellfire dark: a flock of demons, each built differently, three heroes close',
    camera:
      'snaps back on the drop, dives into the flock rolled, pulls wide, pushes on the second secret, settles for the face',
    event:
      'the leaked secrets burst out as small chat bubbles that grow horns, wings, ember eyes and teeth; each hero demon carries its secret written across its body; one demon crosses the lens huge; the flock spirals in and lines up as the outline, horns and grin of his face',
    seam: 'the flock merges into his face',
  }),
  shot({
    id: 'laugh',
    beats: [32, 35],
    reads: [
      [32, 33.75, 'the Devil laughs in a halo of the demons he has gathered'],
      [33.75, 34, 'he freezes'],
      [34, 35, 'his collection spreads into a field of gold marks and his face looms behind it'],
    ],
    framing: 'the Devil full face, the halo',
    camera:
      'push in; a snap still on 33.75; then an eased move out as his face grows vast behind the field',
    event:
      'the flock merges into his laughing face and the demons he has gathered ring him; on 33.75 everything stops dead; from 34 each demon of the halo flies out and becomes a small gold mark, hundreds more light around them, and his face grows vast and dims behind them: his collection, every AI company',
    seam: 'into the field',
  }),
  shot({
    id: 'all-of-them',
    beats: [35, 41],
    reads: [
      [35, 36, 'the question types: ALL OF THEM? over his field of gold marks'],
      [36, 39, 'his searchlights land mark after mark, each taking his brand, faster and faster'],
      [39, 40.5, 'the whole field ablaze in gold, but one dark slot'],
      [40.5, 41, 'silence, dark'],
    ],
    framing:
      'his collection: a field of gold marks, every one different, far larger than the frame; his vast face dim behind, his eyes throwing two searchlights',
    camera:
      'pulls out to show the field\u2019s size, then flies through it: a dive (36), a whip (37), a second whip (38), a pull back (39) and a rush at the dark slot (39.5)',
    event:
      'each mark his light lands on flares white and takes his brand, two in the first region, four in the second, eight in the third; on 39 the whole field ignites gold in a wave; the slot stays dark and his light judders off it; on 40.5 everything drops dark in silence',
    seam: 'the drop',
  }),
  shot({
    id: 'all-but-one',
    beats: [41, 44],
    reads: [
      [41, 41.5, 'the slot lights Signal Red and a shockwave blows his field apart'],
      [41.5, 42.5, 'ALL BUT ONE.'],
      [42.5, 44, 'his claw reaches for it and burns white-hot; he recoils'],
    ],
    framing: 'close on the red HushBox mark as his field burns away, his face dim behind',
    camera: 'a slow push',
    event:
      'on 41 the HushBox mark lights, exact, and a white-hot shockwave throws the gold marks outward and burns them to embers; on 42.5 his claw reaches in; on 43 it touches the mark and burns white-hot, ash falling; his face turns to fear',
    seam: 'hard cut',
  }),
  shot({
    id: 'encrypted',
    beats: [44, 48],
    reads: [
      [44, 44.5, 'THEY ENCRYPT IT BEFORE IT’S STORED.'],
      [44.5, 46, 'the flock’s first secret slams in, readable'],
      [46, 48, 'the red ring closes, the message scrambles, the padlock snaps'],
    ],
    framing: 'charcoal, a message bubble high, the claim under it',
    camera: 'slow push; a punch-in cut on the padlock at 47',
    event:
      'the claim lands alone; the message slams in (44.5); the ring closes and the letters scramble (46); the padlock snaps (46.5)',
    seam: 'hard cut',
  }),
  shot({
    id: 'flinch',
    beats: [48, 50],
    reads: [
      [48, 49, 'he flinches: his eyes snap wide'],
      [49, 50, 'he winces: lids squeeze, brows knot'],
    ],
    framing: 'daylight paper: extreme close on his eyes',
    camera: 'push; he jerks back on the hit; a punch-in cut on 49',
    event: 'the eyes snap wide; on 49 the lids squeeze and the brows knot',
    seam: 'hard cut',
  }),
  shot({
    id: 'unreadable',
    beats: [50, 54],
    reads: [[50, 54, 'THEY CAN’T READ YOUR STORED CHATS: a wall of locked cipher']],
    framing: 'charcoal, the archive, every drawer cipher',
    camera: 'track right; a punch-in cut at 52',
    event: 'a red lock snaps onto every drawer in a wave',
    seam: 'hard cut',
  }),
  shot({
    id: 'lens',
    beats: [54, 56],
    reads: [[54, 56, 'his lens finds only noise: NO KEY']],
    framing: 'the Devil behind his gold lens',
    camera: 'drift with the lens',
    event: 'the lens swings up (54), NO KEY springs up (55), he recoils',
    seam: 'hard cut',
  }),
  shot({
    id: 'not-for-sale',
    beats: [56, 60],
    reads: [
      [56, 56.5, 'AND YOUR CHATS AREN’T FOR SALE.'],
      [56.5, 57.75, 'the SOLD stamp slams, slams again and cracks'],
      [57.75, 60, 'it flies apart'],
    ],
    framing: 'a page in a red frame, the gold SOLD stamp above',
    camera: 'shake on the blows, a punch-in cut at 58.5',
    event:
      'the claim lands alone (56); the stamp drops and slams (56.5), slams again and cracks (57.25), holds cracked, and flies apart (57.75)',
    seam: 'hard cut',
  }),
  shot({
    id: 'which-one',
    beats: [60, 63],
    reads: [
      [60, 61, 'the question types: WHICH ONE?'],
      [61, 62.5, 'he screams and tears apart into a red spiral'],
      [62.5, 63, 'the spiral collapses to one red dot'],
    ],
    framing: 'charcoal: the Devil full face in terror',
    camera: 'push into the mouth',
    event:
      'the question lands and is backspaced; he screams; from 62 his strokes spiral in; on 62.5 everything collapses to a dot in silence',
    seam: 'the dot bursts into the mark',
  }),
  shot({
    id: 'mark',
    beats: [63, 75],
    reads: [
      [63, 64, 'the dot bursts into the mark’s parts, which settle on the logo'],
      [64, 65, 'HushBox, then the tagline'],
      [65, 75, 'the end card holds still: One interface. Every feature. Private.'],
    ],
    framing: 'the Signal Red mark, the wordmark under it, the tagline under that',
    camera: 'a pull back that lands by 64.5, then no camera move',
    event:
      'the dot bursts on 63; each part of the mark flies out on its own arc and settles on the exact logo by 64.5; HushBox lands on 64 and the tagline on 64.5; from there the card holds still to the end, embers drifting and the rays turning slowly behind it',
    seam: 'end',
  }),
];

const TEXT: TextRow[] = [
  line({
    id: 'q1',
    shotId: 'file',
    words: 'DO YOU LIKE AI COMPANIES?',
    beats: [0, 4],
    basis: STORY,
    role: 'support',
  }),
  line({ id: 'a1', shotId: 'of-course', words: 'OF COURSE I DO.', beats: [4, 8], basis: OPINION }),
  line({
    id: 'a2',
    shotId: 'not-to-like',
    words: 'WHAT’S NOT TO LIKE?',
    beats: [8, 12],
    basis: OPINION,
  }),
  line({
    id: 'a3',
    shotId: 'save',
    words: 'THEY SAVE ALL YOUR DATA.',
    beats: [12, 15],
    basis: OPINION,
  }),
  line({ id: 'a4a', shotId: 'watch', words: 'THEY WATCH FOR', beats: [15, 18], basis: OPINION }),
  line({ id: 'a4b', shotId: 'watch', words: 'WRONG OPINIONS.', beats: [15, 18], basis: OPINION }),
  line({ id: 'a5', shotId: 'leak', words: 'AND THEY LEAK IT', beats: [18, 21], basis: OPINION }),
  line({
    id: 'a6',
    shotId: 'world-to-see',
    words: 'FOR THE WORLD TO SEE.',
    beats: [21, 24],
    basis: OPINION,
  }),
  line({
    id: 'q2',
    shotId: 'all-of-them',
    words: 'ALL OF THEM?',
    beats: [35, 38],
    basis: STORY,
    role: 'support',
  }),
  line({ id: 'a7', shotId: 'all-but-one', words: 'ALL BUT ONE.', beats: [41.5, 44], basis: STORY }),
  line({
    id: 'v1a',
    shotId: 'encrypted',
    words: 'THEY ENCRYPT IT',
    beats: [44, 48],
    basis: ENCRYPTED,
  }),
  line({
    id: 'v1b',
    shotId: 'encrypted',
    words: 'BEFORE IT’S STORED.',
    beats: [44, 48],
    basis: ENCRYPTED,
  }),
  line({
    id: 'v2a',
    shotId: 'unreadable',
    words: 'THEY CAN’T READ',
    beats: [50, 54],
    basis: UNREADABLE,
  }),
  line({
    id: 'v2b',
    shotId: 'unreadable',
    words: 'YOUR STORED CHATS.',
    beats: [50, 54],
    basis: UNREADABLE,
  }),
  line({
    id: 'v3a',
    shotId: 'not-for-sale',
    words: 'AND YOUR CHATS',
    beats: [56, 60],
    basis: NOT_SOLD,
  }),
  line({
    id: 'v3b',
    shotId: 'not-for-sale',
    words: 'AREN’T FOR SALE.',
    beats: [56, 60],
    basis: NOT_SOLD,
  }),
  line({
    id: 'q3',
    shotId: 'which-one',
    words: 'WHICH ONE?',
    beats: [60, 63],
    basis: STORY,
    role: 'support',
  }),
  line({ id: 'wordmark', shotId: 'mark', words: 'HushBox', beats: [64, 75], basis: WORDMARK }),
  line({ id: 'tag-1', shotId: 'mark', words: 'One interface.', beats: [64.5, 75], basis: TAGLINE }),
  line({ id: 'tag-2', shotId: 'mark', words: 'Every feature.', beats: [64.5, 75], basis: TAGLINE }),
  line({ id: 'tag-3', shotId: 'mark', words: 'Private.', beats: [64.5, 75], basis: TAGLINE }),
];

/**
 * The film's spec and score. The CLI and the registry load this module by path.
 * @toolContract
 */
export const definition: FilmDefinition = {
  spec: defineFilm({
    id: '2026-09-all-but-one',
    title: 'All But One',
    // The seed the approved take was rendered with: it keys every sound of the score and the dither, so changing it changes every sample.
    // The look never reads it: its random values come from kit.ts's `hash`.
    seed: 'all-but-one/interview-cut',
    grid: GRID,
    beats: BEATS,
    shots: SHOTS,
    text: TEXT,
    cues: CUES,
  }),
  score: SCORE,
};
