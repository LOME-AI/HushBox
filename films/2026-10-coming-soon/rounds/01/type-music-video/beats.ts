/**
 * The take's choreography: every beat a picture and a sound share, read by both
 * the score and the look, so a hit and its sound land on the same frame.
 */

/** 128.57 BPM: 28 frames a beat, a sixteenth every 7 frames, 64 beats (16 bars) in 29.87 s. */
export const FPB = 28;
export const BEATS = 64;

/** Beat to frame. */
export function bf(beat: number): number {
  return Math.round(beat * FPB);
}

/** The question she keeps deleting, and how it breaks across the composer's two lines. */
export const DOUBT = 'is it crazy to quit my job';
export const DOUBT_LINES = ['is it crazy', 'to quit my job'] as const;

/** The question she finally sends, and its two lines. */
export const WISH = 'how do I open a cinema?';
export const WISH_LINES = ['how do I open', 'a cinema?'] as const;

/**
 * The opening: she types the question with "lol" after it, the joke she hides behind. The typing
 * starts this many frames before the film, so frame 0 reads the whole question and "lol" types on.
 */
export const DOUBT_LEAD = 52;
export const OPENING_TEXT = `${DOUBT} lol`;
/** How the opening's text breaks across its composer; the deletion keeps the same composer. */
export const OPENING_LINES = ['is it crazy', 'to quit my', 'job lol'] as const;
/** She deletes "lol" on the half beat; it lands on the floor, large and loud, on beat 1. */
export const LOL_DELETE = 0.5;
export const LOL_FALL = 14;
/** Frames per typed character, at the open and when she finally asks. */
export const TYPE_FRAMES = 2;
/** The wish typed fast in the time-lapse: two characters a frame. */
export const WISH_FAST_FROM = bf(10);
/** She types the wish for good from here, a character every two frames. */
export const ASK_FROM = bf(12);

/** The doubt deleted word by word on the eighths, from the end; each word falls a beat. */
export const DELETE_WORDS: readonly (readonly [word: string, beat: number])[] = [
  ['job', 4],
  ['my', 4.5],
  ['quit', 5],
  ['to', 5.5],
  ['crazy', 6],
  ['it', 6.5],
  ['is', 7],
];
export const DELETE_FALL = FPB;

/** The time-lapse: the doubt dropped whole twice, then the wish once; each lands half a beat later. */
export const LAPSE_DROPS = [8.5, 9.5] as const;
export const WISH_DROP = 11;
export const DROP_FALL = FPB / 2;

/** The letters on the heap: the seen falls and the nights between them that the cuts skip. */
export const HEAP = {
  /** Slots 0–2: "lol". Slots 3–22: the first deletion. */
  first: 3,
  /** At the cut into the time-lapse, slots 23–82 are already down. */
  lapseStart: 83,
  /** Slots 83–122: the two drops of the time-lapse. */
  lapseDrops: [83, 103] as const,
  /** At the cut into the wish, slots 123–162 are already down. */
  wishStart: 163,
  /** Slots 163–180: the wish, dropped whole. */
  wishDrop: 163,
  total: 181,
} as const;

/** The letters she takes back off the heap at dawn: o, p, e, n of the wish's "open". */
export const OPEN_SLOTS = [169, 170, 171, 172] as const;

export const PRESS = 15.5;
export const SEND = 16;

/** The search: its row lands, then twelve sources pop out on the sixteenths. */
export const SEARCH_ROW = 16.5;
export const SOURCE_BEATS = Array.from({ length: 12 }, (_, k) => 17 + k / 4);
export const SOURCES = [
  'permits',
  'leases',
  'projectors',
  'licences',
  'seat plans',
  'film rights',
  'fire code',
  'sound',
  'screens',
  'insurance',
  'popcorn',
  'old cinemas',
] as const;

/** The sources slam down as the street, three at a time on the eighths; the lamps follow in pairs. */
export const SLAB_BEATS = [20.5, 21, 21.5, 22] as const;
/** Each pair of lamps: the left one on the beat, the right one a sixteenth later and shorter. */
export const LAMP_BEATS = [22.5, 23] as const;
export const LAMP_LAG = 0.25;

/** The code: its two lines type on the eighths, it runs, and a bar rises on each sixteenth. */
export const CODE_LINE_BEATS = [24, 24.5] as const;
export const RUN = 25;
export const ROWS = [8, 10, 10, 12, 12, 12, 12, 12] as const;
export const ROW_LETTERS = 'ABCDEFGH';
export const BAR_BEATS = ROWS.map((_, k) => 25 + k / 4);
export const TIP = 27;
export const SEATS_LAND = 28;
export const SCREEN_ON = 28.5;
export const SIT = 29;

/** Four models answer one question, one under another, a beat each so each name is read; she picks the third. */
export const NAME_ASK = 30;
export const ANSWER_BEATS = [30.5, 31.5, 32.5, 33.5] as const;
export const ANSWERS = [
  { model: 'GPT-5.5', name: 'Night Owl' },
  { model: 'Claude Sonnet 5.5', name: 'Reel House' },
  { model: 'Gemini 3.1 Pro', name: 'The Lantern' },
  { model: 'Mistral Large 3', name: 'Small Wonder' },
] as const;
export const PICKED = 2;
export const TAP = 34;
export const OTHERS_FALL = 34.5;
export const NAME_FLY = 35;

/** The sign: bulbs trace its frame on the sixteenths, then THE and LANTERN slam in. */
export const TRACE_BEATS = Array.from({ length: 6 }, (_, k) => 36 + k / 4);
export const SIGN_THE = 37.5;
export const SIGN_NAME = 38;
export const LIGHTS = 39;
export const CHASE_BEATS = [39.5, 40, 40.5, 41, 41.5] as const;
/** On the facade she throws one arm up, then the other. */
export const CHEER = 40;

/** Night: two sheets of the conversation, one per door, each slapped on and held to be read. */
export const SHEET_BEATS = [42.5, 43.5] as const;
export const STEP_BACK = 44.5;
export const OUTSIDE = 45;
export const NOTE = 46.5;
/** From here the camera has cut in on the note; COMING SOON is read by then. */
export const SOON_OUT = 48;
/** A stranger passes on the pavement; on this beat he turns to the doors. */
export const STRANGER_FROM = 47.5;
export const STRANGER_LOOK = 48.5;

/** Dawn: the two sheets come down, then she puts O, P, E, N up on the eighths, each thrown in view. */
export const PEEL_BEATS = [50, 51] as const;
export const OPEN_BEATS = [52.5, 53, 53.5, 54] as const;
export const JOY = 54.5;
export const DIVE = 55.75;
export const FINAL = 56;
export const WORDMARK = 56.5;
/** The tagline, a line a beat after the wordmark has been read alone; the card then sits still. */
export const TAG_BEATS = [58, 59, 60] as const;
/** From here to the end the card is at rest. */
export const CARD_REST = 57.5;
