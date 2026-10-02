import { describe, it, expect } from 'vitest';
import * as door from '@hushbox/ui/notice';

describe('@hushbox/ui/notice', () => {
  it('publishes the notice, its stack and its dismiss control', () => {
    expect(Object.keys(door).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'Notice',
      'NoticeDismiss',
      'NoticeStack',
    ]);
  });
});
