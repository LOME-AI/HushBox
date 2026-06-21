/**
 * Apply / remove "mute all sounds" mode.
 *
 * - Mutes every existing `<audio>` and `<video>` in the document.
 * - A `MutationObserver` mutes media inserted after install.
 *
 * TTS read-aloud is intentionally exempt: "Mute all sounds" does NOT stop it.
 * The TTS service owns its own AudioContext, so muting media elements never
 * affects it, and the provider invokes this without the `onMute` callback by
 * design — toggling mute never interrupts speech the user started.
 *
 * Returns a cleanup function that disconnects the observer and restores each
 * tracked element to its original `muted` value.
 *
 * Note: there is no global API to enumerate every `AudioContext` on the page,
 * so generic AudioContext suspension is out of scope. The `onMute` parameter
 * is reserved for a future opt-in to cancel in-flight TTS but is currently
 * left unwired.
 */

interface InstallMutePauserOptions {
  /**
   * Optional callback to cancel in-flight TTS speech. Reserved by design and
   * intentionally left unwired by the provider: TTS read-aloud is exempt from
   * "Mute all sounds" so toggling mute never interrupts speech the user started.
   */
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
