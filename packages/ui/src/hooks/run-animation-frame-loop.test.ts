import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { useA11yStore } from '../components/accessibility/store';
import { runAnimationFrameLoop } from './run-animation-frame-loop';

describe('runAnimationFrameLoop', () => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCAF = globalThis.cancelAnimationFrame;
  const originalMatchMedia = globalThis.matchMedia;

  let frames: { id: number; callback: FrameRequestCallback }[];
  let nextFrameId: number;
  let requestSpy: ReturnType<typeof vi.fn<(callback: FrameRequestCallback) => number>>;
  let cancelSpy: ReturnType<typeof vi.fn<(id: number) => void>>;

  function stubFrames(): void {
    frames = [];
    nextFrameId = 1;
    requestSpy = vi.fn((callback: FrameRequestCallback): number => {
      const id = nextFrameId++;
      frames.push({ id, callback });
      return id;
    });
    cancelSpy = vi.fn((id: number): void => {
      frames = frames.filter((frame) => frame.id !== id);
    });
    vi.stubGlobal('requestAnimationFrame', requestSpy);
    vi.stubGlobal('cancelAnimationFrame', cancelSpy);
  }

  function stubMotionPreference(reduced: boolean): void {
    const query: MediaQueryList = {
      matches: reduced,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn((): boolean => true),
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn((): MediaQueryList => query)
    );
  }

  /** Every loop a test started, disposed after it so none outlives the test's stubs. */
  let loops: (() => void)[];

  function startLoop(...args: Parameters<typeof runAnimationFrameLoop>): () => void {
    const dispose = runAnimationFrameLoop(...args);
    loops.push(dispose);
    return dispose;
  }

  /** Runs the next queued frame at `timestamp`, as the browser would. */
  function runFrame(timestamp: number): void {
    const frame = frames.shift();
    frame?.callback(timestamp);
  }

  beforeEach(() => {
    loops = [];
    useA11yStore.getState().reset();
    stubFrames();
    stubMotionPreference(false);
  });

  afterEach(() => {
    for (const dispose of loops) dispose();
    vi.unstubAllGlobals();
    globalThis.requestAnimationFrame = originalRAF;
    globalThis.cancelAnimationFrame = originalCAF;
    globalThis.matchMedia = originalMatchMedia;
    useA11yStore.getState().reset();
  });

  it('starts by requesting a frame', () => {
    startLoop(vi.fn());

    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('hands the tick each frame timestamp', () => {
    const tick = vi.fn();
    startLoop(tick);

    runFrame(16);
    runFrame(32);

    expect(tick.mock.calls).toEqual([[16], [32]]);
  });

  it('keeps requesting frames while the tick returns nothing', () => {
    startLoop(vi.fn());

    runFrame(16);
    runFrame(32);

    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it('stops when the tick returns false', () => {
    const tick = vi.fn((): boolean => false);
    startLoop(tick);

    runFrame(16);

    expect({ ticks: tick.mock.calls.length, pending: frames.length }).toEqual({
      ticks: 1,
      pending: 0,
    });
  });

  it('keeps going when the tick returns true', () => {
    startLoop((): boolean => true);

    runFrame(16);

    expect(requestSpy).toHaveBeenCalledTimes(2);
  });

  it('cancels the pending frame when disposed', () => {
    const dispose = startLoop(vi.fn());

    dispose();

    expect(cancelSpy).toHaveBeenCalledWith(1);
  });

  it('requests no further frame when the tick disposes the loop itself', () => {
    let dispose = (): void => undefined;
    const tick = vi.fn((): undefined => {
      dispose();
    });
    dispose = startLoop(tick);

    runFrame(16);

    expect({ ticks: tick.mock.calls.length, pending: frames.length }).toEqual({
      ticks: 1,
      pending: 0,
    });
  });

  it('does not start under reduced motion', () => {
    stubMotionPreference(true);

    startLoop(vi.fn());

    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('pauses when reduced motion turns on', () => {
    const tick = vi.fn();
    startLoop(tick);
    runFrame(16);

    useA11yStore.getState().update({ stopAnimations: true });
    runFrame(32);

    expect({ ticks: tick.mock.calls.length, pending: frames.length }).toEqual({
      ticks: 1,
      pending: 0,
    });
  });

  it('resumes when reduced motion turns off again', () => {
    const tick = vi.fn();
    startLoop(tick);
    useA11yStore.getState().update({ stopAnimations: true });

    useA11yStore.getState().update({ stopAnimations: false });
    runFrame(48);

    expect(tick).toHaveBeenCalledWith(48);
  });

  it('stays stopped when reduced motion turns off after the tick ended the loop', () => {
    const tick = vi.fn((): boolean => false);
    startLoop(tick);
    runFrame(16);

    useA11yStore.getState().update({ stopAnimations: true });
    useA11yStore.getState().update({ stopAnimations: false });

    expect({ ticks: tick.mock.calls.length, pending: frames.length }).toEqual({
      ticks: 1,
      pending: 0,
    });
  });

  it('stays stopped when reduced motion turns off after disposal', () => {
    const dispose = startLoop(vi.fn());
    useA11yStore.getState().update({ stopAnimations: true });
    dispose();

    useA11yStore.getState().update({ stopAnimations: false });

    expect({ requested: requestSpy.mock.calls.length, pending: frames.length }).toEqual({
      requested: 1,
      pending: 0,
    });
  });

  it('runs under reduced motion when told not to respect it', () => {
    stubMotionPreference(true);
    const tick = vi.fn();

    startLoop(tick, { respectMotion: false });
    runFrame(16);

    expect(tick).toHaveBeenCalledWith(16);
  });

  it('ignores reduced motion turning on when told not to respect it', () => {
    const tick = vi.fn();
    startLoop(tick, { respectMotion: false });

    useA11yStore.getState().update({ stopAnimations: true });
    runFrame(16);

    expect(tick).toHaveBeenCalledWith(16);
  });

  it('is what the @hushbox/ui/animation-frame door exports', async () => {
    const door = await import('@hushbox/ui/animation-frame');

    expect(door.runAnimationFrameLoop).toBe(runAnimationFrameLoop);
  });
});
