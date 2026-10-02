/**
 * Apply / remove "mute all sounds" mode over the document's `<audio>`/`<video>`
 * elements, returning a cleanup that restores each one's original `muted` value.
 *
 * TTS read-aloud is out of reach by construction, not by omission: the TTS
 * service owns its own `AudioContext`, and there is no global API to enumerate
 * the page's audio contexts, so muting media elements cannot touch it.
 */
export function installMutePauser(): () => void {
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

  return () => {
    observer.disconnect();
    for (const element of document.querySelectorAll<HTMLMediaElement>('audio, video')) {
      unmuteElement(element);
    }
  };
}
