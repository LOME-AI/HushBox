import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  TOTAL_FEE_RATE,
  MEDIA_STORAGE_COST_PER_BYTE,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
  ESTIMATED_AUDIO_BYTES_PER_SECOND,
} from '@hushbox/shared';
import { useMediaCostEstimate } from './use-media-cost-estimate';

describe('useMediaCostEstimate', () => {
  it('returns 0 cents for text modality', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'text' }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('computes image cost summing per-model prices with fees and per-model storage', () => {
    const pricesPerImage = [0.04, 0.06];
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imagePricing: { pricesPerImage },
      })
    );
    const expectedDollars =
      (0.04 + 0.06) * (1 + TOTAL_FEE_RATE) +
      ESTIMATED_IMAGE_BYTES * MEDIA_STORAGE_COST_PER_BYTE * 2;
    expect(result.current.estimatedCents).toBeCloseTo(expectedDollars * 100, 3);
  });

  it('image cost reflects actual per-model prices, not max × count', () => {
    const { result: mixed } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imagePricing: { pricesPerImage: [0.02, 0.06] },
      })
    );
    const { result: maxOnly } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imagePricing: { pricesPerImage: [0.06, 0.06] },
      })
    );
    expect(mixed.current.estimatedCents).toBeLessThan(maxOnly.current.estimatedCents);
  });

  it('computes video cost summing per-model (perSecond × duration) with fees and storage', () => {
    const pricesPerSecond = [0.1, 0.4];
    const durationSeconds = 4;
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        videoPricing: { pricesPerSecond, durationSeconds },
      })
    );
    const expectedDollars =
      (0.1 + 0.4) * durationSeconds * (1 + TOTAL_FEE_RATE) +
      durationSeconds * ESTIMATED_VIDEO_BYTES_PER_SECOND * MEDIA_STORAGE_COST_PER_BYTE * 2;
    expect(result.current.estimatedCents).toBeCloseTo(expectedDollars * 100, 3);
  });

  it('scales video cost linearly with duration', () => {
    const { result: short } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        videoPricing: { pricesPerSecond: [0.1], durationSeconds: 2 },
      })
    );
    const { result: long } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        videoPricing: { pricesPerSecond: [0.1], durationSeconds: 8 },
      })
    );
    expect(long.current.estimatedCents).toBeCloseTo(short.current.estimatedCents * 4, 3);
  });

  it('scales image cost with the number of selected models', () => {
    const { result: one } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imagePricing: { pricesPerImage: [0.04] },
      })
    );
    const { result: three } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imagePricing: { pricesPerImage: [0.04, 0.04, 0.04] },
      })
    );
    expect(three.current.estimatedCents).toBeCloseTo(one.current.estimatedCents * 3, 3);
  });

  it('computes audio cost summing per-model (perSecond × maxDuration) with fees and storage', () => {
    const pricesPerSecond = [0.015, 0.03];
    const durationSeconds = 60;
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'audio',
        audioPricing: { pricesPerSecond, durationSeconds },
      })
    );
    const expectedDollars =
      (0.015 + 0.03) * durationSeconds * (1 + TOTAL_FEE_RATE) +
      durationSeconds * ESTIMATED_AUDIO_BYTES_PER_SECOND * MEDIA_STORAGE_COST_PER_BYTE * 2;
    expect(result.current.estimatedCents).toBeCloseTo(expectedDollars * 100, 3);
  });

  it('scales audio cost with the number of selected models (mixed prices)', () => {
    const { result: cheap } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'audio',
        audioPricing: { pricesPerSecond: [0.015], durationSeconds: 60 },
      })
    );
    const { result: cheapAndHd } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'audio',
        audioPricing: { pricesPerSecond: [0.015, 0.03], durationSeconds: 60 },
      })
    );
    expect(cheapAndHd.current.estimatedCents).toBeGreaterThan(cheap.current.estimatedCents);
  });

  it('returns 0 when no models are selected (empty pricesPerImage)', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imagePricing: { pricesPerImage: [] },
      })
    );
    expect(result.current.estimatedCents).toBe(0);
  });

  it('returns 0 for image modality when no pricing is supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'image' }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('returns 0 for video modality when no pricing is supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'video' }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('returns 0 for audio modality when no pricing is supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'audio' }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('exposes estimatedDollars for display convenience', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        imagePricing: { pricesPerImage: [0.04] },
      })
    );
    expect(result.current.estimatedDollars).toBeCloseTo(result.current.estimatedCents / 100, 6);
  });
});
