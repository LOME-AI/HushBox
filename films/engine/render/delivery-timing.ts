import { SAMPLES_PER_FRAME } from '../time/grid.js';

/**
 * The samples of priming the bundled ffmpeg's native `aac` encoder puts before
 * the first sample it is given. The delivered MP4 carries no edit list to trim
 * them, so every decoder plays them as the file's first samples.
 */
export const AAC_ENCODER_DELAY = 1024;

/**
 * Copies of frame 0 written ahead of the film, so that the priming plus the
 * master's pad fills exactly these frames and audio and picture start together
 * whether or not a reader honours edit lists. A delivered frame is the film's
 * frame plus this.
 */
export const LEAD_FRAMES = Math.ceil(AAC_ENCODER_DELAY / SAMPLES_PER_FRAME);

/** Every delivered sample's offset from the master's: the lead in samples. */
export const LEAD_SAMPLES = LEAD_FRAMES * SAMPLES_PER_FRAME;

/** Zero samples put before the master so that the priming and the pad fill the lead. */
export const PAD_SAMPLES = LEAD_SAMPLES - AAC_ENCODER_DELAY;
