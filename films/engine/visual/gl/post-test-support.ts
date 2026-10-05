import type { PostSettings } from './post.js';

/** The chain with every effect off; its highlight roll-off and dither still finish the frame. */
export const NEUTRAL_POST: PostSettings = { bloom: 0, aberration: 0, vignette: 0, flash: 0 };
