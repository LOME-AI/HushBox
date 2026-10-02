import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  MEDIA_STORAGE_COST_PER_BYTE_NANO,
} from '@hushbox/shared';
import { selectedServedRows, useMediaCostEstimate } from '@/hooks/billing/use-media-cost-estimate';
import type { Model } from '@hushbox/shared';
import type { UseMediaCostEstimateInput } from '@/hooks/billing/use-media-cost-estimate';

/** Customer-facing nano for a media turn: billable provider + raw storage
 * (rates are billable at ingestion — no fee math in the estimator). */
function expectedNano(providerBillableNano: bigint, storageBaseNano: bigint): bigint {
  return providerBillableNano + storageBaseNano;
}

function servedRow(overrides: Partial<Model>): Model {
  return {
    id: 'vendor/media',
    name: 'Vendor Media',
    provider: 'vendor',
    modality: 'image',
    contextLength: 0,
    pricing: {},
    description: 'a media model',
    supportedParameters: [],
    ...overrides,
  };
}

/** An image row whose served per-image rate is also the dearest it can bill, unless named. */
function imageRow(perImage: bigint, dearestPerImage = perImage): Model {
  return servedRow({
    pricing: { perImage: perImage.toString(), dearestPerImage: dearestPerImage.toString() },
  });
}

/** A video row priced at one per-second rate at 720p. */
function videoRow(ratePerSecond: bigint): Model {
  return servedRow({
    modality: 'video',
    pricing: {
      perSecondByResolution: { '720p': ratePerSecond.toString() },
      dearestPerSecondByResolution: { '720p': ratePerSecond.toString() },
    },
  });
}

function input(overrides: Partial<UseMediaCostEstimateInput>): UseMediaCostEstimateInput {
  return {
    modality: 'image',
    models: undefined,
    videoResolution: '720p',
    durationSeconds: 4,
    ...overrides,
  };
}

/**
 * The estimate, asserted to EXIST. Absence and a number are different answers
 * here — a test that reads a figure must first say it got one.
 */
function priced(overrides: Partial<UseMediaCostEstimateInput>): bigint {
  const { result } = renderHook(() => useMediaCostEstimate(input(overrides)));
  expect(result.current).toBeTypeOf('bigint');
  return result.current!;
}

describe('useMediaCostEstimate', () => {
  it('gives no figure at all for text modality, which prices per token', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate(input({ modality: 'text', models: [] }))
    );
    expect(result.current).toBeUndefined();
  });

  it('computes image cost as the billable per-model provider rate plus per-model storage', () => {
    // Billable nano per-image rates: $0.04 and $0.06.
    const storage = BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO * 2n;
    expect(priced({ models: [imageRow(40_000_000n), imageRow(60_000_000n)] })).toBe(
      expectedNano(100_000_000n, storage)
    );
  });

  it('reserves each image model at its dearest rate, the side the hold reserves', () => {
    const storage = BigInt(ESTIMATED_IMAGE_BYTES) * MEDIA_STORAGE_COST_PER_BYTE_NANO;
    expect(priced({ models: [imageRow(40_000_000n, 90_000_000n)] })).toBe(
      expectedNano(90_000_000n, storage)
    );
  });

  it('passes the provider rate through verbatim — no markup, no fee term', () => {
    // The run's named directional hazard: a reader who believes the wire rate is
    // BASE "corrects" it by applying markup and double-charges, because fees are
    // already baked at catalog ingestion. These two figures are what make that
    // belief false, and this test fails the moment anything multiplies the rate.
    const cheap = priced({ models: [imageRow(40_000_000n)] });
    const dear = priced({ models: [imageRow(80_000_000n)] });

    expect(dear - cheap).toBe(40_000_000n);
  });

  it('image cost reflects actual per-model rates, not max × count', () => {
    const mixed = priced({ models: [imageRow(20_000_000n), imageRow(60_000_000n)] });
    const maxOnly = priced({ models: [imageRow(60_000_000n), imageRow(60_000_000n)] });
    expect(mixed).toBeLessThan(maxOnly);
  });

  it('computes video cost as the billable (per-model rate × duration) plus storage', () => {
    const durationSeconds = 4;
    const provider = (100_000_000n + 400_000_000n) * BigInt(durationSeconds);
    const storage =
      BigInt(durationSeconds) *
      BigInt(ESTIMATED_VIDEO_BYTES_PER_SECOND) *
      MEDIA_STORAGE_COST_PER_BYTE_NANO *
      2n;
    expect(
      priced({
        modality: 'video',
        models: [videoRow(100_000_000n), videoRow(400_000_000n)],
        durationSeconds,
      })
    ).toBe(expectedNano(provider, storage));
  });

  it('scales video cost linearly with duration', () => {
    const short = priced({
      modality: 'video',
      models: [videoRow(100_000_000n)],
      durationSeconds: 2,
    });
    const long = priced({
      modality: 'video',
      models: [videoRow(100_000_000n)],
      durationSeconds: 8,
    });
    expect(long).toBe(short * 4n);
  });

  it('scales image cost with the number of selected models', () => {
    const one = priced({ models: [imageRow(40_000_000n)] });
    const three = priced({
      models: [imageRow(40_000_000n), imageRow(40_000_000n), imageRow(40_000_000n)],
    });
    expect(three).toBe(one * 3n);
  });

  it('gives no figure for an audio turn, which no price kind represents', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate(
        input({
          modality: 'audio',
          models: [servedRow({ modality: 'audio' })],
          durationSeconds: 60,
        })
      )
    );
    expect(result.current).toBeUndefined();
  });

  it('gives no figure for a video turn at a resolution a selected model does not price', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate(
        input({ modality: 'video', models: [videoRow(100_000_000n)], videoResolution: '4k' })
      )
    );
    expect(result.current).toBeUndefined();
  });

  it('gives no figure when no model is selected — the producer refuses to price it', () => {
    // Measured against the real producer: an empty selection is a REFUSAL there,
    // and it used to arrive here as `0n` through the fallback that is now gone.
    const { result } = renderHook(() => useMediaCostEstimate(input({ models: [] })));
    expect(result.current).toBeUndefined();
  });

  it('gives no figure for a zero-duration video — also a producer refusal', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate(
        input({ modality: 'video', models: [videoRow(100_000_000n)], durationSeconds: 0 })
      )
    );
    expect(result.current).toBeUndefined();
  });

  it('gives no figure for a selected row that serves no price, rather than pricing it free', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate(input({ models: [servedRow({ pricing: { perImage: '40000000' } })] }))
    );
    expect(result.current).toBeUndefined();
  });

  // A caller reaches the absence case by selecting a model the catalog has not
  // delivered, and a `0n` here would be compared by the funding resolver and
  // cleared by any headroom — a FUNDED verdict for an unpriceable turn.
  it('gives no figure when the selected rows could not be supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate(input({ models: undefined })));
    expect(result.current).toBeUndefined();
  });
});

describe('selectedServedRows', () => {
  const catalog = [imageRow(40_000_000n), servedRow({ id: 'vendor/other' })];

  it('reads each selected model’s served row in selection order', () => {
    expect(
      selectedServedRows([{ id: 'vendor/other' }, { id: 'vendor/media' }], catalog)?.map(
        (row) => row.id
      )
    ).toEqual(['vendor/other', 'vendor/media']);
  });

  it('answers nothing when a selected model is not in the catalog yet', () => {
    expect(selectedServedRows([{ id: 'vendor/missing' }], catalog)).toBeUndefined();
  });

  it('answers nothing before the catalog arrives', () => {
    // A catalog read still in flight publishes no data.
    const catalogRead: { readonly data?: readonly Model[] } = {};

    expect(selectedServedRows([{ id: 'vendor/media' }], catalogRead.data)).toBeUndefined();
  });

  it('answers nothing for an empty selection', () => {
    expect(selectedServedRows([], catalog)).toBeUndefined();
  });
});
