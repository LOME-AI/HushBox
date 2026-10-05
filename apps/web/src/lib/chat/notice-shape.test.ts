import { describe, it, expect } from 'vitest';
import { AlertTriangle, CircleAlert, Hourglass, Info } from '@hushbox/ui/icons';
import { NOTICE_SHAPES, blockShape, composerNoticeShape } from '@/lib/chat/notice-shape';
import type { BudgetError } from '@hushbox/shared';

describe('blockShape', () => {
  it('draws a block that clears on its own as the hourglass', () => {
    expect(blockShape('on_its_own')).toBe('hourglass');
  });

  it('draws a block the user clears as the circle', () => {
    expect(blockShape('when_the_user_acts')).toBe('circle');
  });
});

describe('composerNoticeShape', () => {
  const notice = (fields: Pick<BudgetError, 'type' | 'blockClears'>): BudgetError => ({
    id: 'send_cannot_start',
    message: 'Sample.',
    ...fields,
  });

  it('draws an error by the block rule', () => {
    expect(composerNoticeShape(notice({ type: 'error', blockClears: 'on_its_own' }))).toBe(
      'hourglass'
    );
  });

  it('draws an error the user clears as the circle', () => {
    expect(composerNoticeShape(notice({ type: 'error', blockClears: 'when_the_user_acts' }))).toBe(
      'circle'
    );
  });

  it('draws an error that declares no clearing as the circle', () => {
    expect(composerNoticeShape(notice({ type: 'error' }))).toBe('circle');
  });

  it('draws a warning as the triangle', () => {
    expect(composerNoticeShape(notice({ type: 'warning' }))).toBe('triangle');
  });

  it('draws an info notice as the info circle', () => {
    expect(composerNoticeShape(notice({ type: 'info' }))).toBe('info');
  });
});

describe('NOTICE_SHAPES', () => {
  it('draws the hourglass in the error tone', () => {
    expect(NOTICE_SHAPES.hourglass).toEqual({ tone: 'error', icon: Hourglass });
  });

  it('draws the circle in the error tone', () => {
    expect(NOTICE_SHAPES.circle).toEqual({ tone: 'error', icon: CircleAlert });
  });

  it('draws the triangle in the warning tone', () => {
    expect(NOTICE_SHAPES.triangle).toEqual({ tone: 'warning', icon: AlertTriangle });
  });

  it('draws the info circle in the info tone', () => {
    expect(NOTICE_SHAPES.info).toEqual({ tone: 'info', icon: Info });
  });
});
