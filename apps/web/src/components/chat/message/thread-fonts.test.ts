import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SECOND_MS, TEST_DAY_START, freezeClock } from '@hushbox/shared/test-time';
import { waitForThreadFonts } from '@/components/chat/message/thread-fonts';

/** The part of the document's font set the wait reads. */
type FontSetContract = Pick<FontFaceSet, 'status' | 'addEventListener' | 'removeEventListener'>;

/** A font set whose status a test sets, and whose loading events it dispatches. */
class FakeFontSet extends EventTarget implements FontSetContract {
  status: FontFaceSetLoadStatus = 'loading';

  finish(event: 'loadingdone' | 'loadingerror'): void {
    this.status = 'loaded';
    this.dispatchEvent(new Event(event));
  }
}

function installFontSet(): FakeFontSet {
  const fonts = new FakeFontSet();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  return fonts;
}

describe('waitForThreadFonts', () => {
  beforeEach(() => {
    freezeClock(TEST_DAY_START);
  });

  afterEach(() => {
    Reflect.deleteProperty(document, 'fonts');
    vi.useRealTimers();
  });

  it('holds while the document is loading fonts', () => {
    installFontSet();
    const wait = waitForThreadFonts(vi.fn<() => void>());
    expect(wait.holds()).toBe(true);
  });

  it('holds no longer once the document has loaded its fonts', () => {
    const fonts = installFontSet();
    const wait = waitForThreadFonts(vi.fn<() => void>());
    fonts.status = 'loaded';
    expect(wait.holds()).toBe(false);
  });

  it('never holds in a document without a font set', () => {
    const wait = waitForThreadFonts(vi.fn<() => void>());
    expect(wait.holds()).toBe(false);
  });

  it('starts no timer in a document without a font set', () => {
    waitForThreadFonts(vi.fn<() => void>());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tells its caller when the fonts finish loading', () => {
    const fonts = installFontSet();
    const onSettle = vi.fn<() => void>();
    waitForThreadFonts(onSettle);
    fonts.finish('loadingdone');
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('tells its caller when a font fails to load', () => {
    const fonts = installFontSet();
    const onSettle = vi.fn<() => void>();
    waitForThreadFonts(onSettle);
    fonts.finish('loadingerror');
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('still holds just short of 2 s while the fonts are loading', () => {
    installFontSet();
    const wait = waitForThreadFonts(vi.fn<() => void>());
    vi.advanceTimersByTime(2 * SECOND_MS - 1);
    expect(wait.holds()).toBe(true);
  });

  it('holds no longer 2 s after it starts, though the fonts are still loading', () => {
    installFontSet();
    const wait = waitForThreadFonts(vi.fn<() => void>());
    vi.advanceTimersByTime(2 * SECOND_MS);
    expect(wait.holds()).toBe(false);
  });

  it('tells its caller when its 2 s are up', () => {
    installFontSet();
    const onSettle = vi.fn<() => void>();
    waitForThreadFonts(onSettle);
    vi.advanceTimersByTime(2 * SECOND_MS);
    expect(onSettle).toHaveBeenCalledTimes(1);
  });

  it('tells its caller nothing after it is released', () => {
    const fonts = installFontSet();
    const onSettle = vi.fn<() => void>();
    const wait = waitForThreadFonts(onSettle);
    wait.release();
    fonts.finish('loadingdone');
    fonts.finish('loadingerror');
    vi.advanceTimersByTime(2 * SECOND_MS);
    expect(onSettle).not.toHaveBeenCalled();
  });
});
