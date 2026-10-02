import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TtsDownloadBar } from './tts-download-bar';

const { reducedMotionRef } = vi.hoisted(() => ({ reducedMotionRef: { value: false } }));

vi.mock('../../hooks/use-reduced-motion', () => ({
  useReducedMotion: (): boolean => reducedMotionRef.value,
}));

function fillOf(bar: HTMLElement): HTMLElement {
  const fill = bar.querySelector<HTMLElement>('[style*="width"]');
  if (fill === null) throw new Error('fill element not found');
  return fill;
}

describe('TtsDownloadBar', () => {
  beforeEach(() => {
    reducedMotionRef.value = false;
  });

  it('renders a progressbar named by the label', () => {
    render(<TtsDownloadBar percent={40} label="Read-aloud model download" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('Read-aloud model download');
  });

  it('exposes the rounded percent as the progressbar value', () => {
    render(<TtsDownloadBar percent={37.6} label="Preparing the voice" />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('38');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('clamps an announced value above 100', () => {
    render(<TtsDownloadBar percent={150} label="Preparing the voice" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });

  it('clamps a negative announced value to zero', () => {
    render(<TtsDownloadBar percent={-20} label="Preparing the voice" />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('is not a live region, so progress ticks announce nothing', () => {
    render(<TtsDownloadBar percent={40} label="Preparing the voice" showLabel />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('drives the fill width from the (rounded) percent', () => {
    render(<TtsDownloadBar percent={37.6} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('progressbar')).style.width).toBe('38%');
  });

  it('clamps a percent above 100 to a full fill', () => {
    render(<TtsDownloadBar percent={150} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('progressbar')).style.width).toBe('100%');
  });

  it('clamps a negative percent to an empty fill', () => {
    render(<TtsDownloadBar percent={-20} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('progressbar')).style.width).toBe('0%');
  });

  it('hides the label/percent header by default', () => {
    render(<TtsDownloadBar percent={38} label="Read-aloud model download" />);
    expect(screen.queryByText('Read-aloud model download')).toBeNull();
    expect(screen.queryByText('38%')).toBeNull();
  });

  it('shows the label and percent header when showLabel is set', () => {
    render(<TtsDownloadBar percent={38} label="Preparing the voice" showLabel />);
    expect(screen.getByText('Preparing the voice')).not.toBeNull();
    expect(screen.getByText('38%')).not.toBeNull();
  });

  it('animates the fill when motion is allowed', () => {
    reducedMotionRef.value = false;
    render(<TtsDownloadBar percent={50} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('progressbar')).className).toContain('transition-all');
  });

  it('drops the fill animation under reduced motion', () => {
    reducedMotionRef.value = true;
    render(<TtsDownloadBar percent={50} label="Preparing the voice" />);
    expect(fillOf(screen.getByRole('progressbar')).className).not.toContain('transition-all');
  });

  it('renders no border stroke and no background box on the container', () => {
    render(<TtsDownloadBar percent={50} label="Preparing the voice" showLabel />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).not.toMatch(/\bborder\b/);
    expect(bar.className).not.toMatch(/\bbg-/);
  });
});
