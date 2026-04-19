import type { Modality } from '@hushbox/shared';

/**
 * Per-modality prompt placeholder. Text modality uses the caller-supplied
 * default so different surfaces (chat-layout vs chat-welcome) keep their
 * wording.
 */
export function getPromptPlaceholder(modality: Modality, textFallback: string): string {
  if (modality === 'image') return 'Describe the image you want...';
  if (modality === 'video') return 'Describe the video you want...';
  if (modality === 'audio') return 'Describe the audio you want...';
  return textFallback;
}
