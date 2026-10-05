import { describe, expect, it } from 'vitest';
import { mediaTurnCostNanoUsd } from './media-turn-cost.ts';
import type { Model } from '../../schemas/api/models.ts';

/** The run's media storage: the value-store budget, 20,971,520 bytes × 18. */
const RUN_STORAGE = 377_487_360n;

function costOf(result: ReturnType<typeof mediaTurnCostNanoUsd>): bigint {
  if (!result.ok) throw new Error(`expected a priced turn, got ${result.error.code}`);
  return result.value;
}

function row(overrides: Partial<Model>): Model {
  return {
    id: 'vendor/model',
    name: 'Vendor Model',
    provider: 'vendor',
    modality: 'image',
    contextLength: 0,
    pricing: {},
    description: 'a media model',
    supportedParameters: [],
    ...overrides,
  };
}

/** An image row whose served rate is also the dearest it can bill. */
function imageRow(perImage: string, dearestPerImage = perImage): Model {
  return row({ pricing: { perImage, dearestPerImage } });
}

function videoRow(
  perSecondByResolution: Record<string, string>,
  dearestPerSecondByResolution = perSecondByResolution
): Model {
  return row({
    modality: 'video',
    pricing: { perSecondByResolution, dearestPerSecondByResolution },
  });
}

describe('mediaTurnCostNanoUsd', () => {
  it('prices an image turn as each model rate plus the run storage once', () => {
    expect(
      costOf(
        mediaTurnCostNanoUsd({
          modality: 'image',
          models: [imageRow('40000000'), imageRow('60000000')],
        })
      )
    ).toBe(100_000_000n + RUN_STORAGE);
  });

  it('reserves each image model at its dearest rate, not the rate it is shown at', () => {
    expect(
      costOf(
        mediaTurnCostNanoUsd({ modality: 'image', models: [imageRow('40000000', '90000000')] })
      )
    ).toBe(90_000_000n + RUN_STORAGE);
  });

  it('prices a video turn as each model rate at the resolution times the duration, plus the run storage once', () => {
    const durationSeconds = 4;

    expect(
      costOf(
        mediaTurnCostNanoUsd({
          modality: 'video',
          models: [
            videoRow({ '720p': '100000000', '1080p': '900000000' }),
            videoRow({ '720p': '400000000' }),
          ],
          resolution: '720p',
          durationSeconds,
        })
      )
    ).toBe((100_000_000n + 400_000_000n) * 4n + RUN_STORAGE);
  });

  it('reserves each video model at its dearest rate for the resolution', () => {
    expect(
      costOf(
        mediaTurnCostNanoUsd({
          modality: 'video',
          models: [videoRow({ '720p': '100000000' }, { '720p': '300000000' })],
          resolution: '720p',
          durationSeconds: 2,
        })
      )
    ).toBe(300_000_000n * 2n + RUN_STORAGE);
  });

  it('refuses a video turn at a resolution a selected model does not price', () => {
    expect(
      mediaTurnCostNanoUsd({
        modality: 'video',
        models: [videoRow({ '720p': '100000000' })],
        resolution: '4k',
        durationSeconds: 4,
      }).ok
    ).toBe(false);
  });

  it('refuses an audio turn: no price kind represents audio', () => {
    expect(
      mediaTurnCostNanoUsd({
        modality: 'audio',
        models: [row({ modality: 'audio' })],
        durationSeconds: 60,
      }).ok
    ).toBe(false);
  });

  it('prices each selected model at its own rate, never the widest one repeated', () => {
    const mixed = costOf(
      mediaTurnCostNanoUsd({
        modality: 'image',
        models: [imageRow('20000000'), imageRow('60000000')],
      })
    );
    const widest = costOf(
      mediaTurnCostNanoUsd({
        modality: 'image',
        models: [imageRow('60000000'), imageRow('60000000')],
      })
    );

    expect(mixed).toBeLessThan(widest);
  });

  it('refuses a turn with a sibling that serves no price rather than charging it nothing', () => {
    expect(
      mediaTurnCostNanoUsd({
        modality: 'image',
        models: [imageRow('40000000'), row({ pricing: { perImage: '40000000' } })],
      }).ok
    ).toBe(false);
  });

  it('refuses a turn with no model rather than pricing it at zero', () => {
    expect(mediaTurnCostNanoUsd({ modality: 'image', models: [] }).ok).toBe(false);
  });

  it('refuses a zero-duration turn rather than pricing it at zero', () => {
    expect(
      mediaTurnCostNanoUsd({
        modality: 'video',
        models: [videoRow({ '720p': '100000000' })],
        resolution: '720p',
        durationSeconds: 0,
      }).ok
    ).toBe(false);
  });
});
