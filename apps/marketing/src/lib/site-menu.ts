import { isMobileWidth } from '@hushbox/shared';
import { observeTextMetrics } from '@hushbox/ui/text-metrics';

/** Set on the header while the full nav does not fit its row; the stylesheet then shows the menu button. */
const COMPACT_ATTRIBUTE = 'data-nav-compact';

/** A nav that fits ends exactly at the row's content edge, give or take rounding. */
const SUBPIXEL_SLACK = 0.5;

function requirePart(root: HTMLElement, attribute: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[${attribute}]`);
  if (element === null) throw new Error(`initSiteMenu: the header has no [${attribute}] element`);
  return element;
}

/**
 * Runs the site header: the menu button opens and closes the menu panel, and from 768 the
 * header shows the full nav only while it fits its row, falling back to the menu button
 * otherwise. Returns a disposer.
 */
export function initSiteMenu(root: HTMLElement): () => void {
  const row = requirePart(root, 'data-site-header-row');
  const nav = requirePart(root, 'data-site-nav');
  const toggle = requirePart(root, 'data-site-menu-toggle');
  const panel = requirePart(root, 'data-site-menu-panel');
  const html = document.documentElement;
  const behind = [...(root.parentElement?.children ?? [])].filter((element) =>
    element.matches('main, footer')
  );
  let open = false;
  let lockedStyles = { overflow: '', scrollbarGutter: '' };

  const show = (): void => {
    open = true;
    panel.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
    lockedStyles = { overflow: html.style.overflow, scrollbarGutter: html.style.scrollbarGutter };
    html.style.overflow = 'hidden';
    html.style.scrollbarGutter = 'stable';
    for (const element of behind) element.toggleAttribute('inert', true);
  };

  const hide = (returnFocus: boolean): void => {
    open = false;
    panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
    html.style.overflow = lockedStyles.overflow;
    html.style.scrollbarGutter = lockedStyles.scrollbarGutter;
    for (const element of behind) element.toggleAttribute('inert', false);
    if (returnFocus) toggle.focus();
  };

  const onToggle = (): void => {
    if (open) hide(true);
    else show();
  };

  // The accessibility widget sits above the panel and answers Escape itself.
  const onKeydown = (event: KeyboardEvent): void => {
    if (!open || event.key !== 'Escape') return;
    const target = event.target;
    if (target === document.body || (target instanceof Node && root.contains(target))) hide(true);
  };

  // A width threshold cannot tell whether the nav fits: the widget's text size and font
  // face change its width at every viewport width. So the full nav is laid out and read,
  // synchronously, before the header settles on a layout. The nav's edge is read rather
  // than the row's scroll width, which does not count the end padding a nav runs into.
  const navFits = (): boolean => {
    const rowEnd =
      row.getBoundingClientRect().right - Number.parseFloat(getComputedStyle(row).paddingRight);
    return nav.getBoundingClientRect().right <= rowEnd + SUBPIXEL_SLACK;
  };

  const measure = (): void => {
    root.removeAttribute(COMPACT_ATTRIBUTE);
    const fits = isMobileWidth(window.innerWidth) || navFits();
    if (!fits) root.setAttribute(COMPACT_ATTRIBUTE, '');
    if (open && fits && !isMobileWidth(window.innerWidth)) {
      hide(document.activeElement !== null && panel.contains(document.activeElement));
    }
    // Only a changed value is written: the text-metric observer watches the root element's style.
    const height = `${String(root.offsetHeight)}px`;
    if (html.style.getPropertyValue('--header-height') !== height) {
      html.style.setProperty('--header-height', height);
    }
  };

  toggle.addEventListener('click', onToggle);
  document.addEventListener('keydown', onKeydown);
  const releaseTextMetrics = observeTextMetrics(measure);
  measure();

  return () => {
    toggle.removeEventListener('click', onToggle);
    document.removeEventListener('keydown', onKeydown);
    releaseTextMetrics();
    if (open) hide(false);
  };
}
