import { useContext, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SettingCard } from '../../../../../../packages/ui/src/components/accessibility/controls/setting-card';
import { AccessibilityPreview } from '../../accessibility/accessibility-preview';
import { PageBody, PinnedBandHeightContext } from '../page-body';
import './page-body.css';

/**
 * Real-browser fixture for `page-body.browser.test.ts`: a page under a 5rem header, whose pinned
 * band's content is `band=<rem>` tall, so the band's share of the scroller follows the viewport
 * and the text size as a real page's does. `sticky=<rem>` adds a part of the band that sticks on
 * its own below 768 while the page pins it, marked and decided as `AccessibilityPreview` is,
 * below the part that scrolls away. `preview` adds /accessibility's own preview as that part
 * instead, with the reply link whose keyboard focus lifts its clamp and grows it. `lead=<rem>`
 * puts text with no control above the cards, as a section's heading and summary do. `classes`
 * adds the widget's other classes (comma-separated) and `face` its font, as the widget sets them.
 * `tall=<rem>` puts a control that tall before the cards, as a Quick starts card grows at the
 * widget's extremes.
 * `scale=141` sets the text scale the way the
 * accessibility widget's class does; `setScale` changes it on the live page. A resize observer
 * created after the page mounts records the band's position each time it sees the band resize,
 * as the one `useSectionInView` holds a hash arrival with reads it. The page's content is the
 * accessibility panel's own `SettingCard`, repeated, so a Tab walk moves through the controls
 * /accessibility pins its band over; the card is reached by relative path because the package
 * publishes it only inside the panel, whose module graph carries the speech engine.
 *
 * Test infrastructure, not shipped runtime: it is served to a real browser and never
 * imported by the Node test process, so `apps/web/vitest.config.ts` excludes
 * `src/**\/*-fixture/**` from the coverage gate.
 */

const SCALE_PREFIX = 'a11y-font-scale-';
const CARD_TITLES = Array.from({ length: 24 }, (_, index) => `Setting ${String(index + 1)}`);
const OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'on', label: 'On' },
] as const;

type OptionValue = (typeof OPTIONS)[number]['value'];

function Card({ title }: Readonly<{ title: string }>): React.JSX.Element {
  const [value, setValue] = useState<OptionValue>('off');
  return <SettingCard title={title} options={OPTIONS} value={value} onChange={setValue} />;
}

function setScale(scale: string | null): void {
  const classes = document.documentElement.classList;
  classes.remove(...[...classes].filter((name) => name.startsWith(SCALE_PREFIX)));
  if (scale !== null) classes.add(`${SCALE_PREFIX}${scale}`);
}

const query = new URLSearchParams(globalThis.location.search);
setScale(query.get('scale'));
// The widget's other settings, as its classes on `<html>` and its face variable set them.
for (const name of query.get('classes')?.split(',') ?? [])
  document.documentElement.classList.add(name);
const face = query.get('face');
if (face !== null) {
  document.documentElement.classList.add('a11y-font-override');
  document.documentElement.style.setProperty('--a11y-font-family', `"${face}"`);
}
function bandHeight(): string {
  const rem = query.get('band');
  if (rem === null) throw new Error('the fixture needs band=<rem>');
  return `${rem}rem`;
}
const BAND_HEIGHT = bandHeight();
const STICKY_REM = query.get('sticky');
const WITH_PREVIEW = query.get('preview') !== null;
const LEAD_REM = query.get('lead');
const TALL_REM = query.get('tall');

/** The band's part that sticks on its own below 768 while the page pins it, as the preview does. */
function StickyPart({ rem }: Readonly<{ rem: string }>): React.JSX.Element {
  const pinned = useContext(PinnedBandHeightContext) !== null;
  return (
    <div
      data-page-pinned-sticky=""
      className={`bg-background max-md:z-sticky ${pinned ? 'max-md:sticky max-md:top-0' : ''}`}
      style={{ height: `${rem}rem` }}
    >
      Sticks
    </div>
  );
}

function Fixture(): React.JSX.Element {
  // The frame clips more than it shows, as the app's shell does, so a scroll that reaches past the
  // page body moves it and shows up in `frameScrollTop`.
  return (
    <div id="frame" className="h-dvh overflow-hidden">
      <div className="bg-background text-foreground flex h-dvh flex-col">
        <header className="border-border h-20 shrink-0 border-b">Header</header>
        <PageBody
          pinned={
            <>
              <div style={{ height: BAND_HEIGHT }}>Pinned</div>
              {STICKY_REM === null ? null : <StickyPart rem={STICKY_REM} />}
              {WITH_PREVIEW ? <AccessibilityPreview /> : null}
            </>
          }
        >
          {LEAD_REM === null ? null : <p style={{ height: `${LEAD_REM}rem` }}>Lead</p>}
          {TALL_REM === null ? null : (
            <button type="button" style={{ height: `${TALL_REM}rem` }}>
              Tall control
            </button>
          )}
          <div className="grid grid-cols-1 gap-2">
            {CARD_TITLES.map((title) => (
              <Card key={title} title={title} />
            ))}
          </div>
        </PageBody>
      </div>
      <div className="h-dvh">Below the frame</div>
    </div>
  );
}

function required(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`missing element ${selector}`);
  return element;
}

interface Reading {
  position: string;
  /** The band's top edge, measured from the scroller's top edge. */
  top: number;
  bandHeight: number;
  scrollerHeight: number;
  scrollTop: number;
  /** How far the frame around the page body has scrolled, which nothing should do. */
  frameScrollTop: number;
}

function read(): Reading {
  const scroller = required('[data-page-scroller]');
  const band = required('[data-page-pinned]');
  return {
    position: getComputedStyle(band).position,
    top: band.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    bandHeight: band.offsetHeight,
    scrollerHeight: scroller.clientHeight,
    scrollTop: scroller.scrollTop,
    frameScrollTop: required('#frame').scrollTop,
  };
}

/**
 * The bottom edge of what covers the scroller's top: the band while it sticks, else the part of
 * it that sticks on its own, else nothing, which leaves the scroller's own top edge.
 */
function coveredTo(band: HTMLElement, scroller: HTMLElement): number {
  const covering = [band, band.querySelector<HTMLElement>('[data-page-pinned-sticky]')].find(
    (element) => element !== null && getComputedStyle(element).position === 'sticky'
  );
  return (covering ?? scroller).getBoundingClientRect()[covering ? 'bottom' : 'top'];
}

/**
 * The focused control's top edge and the bottom edge of what covers the scroller's top, if a
 * content control has focus.
 */
function focusAgainstBand(): { control: number; band: number } | null {
  const band = required('[data-page-pinned]');
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || band.contains(focused)) return null;
  // Firefox gives the scroller itself a tab stop; it holds the band, so it is no control under it.
  const scroller = required('[data-page-scroller]');
  if (focused === scroller || !scroller.contains(focused)) return null;
  return {
    control: focused.getBoundingClientRect().top,
    band: coveredTo(band, scroller),
  };
}

/** The focused element's box against the scroller's, wherever in the scroller it sits. */
function focusedAgainstScroller(): { top: number; bottom: number; inBand: boolean } | null {
  const scroller = required('[data-page-scroller]');
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || focused === scroller || !scroller.contains(focused)) {
    return null;
  }
  const box = scroller.getBoundingClientRect();
  const rect = focused.getBoundingClientRect();
  return {
    top: rect.top - box.top,
    bottom: box.bottom - rect.bottom,
    inBand: required('[data-page-pinned]').contains(focused),
  };
}

/** Whether focus is inside the band's part that sticks on its own. */
function focusInsideStickyPart(): boolean {
  const part = document.querySelector('[data-page-pinned-sticky]');
  return part?.contains(document.activeElement) === true;
}

/** Focuses the page's last control, the start of a walk back with Shift+Tab. */
function focusLast(): number {
  const controls = [
    ...required('[data-page-scroller]').querySelectorAll<HTMLElement>('button'),
  ].filter((control) => !required('[data-page-pinned]').contains(control));
  controls.at(-1)?.focus();
  return controls.length;
}

function scrollTo(top: number): void {
  required('[data-page-scroller]').scrollTop = top;
}

declare global {
  // Optional: unset until this script finishes running — the property the driving test
  // polls to know the fixture page has mounted.
  var __pageBody:
    | {
        read(): Reading;
        focusAgainstBand(): { control: number; band: number } | null;
        /** Focuses the last content control and returns how many content controls there are. */
        focusLast(): number;
        focusInsideStickyPart(): boolean;
        /**
         * How far the focused element's top lies below the scroller's top and its bottom above the
         * scroller's bottom; negative is cut off.
         */
        focusedAgainstScroller(): { top: number; bottom: number; inBand: boolean } | null;
        scrollTo(top: number): void;
        setScale(scale: string | null): void;
        /** The band's position as a later resize observer saw it, in order. */
        laterObserverPositions: string[];
      }
    | undefined;
}

const reactRoot = createRoot(required('#root'));
flushSync(() => {
  reactRoot.render(<Fixture />);
});

const laterObserverPositions: string[] = [];
const band = required('[data-page-pinned]');
new ResizeObserver(() => {
  laterObserverPositions.push(getComputedStyle(band).position);
}).observe(band);

globalThis.__pageBody = {
  read,
  focusAgainstBand,
  focusLast,
  focusInsideStickyPart,
  focusedAgainstScroller,
  scrollTo,
  setScale,
  laterObserverPositions,
};
