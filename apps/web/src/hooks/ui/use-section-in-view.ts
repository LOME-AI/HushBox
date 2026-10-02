import * as React from 'react';
import { shouldReduceMotion } from '@hushbox/ui';

export const SETTINGS_SECTION_IDS = [
  'account',
  'security',
  'preferences',
  'notifications',
  'legal',
  'danger',
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** Space left between the pinned band and a section scrolled up to it. */
const SECTION_GAP_PX = 16;

/** Input that means the reader is scrolling by their own hand, which ends a held section. */
const READER_INPUT = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/** A move through the page's history, which ends a hold as the reader's own input does. */
const NAVIGATION = ['hashchange', 'popstate'] as const;

/** The mounted `useSectionInView` hooks, told of each requested section so they hold it. */
const requestListeners = new Set<(id: SettingsSectionId) => void>();

function sectionIn(ids: readonly SettingsSectionId[], hash: string): SettingsSectionId | null {
  const id = hash.replace(/^#/, '');
  return ids.find((candidate) => candidate === id) ?? null;
}

function pinnedHeight(scroller: HTMLElement): number {
  const band = scroller.querySelector<HTMLElement>('[data-page-pinned]');
  if (!band || getComputedStyle(band).position !== 'sticky') return 0;
  return band.offsetHeight;
}

function sectionScroller(ids: readonly SettingsSectionId[]): HTMLElement | null {
  for (const id of ids) {
    const scroller = document.querySelector(`#${id}`)?.closest<HTMLElement>('[data-page-scroller]');
    if (scroller) return scroller;
  }
  return null;
}

/** The scroll position that puts `target` just below the scroller's pinned band. */
function arrivalTop(target: HTMLElement, scroller: HTMLElement): number {
  const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  return scroller.scrollTop + offset - pinnedHeight(scroller) - SECTION_GAP_PX;
}

/**
 * Scrolls a section of the page to just below the pinned band, smoothly unless reduced
 * motion is on, moves focus to it, and holds it as the current section until the reader
 * scrolls by their own hand.
 */
export function scrollToSection(id: SettingsSectionId, instant = false): void {
  const target = document.querySelector<HTMLElement>(`#${id}`);
  const scroller = target?.closest<HTMLElement>('[data-page-scroller]');
  if (!target || !scroller) return;
  for (const listener of requestListeners) listener(id);
  scroller.scrollTo({
    top: arrivalTop(target, scroller),
    behavior: instant || shouldReduceMotion() ? 'instant' : 'smooth',
  });
  // Focus follows the jump, as a native fragment link's does, so the next Tab lands inside
  // the section; `:focus-visible` shows the outline only when a keyboard made the jump.
  target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
}

/**
 * The section in view: the topmost of `ids` whose element shows below the page scroller's
 * pinned band, which it measures while the band sticks (from 768) and counts as 0 while the
 * band scrolls with the page. A section requested by {@link scrollToSection}, or
 * named by the URL hash, stays current until the reader scrolls by their own hand or
 * navigates, so a section too near the page's end to reach the band still reads as current;
 * until then a hashed section also keeps its place under the band while the page grows.
 * Pass a stable `ids` array.
 */
export function useSectionInView(ids: readonly SettingsSectionId[]): SettingsSectionId {
  const [first] = ids;
  if (first === undefined) throw new Error('useSectionInView needs at least one section id');
  const [initialHashSection] = React.useState(() => sectionIn(ids, globalThis.location.hash));
  const [current, setCurrent] = React.useState<SettingsSectionId>(initialHashSection ?? first);
  const held = React.useRef<SettingsSectionId | null>(initialHashSection);
  const visible = React.useRef(new Set<string>());
  const [bandHeight, setBandHeight] = React.useState(0);

  const pick = React.useCallback(
    (): SettingsSectionId | undefined => held.current ?? ids.find((id) => visible.current.has(id)),
    [ids]
  );

  // Ends the hash section's hold on its place; set while that hold is live.
  const releasePlace = React.useRef<(() => void) | null>(null);

  React.useEffect(() => {
    const onRequest = (id: SettingsSectionId): void => {
      if (id !== held.current) releasePlace.current?.();
      held.current = id;
      setCurrent(id);
    };
    const onReaderInput = (): void => {
      releasePlace.current?.();
      held.current = null;
      const next = pick();
      if (next) setCurrent(next);
    };
    requestListeners.add(onRequest);
    for (const type of READER_INPUT) {
      globalThis.addEventListener(type, onReaderInput, { passive: true });
    }
    return (): void => {
      requestListeners.delete(onRequest);
      for (const type of READER_INPUT) globalThis.removeEventListener(type, onReaderInput);
    };
  }, [pick]);

  React.useEffect(() => {
    const scroller = sectionScroller(ids);
    const band = scroller?.querySelector('[data-page-pinned]');
    if (!scroller || !band) return;
    const measure = (): void => {
      setBandHeight(pinnedHeight(scroller));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(band);
    return (): void => {
      observer.disconnect();
    };
  }, [ids]);

  React.useEffect(() => {
    const elements = ids
      .map((id) => document.querySelector<HTMLElement>(`#${id}`))
      .filter((element): element is HTMLElement => element !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.current.add(entry.target.id);
          else visible.current.delete(entry.target.id);
        }
        const next = pick();
        if (next) setCurrent(next);
      },
      {
        root: sectionScroller(ids),
        rootMargin: `-${String(bandHeight)}px 0px 0px 0px`,
      }
    );
    for (const element of elements) observer.observe(element);
    return (): void => {
      observer.disconnect();
    };
  }, [ids, bandHeight, pick]);

  // Brings a hash-named section to its place under the band and holds it there while the page
  // grows, until the reader takes over or navigates.
  const arriveAt = React.useCallback((id: SettingsSectionId): void => {
    releasePlace.current?.();
    scrollToSection(id, true);
    const target = document.querySelector<HTMLElement>(`#${id}`);
    // An arrival by URL is no interaction, so it must draw no ring. Releasing focus in the same
    // task, before any paint, keeps the next Tab's starting point in the section, as a native
    // fragment arrival does; dropping the section's focusability stops the browser's own
    // fragment scroll from focusing it again, which Firefox does and then rings as focus-visible.
    target?.blur();
    target?.removeAttribute('tabindex');
    const scroller = target?.closest<HTMLElement>('[data-page-scroller]');
    const content = target?.parentElement;
    if (!target || !scroller || !content) return;

    // The arrival runs once, but the groups keep loading after it: until the reader takes over,
    // each resize brings the section back to its place, which also finishes an arrival the page
    // was still too short to complete. A browser's own fragment scroll can land after the
    // arrival too, so it must land at the same place: `PageBody` pads the scroller's top by the
    // pinned band's height, so the section's scroll margin carries the gap alone.
    target.style.scrollMarginTop = `${String(SECTION_GAP_PX)}px`;
    const restore = (): void => {
      scroller.scrollTo({ top: arrivalTop(target, scroller), behavior: 'instant' });
    };
    const observer = new ResizeObserver(restore);
    observer.observe(content);
    const band = scroller.querySelector('[data-page-pinned]');
    if (band) observer.observe(band);
    releasePlace.current = (): void => {
      observer.disconnect();
      releasePlace.current = null;
    };
  }, []);

  React.useEffect(() => {
    if (initialHashSection) arriveAt(initialHashSection);
    return (): void => {
      releasePlace.current?.();
    };
  }, [initialHashSection, arriveAt]);

  // A navigation is the reader acting: it ends any hold, and a hash naming a section arrives
  // there. The hash is only ever compared with the section ids, never used as it stands.
  React.useEffect(() => {
    const onNavigate = (): void => {
      const id = sectionIn(ids, globalThis.location.hash);
      if (id) {
        arriveAt(id);
        return;
      }
      releasePlace.current?.();
      held.current = null;
      const next = pick();
      if (next) setCurrent(next);
    };
    for (const type of NAVIGATION) globalThis.addEventListener(type, onNavigate);
    return (): void => {
      for (const type of NAVIGATION) globalThis.removeEventListener(type, onNavigate);
    };
  }, [ids, pick, arriveAt]);

  return current;
}
