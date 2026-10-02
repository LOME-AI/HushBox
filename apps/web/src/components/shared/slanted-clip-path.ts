// Keeps the slant inside the box and reaches 16px past its three unslanted sides so focus paint shows
// there: 16px is the widest the app draws, the accessibility widget's halo (4px spread plus 12px blur).
export const SLANTED_CLIP_PATH =
  'polygon(-16px -16px, 100% -16px, 100% 0, 95% 100%, 95% calc(100% + 16px), -16px calc(100% + 16px))';
