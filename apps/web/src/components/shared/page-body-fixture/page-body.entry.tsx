import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SettingCard } from '../../../../../../packages/ui/src/components/accessibility/controls/setting-card';
import { PageBody } from '../page-body';
import './page-body.css';

/**
 * Real-browser fixture for `page-body.browser.test.ts`: a page under a 5rem header, whose pinned
 * band's content is `band=<rem>` tall, so the band's share of the scroller follows the viewport
 * and the text size as a real page's does. `scale=141` sets the text scale the way the
 * accessibility widget's class does; `setScale` changes it on the live page. A resize observer created after
 * the page mounts records the band's position each time it sees the band resize, as
 * `useSectionInView`'s does when it measures the band. The page's content is the accessibility
 * panel's own `SettingCard`, repeated, so a Tab walk moves through the controls /accessibility
 * pins its band over; the card is reached by relative path because the package publishes it only
 * inside the panel, whose module graph carries the speech engine.
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
function bandHeight(): string {
  const rem = query.get('band');
  if (rem === null) throw new Error('the fixture needs band=<rem>');
  return `${rem}rem`;
}
const BAND_HEIGHT = bandHeight();

function Fixture(): React.JSX.Element {
  return (
    <div className="bg-background text-foreground flex h-dvh flex-col">
      <header className="border-border h-20 shrink-0 border-b">Header</header>
      <PageBody pinned={<div style={{ height: BAND_HEIGHT }}>Pinned</div>}>
        <div className="grid grid-cols-1 gap-2">
          {CARD_TITLES.map((title) => (
            <Card key={title} title={title} />
          ))}
        </div>
      </PageBody>
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
  };
}

/** The focused control's top edge and the band's bottom edge, if a content control has focus. */
function focusAgainstBand(): { control: number; band: number } | null {
  const band = required('[data-page-pinned]');
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || band.contains(focused)) return null;
  // Firefox gives the scroller itself a tab stop; it holds the band, so it is no control under it.
  const scroller = required('[data-page-scroller]');
  if (focused === scroller || !scroller.contains(focused)) return null;
  return {
    control: focused.getBoundingClientRect().top,
    band: band.getBoundingClientRect().bottom,
  };
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

globalThis.__pageBody = { read, focusAgainstBand, scrollTo, setScale, laterObserverPositions };
