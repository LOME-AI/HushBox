/** Rendered frames put in film order for the encoder's pipe. */
export interface FrameQueue {
  /** Takes one rendered frame; returns the buffers that can now be written, in order. */
  accept(frame: number, bytes: Uint8Array): Uint8Array[];
  /** The first frame not yet written: the one the pipe is waiting on. */
  readonly next: number;
  /** Whether every frame of the film has been written. */
  readonly complete: boolean;
}

/**
 * A queue for a film of `total` frames that writes each frame once the frames
 * before it are written, and writes frame 0 `lead` extra times ahead of the film.
 * A parallel render hands frames over in the order its tabs finish them.
 */
export function createFrameQueue(total: number, lead: number): FrameQueue {
  const held = new Map<number, Uint8Array>();
  let next = 0;
  return {
    accept(frame, bytes) {
      if (!(Number.isInteger(frame) && frame >= 0 && frame < total)) {
        throw new RangeError(
          `frame ${String(frame)} is not a frame of the film, which runs from 0 to ${String(total - 1)}`
        );
      }
      if (frame < next || held.has(frame)) {
        throw new RangeError(`frame ${String(frame)} arrived twice`);
      }
      held.set(frame, bytes);
      const ready: Uint8Array[] = [];
      for (let bytesOfNext = held.get(next); bytesOfNext !== undefined; ) {
        held.delete(next);
        const copies = next === 0 ? lead + 1 : 1;
        for (let copy = 0; copy < copies; copy++) {
          ready.push(bytesOfNext);
        }
        next += 1;
        bytesOfNext = held.get(next);
      }
      return ready;
    },
    get next() {
      return next;
    },
    get complete() {
      return next === total;
    },
  };
}
