import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';

const reducedMotionRef = { current: false };

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return {
    ...actual,
    useReducedMotion: () => reducedMotionRef.current,
  };
});

import { LatentDevelopBackdrop } from '@/components/chat/media/latent-develop-backdrop';

describe('LatentDevelopBackdrop', () => {
  beforeEach(() => {
    reducedMotionRef.current = false;
  });

  it('renders a decorative, aria-hidden backdrop', () => {
    render(<LatentDevelopBackdrop />);
    const backdrop = screen.getByTestId(TEST_IDS.latentDevelop);
    expect(backdrop).toBeInTheDocument();
    expect(backdrop).toHaveAttribute('aria-hidden', 'true');
  });

  it('runs the sweeping sheen when motion is allowed', () => {
    reducedMotionRef.current = false;
    render(<LatentDevelopBackdrop />);
    expect(screen.getByTestId(TEST_IDS.latentDevelop)).toHaveAttribute('data-animated', 'true');
    expect(screen.getByTestId(TEST_IDS.latentDevelopSheen)).toBeInTheDocument();
  });

  it('drops the sheen and settles static under reduced motion', () => {
    reducedMotionRef.current = true;
    render(<LatentDevelopBackdrop />);
    expect(screen.getByTestId(TEST_IDS.latentDevelop)).toHaveAttribute('data-animated', 'false');
    expect(screen.queryByTestId(TEST_IDS.latentDevelopSheen)).not.toBeInTheDocument();
  });

  it('clears the grain as video progress climbs', () => {
    const { rerender } = render(<LatentDevelopBackdrop progressPercent={10} />);
    const early = Number(screen.getByTestId(TEST_IDS.latentDevelop).dataset['grainOpacity']);
    rerender(<LatentDevelopBackdrop progressPercent={90} />);
    const late = Number(screen.getByTestId(TEST_IDS.latentDevelop).dataset['grainOpacity']);
    expect(late).toBeLessThan(early);
  });

  it('clamps out-of-range progress when resolving grain opacity', () => {
    const { rerender } = render(<LatentDevelopBackdrop progressPercent={-50} />);
    const underflow = Number(screen.getByTestId(TEST_IDS.latentDevelop).dataset['grainOpacity']);
    rerender(<LatentDevelopBackdrop progressPercent={150} />);
    const overflow = Number(screen.getByTestId(TEST_IDS.latentDevelop).dataset['grainOpacity']);
    // 0% floor is the densest grain; 100% ceiling is the faintest.
    expect(underflow).toBeGreaterThan(overflow);
    expect(overflow).toBeGreaterThanOrEqual(0);
  });
});
