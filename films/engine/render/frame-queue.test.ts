import { describe, expect, it } from 'vitest';

import { createFrameQueue } from './frame-queue.js';

/** A frame's bytes: one byte holding its number, so the written order is readable. */
function bytesOf(frame: number): Uint8Array {
  return Uint8Array.of(frame);
}

/** The frame numbers a list of written buffers holds, in the order written. */
function framesIn(written: readonly Uint8Array[]): number[] {
  return written.map((bytes) => bytes[0] ?? -1);
}

describe('createFrameQueue', () => {
  it('writes frames that arrive in order as they arrive', () => {
    const queue = createFrameQueue(3, 0);

    expect(framesIn([...queue.accept(0, bytesOf(0)), ...queue.accept(1, bytesOf(1))])).toEqual([
      0, 1,
    ]);
  });

  it('writes frame 0 once more for each lead frame, ahead of the film', () => {
    const queue = createFrameQueue(3, 2);

    expect(framesIn(queue.accept(0, bytesOf(0)))).toEqual([0, 0, 0]);
  });

  it('holds a frame that arrives early until the frames before it arrive', () => {
    const queue = createFrameQueue(3, 0);

    expect(queue.accept(2, bytesOf(2))).toEqual([]);
  });

  it('writes a held frame right after the frame it waited for', () => {
    const queue = createFrameQueue(3, 0);
    queue.accept(2, bytesOf(2));
    queue.accept(0, bytesOf(0));

    expect(framesIn(queue.accept(1, bytesOf(1)))).toEqual([1, 2]);
  });

  it('names the first frame not yet written', () => {
    const queue = createFrameQueue(3, 0);
    queue.accept(0, bytesOf(0));
    queue.accept(2, bytesOf(2));

    expect(queue.next).toBe(1);
  });

  it('is incomplete while a frame is missing', () => {
    const queue = createFrameQueue(2, 0);
    queue.accept(0, bytesOf(0));

    expect(queue.complete).toBe(false);
  });

  it('is complete once every frame is written', () => {
    const queue = createFrameQueue(2, 0);
    queue.accept(1, bytesOf(1));
    queue.accept(0, bytesOf(0));

    expect(queue.complete).toBe(true);
  });

  it('refuses a frame that arrives twice', () => {
    const queue = createFrameQueue(3, 0);
    queue.accept(2, bytesOf(2));

    expect(() => queue.accept(2, bytesOf(2))).toThrow('frame 2 arrived twice');
  });

  it('refuses a frame already written', () => {
    const queue = createFrameQueue(3, 0);
    queue.accept(0, bytesOf(0));

    expect(() => queue.accept(0, bytesOf(0))).toThrow('frame 0 arrived twice');
  });

  it('accepts the last frame of the film', () => {
    const queue = createFrameQueue(3, 0);

    expect(queue.accept(2, bytesOf(2))).toEqual([]);
  });

  it('refuses the frame one past the last', () => {
    const queue = createFrameQueue(3, 0);

    expect(() => queue.accept(3, bytesOf(3))).toThrow(
      'frame 3 is not a frame of the film, which runs from 0 to 2'
    );
  });

  it('refuses a frame before the first', () => {
    const queue = createFrameQueue(3, 0);

    expect(() => queue.accept(-1, bytesOf(0))).toThrow('frame -1 is not a frame of the film');
  });

  it('refuses NaN as a frame', () => {
    const queue = createFrameQueue(3, 0);

    expect(() => queue.accept(Number.NaN, bytesOf(0))).toThrow('frame NaN is not a frame');
  });
});
