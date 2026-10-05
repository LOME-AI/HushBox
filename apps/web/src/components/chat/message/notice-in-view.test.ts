import { describe, it, expect } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { turnNoticeForCode } from '@/lib/chat/turn-notice';
import {
  countStillFrame,
  noticeViewLocation,
  rowIndexHolding,
  STILLNESS_UNCOUNTED,
  unseenNotices,
  type ThreadRow,
} from '@/components/chat/message/notice-in-view';
import type { CalculateViewLocationParams } from 'react-virtuoso';
import type { Message } from '@/lib/api/api';

function message(id: string, role: Message['role'] = 'assistant'): Message {
  return { id, conversationId: 'conv-1', role, content: id, createdAt: isoAt(TEST_DAY_START) };
}

function notice(id: string): Message {
  return { ...message(id), turnNotice: turnNoticeForCode('UNAVAILABLE') };
}

/** A notice row `itemTop` to `itemBottom` px down a list whose view spans 1000 to 1600 px. */
function view(itemTop: number, itemBottom: number): CalculateViewLocationParams {
  return {
    itemTop,
    itemBottom,
    viewportTop: 1000,
    viewportBottom: 1600,
    locationParams: { index: 4, behavior: 'smooth' },
  };
}

describe('noticeViewLocation', () => {
  it('leaves a notice wholly in view where it is', () => {
    expect(noticeViewLocation(view(1200, 1300))).toBeNull();
  });

  it('centres a notice placed above the view', () => {
    expect(noticeViewLocation(view(400, 500))).toEqual({
      index: 4,
      behavior: 'smooth',
      align: 'center',
    });
  });

  it('centres a notice placed below the view', () => {
    expect(noticeViewLocation(view(1700, 1800))).toEqual({
      index: 4,
      behavior: 'smooth',
      align: 'center',
    });
  });

  it('centres a notice the top of the view cuts through', () => {
    expect(noticeViewLocation(view(950, 1050))).toMatchObject({ align: 'center' });
  });

  it('centres a notice the bottom of the view cuts through', () => {
    expect(noticeViewLocation(view(1550, 1650))).toMatchObject({ align: 'center' });
  });

  it('leaves a notice that exactly fills the view where it is', () => {
    expect(noticeViewLocation(view(1000, 1600))).toBeNull();
  });
});

describe('unseenNotices', () => {
  it('names a notice not yet seen with the row it follows', () => {
    expect(unseenNotices([message('a', 'user'), notice('n-1')], new Set())).toEqual([
      { id: 'n-1', placement: 'a>n-1' },
    ]);
  });

  it('names a notice that opens the thread with no row before it', () => {
    expect(unseenNotices([notice('n-1')], new Set())).toEqual([{ id: 'n-1', placement: '>n-1' }]);
  });

  it('leaves out a notice already seen where it sits', () => {
    expect(unseenNotices([message('a', 'user'), notice('n-1')], new Set(['a>n-1']))).toEqual([]);
  });

  it('names a notice seen elsewhere once it follows another row', () => {
    const thread = [message('a', 'user'), message('b'), notice('n-1')];
    expect(unseenNotices(thread, new Set(['a>n-1']))).toEqual([{ id: 'n-1', placement: 'b>n-1' }]);
  });

  it('leaves out a row that carries no notice', () => {
    expect(unseenNotices([message('a', 'user'), message('b')], new Set())).toEqual([]);
  });
});

describe('rowIndexHolding', () => {
  const rows: readonly ThreadRow[] = [
    { message: message('a', 'user') },
    { group: { messages: [message('b'), message('c')] } },
    { message: message('d'), replies: [{ message: message('d') }, { message: message('e') }] },
  ];

  it('finds a row that draws the message alone', () => {
    expect(rowIndexHolding(rows, 'a')).toBe(0);
  });

  it('finds a sender group that draws the message among others', () => {
    expect(rowIndexHolding(rows, 'c')).toBe(1);
  });

  it('finds a compare turn that draws the message as one of its replies', () => {
    expect(rowIndexHolding(rows, 'e')).toBe(2);
  });

  it('finds no row for a message the thread does not draw', () => {
    expect(rowIndexHolding(rows, 'z')).toBe(-1);
  });
});

describe('countStillFrame', () => {
  it('starts a count not yet begun at the top the scroller stands at', () => {
    expect(countStillFrame(STILLNESS_UNCOUNTED, 0, 6)).toEqual({
      still: { top: 0, frames: 0 },
      rested: false,
    });
  });

  it('starts the count afresh at the new top when the scroller moves', () => {
    expect(countStillFrame({ top: 400, frames: 4 }, 380, 6)).toEqual({
      still: { top: 380, frames: 0 },
      rested: false,
    });
  });

  it('adds a frame while the scroller stands where it stood', () => {
    expect(countStillFrame({ top: 400, frames: 2 }, 400, 6)).toEqual({
      still: { top: 400, frames: 3 },
      rested: false,
    });
  });

  it('reads a scroller a fraction of a pixel from where it stood as standing still', () => {
    expect(countStillFrame({ top: 400, frames: 2 }, 400.4, 6).still).toEqual({
      top: 400,
      frames: 3,
    });
  });

  it('counts the scroller at rest once it has stood still for the frames asked', () => {
    expect(countStillFrame({ top: 400, frames: 5 }, 400, 6).rested).toBe(true);
  });

  it('begins the count again once the scroller is at rest', () => {
    expect(countStillFrame({ top: 400, frames: 5 }, 400, 6).still).toEqual(STILLNESS_UNCOUNTED);
  });
});
