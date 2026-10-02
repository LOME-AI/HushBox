/** How the frames of a video render are made. */
export interface FrameSettings {
  /** Browser tabs rendering at once; null leaves Remotion's default. */
  concurrency: number | null;
  imageFormat: 'png' | 'jpeg';
  scale: number;
}

/**
 * The master renders in one tab, where each frame carries the history of every
 * frame before it, as lossless PNG at full size; a draft trades all three for
 * speed and is never checked for purity.
 */
export function frameSettings(draft: boolean): FrameSettings {
  return draft
    ? { concurrency: null, imageFormat: 'jpeg', scale: 0.5 }
    : { concurrency: 1, imageFormat: 'png', scale: 1 };
}
