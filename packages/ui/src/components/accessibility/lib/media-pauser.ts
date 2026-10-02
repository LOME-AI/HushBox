/**
 * Pauses all autoplaying media when called and prevents new autoplay media from playing.
 * Returns a cleanup function that disconnects the observer (existing media stays paused).
 *
 * Used when accessibility "stop animations" is enabled — autoplay video/audio are a form
 * of motion that the canonical CSS rule doesn't catch.
 */

const AUTOPLAY_SELECTOR = 'video[autoplay], audio[autoplay]';

function pauseMedia(el: HTMLMediaElement): void {
  el.removeAttribute('autoplay');
  el.pause();
}

function pauseAutoplayDescendants(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLMediaElement>(AUTOPLAY_SELECTOR)) {
    pauseMedia(el);
  }
}

function pauseAddedNode(node: Node): void {
  if (!(node instanceof Element)) return;
  if (node instanceof HTMLMediaElement && node.autoplay) pauseMedia(node);
  pauseAutoplayDescendants(node);
}

function handleMutations(mutations: MutationRecord[]): void {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      pauseAddedNode(node);
    }
  }
}

export function installMediaPauser(): () => void {
  // Pause existing autoplay media
  pauseAutoplayDescendants(document);

  // Pause SVG <animate> / <animateTransform>. `endElement` is part of the SVG
  // animation API but is missing in jsdom and some other minimal implementations,
  // so we runtime-check before invoking even though the static type asserts it exists.
  for (const el of document.querySelectorAll<SVGAnimationElement>(
    'svg animate, svg animateTransform'
  )) {
    const maybeEnd = (el as { endElement?: () => void }).endElement;
    if (typeof maybeEnd === 'function') maybeEnd.call(el);
  }

  // Watch for newly-inserted autoplay media
  const observer = new MutationObserver(handleMutations);
  observer.observe(document.body, { childList: true, subtree: true });

  return () => {
    observer.disconnect();
  };
}
