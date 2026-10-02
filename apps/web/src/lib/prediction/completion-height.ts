import { TEXTAREA_MIRROR_CLASSES, TEXTAREA_WRAP_CLASSES } from '@hushbox/ui';

/**
 * The height, in px, a transparent-mirror overlay needs to show `text` inside
 * a composer as wide as `textarea`'s own rendered box.
 *
 * Built the same way the textarea primitive's own cross-engine sizing replica
 * is: an invisible, identically-classed node measures the real wrap instead of
 * a byte or line-count estimate, which a font, a locale or the accessibility
 * widget's type scale would throw off. Out of flow and appended to
 * `document.body` rather than beside the textarea, so a synchronous
 * measurement never touches a subtree React itself manages.
 */
export function measureMirroredHeight(textarea: HTMLTextAreaElement, text: string): number {
  const replica = document.createElement('div');
  replica.setAttribute('aria-hidden', 'true');
  replica.className = `invisible fixed top-0 left-0 ${TEXTAREA_WRAP_CLASSES} ${TEXTAREA_MIRROR_CLASSES}`;
  replica.style.width = `${String(textarea.getBoundingClientRect().width)}px`;
  replica.textContent = text;
  document.body.append(replica);
  const height = replica.scrollHeight;
  replica.remove();
  return height;
}
