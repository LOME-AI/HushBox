import './contrast-surface-tokens.css';

/**
 * Real-browser fixture for `contrast-surface-tokens.browser.test.ts`. It loads the app's
 * real stylesheet and exposes, per `<html>` class combination, what the sidebar rail and
 * its hover fill actually resolve to.
 *
 * The hover fill's colour is an opacity-modified token, which serialises as an `oklab()`
 * mix with an alpha channel; turning that into the sRGB the user sees means compositing
 * it over the rail. That conversion is handed to the browser's own canvas parser rather
 * than reimplemented here, so the numbers this fixture reports are the engine's.
 *
 * Test infrastructure, not shipped runtime, and not exempted from lint — it is served to
 * a real browser and never imported by the Node test process, so V8 coverage
 * instrumentation cannot observe it executing; `apps/web/vitest.config.ts` excludes
 * `src/**\/*-fixture/**` from the coverage gate for exactly that reason.
 */

/**
 * Painted immediately before every colour under test and read back afterwards. A canvas
 * silently ignores a `fillStyle` it cannot parse, leaving the previous colour in place —
 * which would paint this value and report a difference that came from nowhere — so an
 * unchanged read-back is the signal that the colour was rejected.
 */
const PARSE_SENTINEL = '#123456';

const probe = document.createElement('canvas');
probe.width = 1;
probe.height = 1;
const context = probe.getContext('2d', { willReadFrequently: true });
if (context === null) throw new Error('the fixture canvas has no 2d context');
const ctx = context;

interface Pixel {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Paints `colors` in order onto one cleared transparent pixel and reads the result. */
function paint(colors: readonly string[]): Pixel {
  ctx.clearRect(0, 0, 1, 1);
  for (const color of colors) {
    ctx.fillStyle = PARSE_SENTINEL;
    ctx.fillStyle = color;
    if (ctx.fillStyle === PARSE_SENTINEL) {
      throw new Error(`the canvas parser rejected a computed colour: ${color}`);
    }
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
  if (r === undefined || g === undefined || b === undefined || a === undefined) {
    throw new Error('the fixture canvas returned no pixel');
  }
  return { r, g, b, a };
}

function requireElement(id: string): Element {
  const element = document.querySelector(`#${id}`);
  if (element === null) throw new Error(`missing element ${id}`);
  return element;
}

function addTierClassesOf(selectorText: string, found: Set<string>): void {
  for (const match of selectorText.matchAll(/\.(a11y-contrast-[\w-]+)/g)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
}

/** Walks a rule list and the grouping rules (`@layer`, `@media`) nested inside it. */
function collectTierClasses(rules: CSSRuleList, found: Set<string>): void {
  for (const rule of rules) {
    if (rule instanceof CSSStyleRule) addTierClassesOf(rule.selectorText, found);
    else if (rule instanceof CSSGroupingRule) collectTierClasses(rule.cssRules, found);
  }
}

/**
 * Every contrast class the loaded stylesheet actually declares a block for, read out of
 * the CSSOM so a tier added to the stylesheet is measured here without a second edit.
 * The shared rule the tiers feed matches on an attribute substring and carries no class
 * of its own, so it contributes nothing to this set.
 */
function tierClasses(): string[] {
  const found = new Set<string>();
  for (const sheet of document.styleSheets) collectTierClasses(sheet.cssRules, found);
  return [...found].toSorted((left, right) => left.localeCompare(right));
}

function measure(className: string): {
  railComputed: string;
  fillComputed: string;
  rail: Pixel;
  fill: Pixel;
  composite: Pixel;
} {
  document.documentElement.className = className;
  const railComputed = getComputedStyle(requireElement('rail')).backgroundColor;
  const fillComputed = getComputedStyle(requireElement('hover-fill')).backgroundColor;
  return {
    railComputed,
    fillComputed,
    rail: paint([railComputed]),
    fill: paint([fillComputed]),
    composite: paint([railComputed, fillComputed]),
  };
}

declare global {
  // Optional: unset until this script finishes running — the property the driving test
  // polls to know the fixture page is ready.
  var __surfaces:
    | {
        tierClasses(): string[];
        measure(className: string): {
          railComputed: string;
          fillComputed: string;
          rail: Pixel;
          fill: Pixel;
          composite: Pixel;
        };
      }
    | undefined;
}

globalThis.__surfaces = { tierClasses, measure };
