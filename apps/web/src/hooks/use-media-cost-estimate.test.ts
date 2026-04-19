import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  TOTAL_FEE_RATE,
  MEDIA_STORAGE_COST_PER_BYTE,
  ESTIMATED_IMAGE_BYTES,
  ESTIMATED_VIDEO_BYTES_PER_SECOND,
} from '@hushbox/shared';
import { useMediaCostEstimate } from './use-media-cost-estimate';

describe('useMediaCostEstimate', () => {
  it('returns 0 cents for text modality', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'text', modelCount: 1 }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('computes image worst-case cents from perImage price and model count', () => {
    const perImage = 0.04;
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        modelCount: 2,
        imagePricing: { perImage },
      })
    );
    const expectedDollars =
      perImage * (1 + TOTAL_FEE_RATE) + ESTIMATED_IMAGE_BYTES * MEDIA_STORAGE_COST_PER_BYTE;
    expect(result.current.estimatedCents).toBeCloseTo(expectedDollars * 2 * 100, 3);
  });

  it('computes video worst-case cents from perSecond × duration', () => {
    const perSecond = 0.1;
    const durationSeconds = 4;
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        modelCount: 1,
        videoPricing: { perSecond, durationSeconds },
      })
    );
    const expectedDollars =
      perSecond * durationSeconds * (1 + TOTAL_FEE_RATE) +
      durationSeconds * ESTIMATED_VIDEO_BYTES_PER_SECOND * MEDIA_STORAGE_COST_PER_BYTE;
    expect(result.current.estimatedCents).toBeCloseTo(expectedDollars * 100, 3);
  });

  it('scales video cost linearly with duration', () => {
    const { result: short } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        modelCount: 1,
        videoPricing: { perSecond: 0.1, durationSeconds: 2 },
      })
    );
    const { result: long } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'video',
        modelCount: 1,
        videoPricing: { perSecond: 0.1, durationSeconds: 8 },
      })
    );
    expect(long.current.estimatedCents).toBeCloseTo(short.current.estimatedCents * 4, 3);
  });

  it('scales image cost linearly with model count', () => {
    const { result: one } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        modelCount: 1,
        imagePricing: { perImage: 0.04 },
      })
    );
    const { result: three } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        modelCount: 3,
        imagePricing: { perImage: 0.04 },
      })
    );
    expect(three.current.estimatedCents).toBeCloseTo(one.current.estimatedCents * 3, 3);
  });

  it('returns 0 when modelCount is 0', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        modelCount: 0,
        imagePricing: { perImage: 0.04 },
      })
    );
    expect(result.current.estimatedCents).toBe(0);
  });

  it('returns 0 for image modality when no pricing is supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'image', modelCount: 1 }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('returns 0 for video modality when no pricing is supplied', () => {
    const { result } = renderHook(() => useMediaCostEstimate({ modality: 'video', modelCount: 1 }));
    expect(result.current.estimatedCents).toBe(0);
  });

  it('exposes estimatedDollars for display convenience', () => {
    const { result } = renderHook(() =>
      useMediaCostEstimate({
        modality: 'image',
        modelCount: 1,
        imagePricing: { perImage: 0.04 },
      })
    );
    expect(result.current.estimatedDollars).toBeCloseTo(result.current.estimatedCents / 100, 6);
  });
});
