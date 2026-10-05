import type { Model } from '@hushbox/shared';
import type { ModelsData } from '@/hooks/models/models';

/** The image model the fixture selects, priced so the composer's cost line has a figure. */
export const FIXTURE_IMAGE_MODEL: Model = {
  id: 'fictional/image',
  name: 'Fictional Image',
  provider: 'Fictional',
  description: 'Image generation model.',
  modality: 'image',
  contextLength: 0,
  supportedParameters: [],
  pricing: { perImage: '40000000', dearestPerImage: '40000000' },
  supportedAspectRatios: ['1:1', '16:9', '9:16'],
};

/** The video turn the fixture's store holds, at a resolution and duration the model serves. */
export const FIXTURE_VIDEO_TURN = { resolution: '720p', durationSeconds: 4 } as const;

/** The video model the fixture selects, priced at {@link FIXTURE_VIDEO_TURN}'s resolution. */
export const FIXTURE_VIDEO_MODEL: Model = {
  id: 'fictional/video',
  name: 'Fictional Video',
  provider: 'Fictional',
  description: 'Video generation model.',
  modality: 'video',
  contextLength: 0,
  supportedParameters: [],
  pricing: {
    perSecondByResolution: { [FIXTURE_VIDEO_TURN.resolution]: '100000000' },
    dearestPerSecondByResolution: { [FIXTURE_VIDEO_TURN.resolution]: '100000000' },
  },
  supportedAspectRatios: ['16:9', '9:16'],
  supportedVideoResolutions: [FIXTURE_VIDEO_TURN.resolution],
  supportedVideoDurationsSeconds: [FIXTURE_VIDEO_TURN.durationSeconds, 6, 8],
};

/**
 * Stands in for the catalog query inside `composer-bar.browser.test.ts`'s fixture: the
 * catalog holds the fixture's media models, served without a network or a query client.
 * @toolContract
 */
export function useModels(): { data: ModelsData } {
  return { data: { models: [FIXTURE_IMAGE_MODEL, FIXTURE_VIDEO_MODEL], premiumIds: new Set() } };
}
