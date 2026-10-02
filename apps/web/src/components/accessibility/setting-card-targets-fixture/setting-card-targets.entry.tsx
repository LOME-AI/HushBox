import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { SettingCard } from '../../../../../../packages/ui/src/components/accessibility/controls/setting-card';
import './setting-card-targets.css';

/**
 * Real-browser fixture for `setting-card-targets.browser.test.ts`. Mounts the shipped
 * `SettingCard` beside a static reconstruction of its resting markup, and
 * exposes what a pointer actually hits around each arrow and where each chevron and dot
 * sits inside its card.
 *
 * The card is reached by relative path because the package publishes it only inside the
 * accessibility panel, whose module graph carries the speech engine.
 *
 * Test infrastructure, not shipped runtime, and not exempted from lint: it is served to a
 * real browser and never imported by the Node test process, so V8 coverage cannot observe
 * it executing; `apps/web/vitest.config.ts` excludes `src/**\/*-fixture/**` from the
 * coverage gate for that reason.
 */

const OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'mid', label: 'Medium' },
  { value: 'on', label: 'On' },
] as const;

type OptionValue = (typeof OPTIONS)[number]['value'];

/** The distance between probe points; a hit extent is exact to within one step. */
const PROBE_STEP = 0.25;

/** Further than any target under test reaches from its centre. */
const PROBE_REACH = 40;

function ShippedCard(): React.JSX.Element {
  const [value, setValue] = useState<OptionValue>('off');
  return <SettingCard title="Contrast" options={OPTIONS} value={value} onChange={setValue} />;
}

/**
 * The card's resting markup before its arrows carried a hit area of their own: a
 * 2px-padded box around a 24px chevron. The shipped card's chevrons and dots must sit
 * exactly where these do.
 */
function RestingCard(): React.JSX.Element {
  const arrowClasses = 'inline-flex items-center justify-center rounded p-0.5 opacity-70';
  return (
    <button
      type="button"
      className="group border-foreground/20 bg-background text-foreground flex w-full cursor-pointer flex-col items-stretch gap-2 rounded-lg border-2 px-3 py-3 text-left"
    >
      <span className="text-xs font-medium opacity-80">Contrast</span>
      <span className="text-base font-semibold">Off</span>
      <span className="-mt-1 flex items-center justify-center gap-2">
        <span data-slot="setting-card-prev" className={arrowClasses}>
          <svg className="h-6 w-6" viewBox="0 0 24 24" />
        </span>
        <span data-slot="setting-card-dots" className="flex items-center gap-1.5">
          <span className="bg-foreground h-2 w-4 rounded-full" />
          <span className="bg-foreground/25 h-1.5 w-1.5 rounded-full" />
          <span className="bg-foreground/25 h-1.5 w-1.5 rounded-full" />
        </span>
        <span data-slot="setting-card-next" className={arrowClasses}>
          <svg className="h-6 w-6" viewBox="0 0 24 24" />
        </span>
      </span>
    </button>
  );
}

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`missing element ${selector}`);
  return element;
}

function hits(target: Element, x: number, y: number): boolean {
  const found = document.elementFromPoint(x, y);
  return found !== null && target.contains(found);
}

/** How far along one direction from the target's centre a pointer still lands on it. */
function reach(target: Element, dx: number, dy: number): number {
  const rect = target.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let last = 0;
  for (let distance = 0; distance <= PROBE_REACH; distance += PROBE_STEP) {
    if (!hits(target, cx + dx * distance, cy + dy * distance)) break;
    last = distance;
  }
  return last;
}

interface Extent {
  width: number;
  height: number;
}

/** The width and height of the region where a pointer lands on the arrow, through its centre. */
function hitExtent(slot: string): Extent {
  const arrow = requireElement(`#shipped [data-slot="${slot}"]`);
  return {
    width: reach(arrow, -1, 0) + reach(arrow, 1, 0) + PROBE_STEP,
    height: reach(arrow, 0, -1) + reach(arrow, 0, 1) + PROBE_STEP,
  };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Every chevron's and dot's box inside one card, relative to that card's corner. */
function restBoxes(containerId: string): Box[] {
  const card = requireElement(`#${containerId} button`);
  const origin = card.getBoundingClientRect();
  const parts = card.querySelectorAll(
    '[data-slot="setting-card-prev"] svg, [data-slot="setting-card-dots"] > span, [data-slot="setting-card-next"] svg'
  );
  return [...parts].map((part) => {
    const rect = part.getBoundingClientRect();
    return {
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      width: rect.width,
      height: rect.height,
    };
  });
}

function pointerIsCoarse(): boolean {
  return globalThis.matchMedia('(pointer: coarse)').matches;
}

/** The root font size in px, which every rem the card is built from resolves against. */
function rootPx(): number {
  return Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}

declare global {
  // Optional: unset until this script finishes running — the property the driving test
  // polls to know the fixture page has mounted.
  var __targets:
    | {
        hitExtent(slot: string): Extent;
        restBoxes(containerId: string): Box[];
        pointerIsCoarse(): boolean;
        rootPx(): number;
      }
    | undefined;
}

const shippedRoot = createRoot(requireElement('#shipped'));
const referenceRoot = createRoot(requireElement('#reference'));
flushSync(() => {
  shippedRoot.render(<ShippedCard />);
  referenceRoot.render(<RestingCard />);
});

globalThis.__targets = { hitExtent, restBoxes, pointerIsCoarse, rootPx };
