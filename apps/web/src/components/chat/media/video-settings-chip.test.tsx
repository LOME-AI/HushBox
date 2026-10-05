import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  return { ...actual, useModelStore: store };
});

import { VideoSettingsChip } from '@/components/chat/media/video-settings-chip';
import type { VideoConfig } from '@/stores/model';

function chooseVideo(videoConfig: VideoConfig): void {
  modelStoreStubRef.current = createModelStoreStub({ activeModality: 'video', videoConfig });
}

describe('VideoSettingsChip', () => {
  it('names itself by the video settings it opens', () => {
    chooseVideo({ aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' });
    render(<VideoSettingsChip />);
    expect(
      screen.getByRole('button', { name: 'Video settings: 4s · 720p, 16:9' })
    ).toBeInTheDocument();
  });

  it('carries the text it shows inside its name', () => {
    chooseVideo({ aspectRatio: '9:16', durationSeconds: 8, resolution: '1080p' });
    render(<VideoSettingsChip />);
    const chip = screen.getByRole('button');
    const shown = chip.textContent;
    expect(shown).not.toBe('');
    expect(chip.getAttribute('aria-label')).toContain(shown);
  });

  it('shows the duration and the resolution as its label, leaving the ratio to its shape', () => {
    chooseVideo({ aspectRatio: '9:16', durationSeconds: 8, resolution: '1080p' });
    render(<VideoSettingsChip />);
    expect(screen.getByRole('button')).toHaveTextContent(/^8s · 1080p$/u);
  });

  it('calls the automatic ratio Auto', () => {
    chooseVideo({ aspectRatio: 'auto', durationSeconds: 4, resolution: '720p' });
    render(<VideoSettingsChip />);
    expect(
      screen.getByRole('button', { name: 'Video settings: 4s · 720p, Auto' })
    ).toBeInTheDocument();
  });

  it('carries the chosen ratio as its shape', () => {
    chooseVideo({ aspectRatio: '9:16', durationSeconds: 4, resolution: '720p' });
    render(<VideoSettingsChip />);
    const shape = screen.getByTestId(TEST_IDS.aspectRatioShape);
    expect(Number.parseFloat(shape.style.height)).toBeGreaterThan(
      Number.parseFloat(shape.style.width)
    );
  });

  it('draws its shape outside a span, so a chip squared to its icon keeps the shape', () => {
    chooseVideo({ aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' });
    render(<VideoSettingsChip />);
    const shape = screen.getByTestId(TEST_IDS.aspectRatioShape);
    expect(shape.tagName.toLowerCase()).toBe('svg');
    expect(shape.parentElement).toBe(screen.getByRole('button'));
  });

  it('turns its shape Signal Red while its popover is open', () => {
    chooseVideo({ aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' });
    render(<VideoSettingsChip />);
    expect(screen.getByRole('button')).toHaveClass('[&[aria-expanded=true]>svg]:text-brand-red');
  });

  it('says whether its popover is open', () => {
    chooseVideo({ aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' });
    render(<VideoSettingsChip expanded />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });
});
