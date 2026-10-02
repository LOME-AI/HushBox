import { describe, it, expect, vi, afterEach } from 'vitest';
import { installFocusScrollGuard } from './focus-scroll-guard';

const nativeFocus = HTMLElement.prototype.focus;
afterEach(() => {
  HTMLElement.prototype.focus = nativeFocus;
});

describe('installFocusScrollGuard', () => {
  it('forces preventScroll when focus is called with no options', () => {
    const spy = vi.fn();
    HTMLElement.prototype.focus = spy;
    installFocusScrollGuard();

    document.createElement('input').focus();

    expect(spy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('overrides a caller that explicitly passes preventScroll: false', () => {
    const spy = vi.fn();
    HTMLElement.prototype.focus = spy;
    installFocusScrollGuard();

    document.createElement('input').focus({ preventScroll: false });

    expect(spy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('focuses the element the call targeted (preserves `this`)', () => {
    const spy = vi.fn();
    HTMLElement.prototype.focus = spy;
    installFocusScrollGuard();
    const el = document.createElement('input');

    el.focus();

    expect(spy.mock.instances[0]).toBe(el);
  });

  it('restores the native focus when disposed', () => {
    const spy = vi.fn();
    HTMLElement.prototype.focus = spy;
    const dispose = installFocusScrollGuard();

    dispose();

    expect(HTMLElement.prototype.focus).toBe(spy);
  });
});
