import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { PageBody } from '../page-body';
import './page-body.css';

/**
 * Real-browser fixture for `page-body.browser.test.ts`: a page under a header, whose pinned
 * band is 20rem tall, so at 768x900 it takes under half the scroller at 100% text and over half
 * at the widget's largest text. `scale=141` sets the text scale the way the accessibility
 * widget's class does; `setScale` changes it on the live page. A resize observer created after
 * the page mounts records the band's position each time it sees the band resize, as
 * `useSectionInView`'s does when it measures the band.
 *
 * Test infrastructure, not shipped runtime: it is served to a real browser and never
 * imported by the Node test process, so `apps/web/vitest.config.ts` excludes
 * `src/**\/*-fixture/**` from the coverage gate.
 */

const SCALE_PREFIX = 'a11y-font-scale-';
const ROWS = Array.from({ length: 60 }, (_, index) => `Row ${String(index + 1)}`);

function setScale(scale: string | null): void {
  const classes = document.documentElement.classList;
  for (const name of [...classes]) if (name.startsWith(SCALE_PREFIX)) classes.remove(name);
  if (scale !== null) classes.add(`${SCALE_PREFIX}${scale}`);
}

setScale(new URLSearchParams(globalThis.location.search).get('scale'));

function Fixture(): React.JSX.Element {
  return (
    <div className="bg-background text-foreground flex h-dvh flex-col">
      <header className="border-border h-20 shrink-0 border-b">Header</header>
      <PageBody pinned={<div className="h-80">Pinned</div>}>
        {ROWS.map((row) => (
          <p key={row}>{row}</p>
        ))}
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
}

function read(): Reading {
  const scroller = required('[data-page-scroller]');
  const band = required('[data-page-pinned]');
  return {
    position: getComputedStyle(band).position,
    top: band.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
    bandHeight: band.offsetHeight,
    scrollerHeight: scroller.clientHeight,
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

globalThis.__pageBody = { read, scrollTo, setScale, laterObserverPositions };
