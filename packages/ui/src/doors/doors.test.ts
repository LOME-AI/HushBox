import { describe, it, expect } from 'vitest';
import { expectExposes } from '@hushbox/shared/test-assertions';

describe('@hushbox/ui group doors', () => {
  it('resolves @hushbox/ui/button', async () => {
    await expect(import('@hushbox/ui/button')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/button-groups', async () => {
    await expect(import('@hushbox/ui/button-groups')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/field', async () => {
    await expect(import('@hushbox/ui/field')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/overlay', async () => {
    await expect(import('@hushbox/ui/overlay')).resolves.toBeDefined();
  });

  it('publishes the overlay title through @hushbox/ui/overlay', async () => {
    const door = await import('@hushbox/ui/overlay');

    expectExposes(door, 'OverlayTitle');
  });

  it('publishes the overlay focus return through @hushbox/ui/overlay', async () => {
    const door = await import('@hushbox/ui/overlay');

    expectExposes(door, 'useOverlayFocusReturn');
  });

  it('resolves @hushbox/ui/menu', async () => {
    await expect(import('@hushbox/ui/menu')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/popover', async () => {
    await expect(import('@hushbox/ui/popover')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/notice', async () => {
    await expect(import('@hushbox/ui/notice')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/marks', async () => {
    await expect(import('@hushbox/ui/marks')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/surface', async () => {
    await expect(import('@hushbox/ui/surface')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/type', async () => {
    await expect(import('@hushbox/ui/type')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/icons', async () => {
    await expect(import('@hushbox/ui/icons')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/motion', async () => {
    await expect(import('@hushbox/ui/motion')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/platform', async () => {
    await expect(import('@hushbox/ui/platform')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/animation-frame', async () => {
    await expect(import('@hushbox/ui/animation-frame')).resolves.toBeDefined();
  });

  it('resolves @hushbox/ui/text-metrics to the text-metric observer', async () => {
    const door = await import('@hushbox/ui/text-metrics');

    expect(Object.keys(door)).toEqual(['observeTextMetrics']);
  });
});
