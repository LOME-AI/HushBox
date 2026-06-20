/**
 * Demo-only focus-scroll guard. The demo runs the real app inside an iframe on
 * the marketing /welcome page, and the app focuses the composer (autofocus on
 * mount, re-focus when the input re-enables after each streamed reply, the
 * welcome-screen focus). A bare HTMLElement.focus() runs the browser's "scroll
 * the focused element into view" steps, which walk up every ancestor scroll
 * container AND cross the iframe boundary into the parent document — scrolling
 * /welcome on every demo turn. Forcing preventScroll in the demo's JS realm
 * drops only that scroll side-effect; focus still moves (caret, focus traps,
 * a11y intact). Scoped to the iframe realm, so the live app is untouched.
 * Returns a disposer that restores the native method.
 */
export function installFocusScrollGuard(): () => void {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- captured to re-bind via .call below; never invoked detached
  const nativeFocus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions): void {
    nativeFocus.call(this, { ...options, preventScroll: true });
  };
  return (): void => {
    HTMLElement.prototype.focus = nativeFocus;
  };
}
