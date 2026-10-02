import type { ChatModality } from './types.ts';

/**
 * The labels the demo's director and composer cues match modality switches by:
 * the director clicks the control carrying one, and the cues dim every control
 * carrying any. The composer's own mode control is the "Change mode" menu, whose
 * items carry none of them.
 */
export const MODALITY_ARIA_LABELS: Record<ChatModality, string> = {
  text: 'Switch to text',
  image: 'Switch to image generation',
  video: 'Switch to video generation',
  audio: 'Switch to audio generation',
};
