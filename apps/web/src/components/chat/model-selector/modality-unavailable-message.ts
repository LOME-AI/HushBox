import type { ChatModality } from '@hushbox/shared';

/** The noun that names the modality inside the sentence below. */
const MODALITY_NOUNS: Record<ChatModality, string> = {
  text: 'text',
  image: 'image',
  audio: 'audio',
  video: 'video',
};

/**
 * What the picker says when a modality carries no models at all.
 *
 * The two causes are named together on purpose: the client cannot tell a
 * zero-data-retention exclusion from a gateway outage or a failed catalog
 * refresh, and no backend fact reaches it that would. Hedging both keeps the
 * sentence true under all three. "unavailable" rather than "disabled" for the
 * same reason — "disabled" asserts a switch was thrown, which is false of an
 * outage. Wording is approved; change it only with fresh approval.
 */
export function modalityUnavailableMessage(modality: ChatModality): string {
  return `No ${MODALITY_NOUNS[modality]} model supports zero data retention at this time, or we are experiencing intermittent issues. To protect your privacy, this feature is temporarily unavailable. Please check back later.`;
}
