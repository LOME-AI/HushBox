/**
 * Apply / remove "mute all sounds" mode.
 *
 * - Mutes every existing `<audio>` and `<video>` in the document.
 * - A `MutationObserver` mutes media inserted after install.
 * - Cancels any in-flight TTS via the `onMute` callback (the TTS service owns
 *   its own AudioContext and is the only known source of WebAudio output in
 *   this app).
 *
 * Returns a cleanup function that disconnects the observer and restores each
 * tracked element to its original `muted` value.
 *
 * Note: there is no global API to enumerate every `AudioContext` on the page,
 * so generic AudioContext suspension is intentionally out of scope for v1.
 * The TTS engine has its own context and is stopped via `onMute`.
 */

interface InstallMutePauserOptions {
  /** Optional callback to cancel in-flight TTS speech. */
  onMute?: () => void;
}

export function installMutePauser(options: InstallMutePauserOptions = {}): () => void {
  const previouslyMuted = new WeakMap<HTMLMediaElement, boolean>();

  function muteElement(element: HTMLMediaElement): void {
    if (!previouslyMuted.has(element)) previouslyMuted.set(element, element.muted);
    element.muted = true;
  }

  function unmuteElement(element: HTMLMediaElement): void {
    const previous = previouslyMuted.get(element);
    if (previous !== undefined) element.muted = previous;
  }

  function muteAllUnder(root: ParentNode): void {
    for (const element of root.querySelectorAll<HTMLMediaElement>('audio, video')) {
      muteElement(element);
    }
  }

  muteAllUnder(document);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;
        if (node instanceof HTMLMediaElement) muteElement(node);
        muteAllUnder(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  options.onMute?.();

  return () => {
    observer.disconnect();
    for (const element of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
      unmuteElement(element);
    }
  };
}
