import { type Page, type Locator } from '@playwright/test';
import { expect } from '../helpers/expect.js';

/**
 * The composer's sentence-completion surfaces: the hint drawn at the caret and
 * the candidate list under the composer.
 *
 * Everything here is a measurement or a wait, because everything this surface
 * can get wrong is geometric. The hint is drawn by a transparent mirror of the
 * textarea laid over it, so it lands in the right place only while the mirror
 * repeats the textarea's own type scale and padding — a property with no
 * observable consequence outside a browser that actually lays text out.
 */

/** Both surfaces mark their parts with `data-slot`, so the selectors follow. */
const OVERLAY = '[data-slot="prediction-overlay"]';
const MIRROR_PREFIX = '[data-slot="prediction-mirror-prefix"]';
const HINT = '[data-slot="prediction-text"]';
const SUGGESTION_ROW = '[data-slot="prediction-suggestion-row"]';
const SUGGESTION_SPACER = '[data-slot="prediction-suggestion-spacer"]';

/**
 * The typographic and box properties that decide where a glyph lands. The
 * mirror and the textarea must agree on every one of them or the two lay their
 * text out differently, which is the whole failure mode this surface has.
 */
export const LAYOUT_PROPERTIES = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'lineHeight',
  'letterSpacing',
  'wordSpacing',
  'textTransform',
  'whiteSpace',
  'overflowWrap',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
] as const;

export type LayoutProperties = Record<(typeof LAYOUT_PROPERTIES)[number], string>;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the hint's first glyph sits relative to the mirrored typed text's last. */
interface HintOffset {
  readonly dx: number;
  readonly dy: number;
}

/**
 * Sub-pixel slack for a comparison of two independently rounded client rects.
 * Engines round a text run's edges to device pixels, so two boxes that abut
 * exactly can still report edges a fraction apart; anything at or above a whole
 * pixel is a real gap.
 */
export const GLYPH_ALIGNMENT_TOLERANCE = 1;

function requireBox(box: Box | null, what: string): Box {
  if (box === null) throw new Error(`${what} has no bounding box — it is not rendered`);
  return box;
}

export class PromptPredictionPage {
  readonly page: Page;
  /** The transparent mirror of the composer that carries the hint. */
  readonly overlay: Locator;
  /** The predicted continuation drawn at the caret. */
  readonly hint: Locator;
  /** Every clickable row of the candidate list. */
  readonly suggestionRows: Locator;
  /**
   * The reserved copy of the candidate list that holds the composer still.
   * Invisible, but it lays out — that is its entire job.
   */
  readonly suggestionSpacer: Locator;
  /**
   * The greeting, located as the spacer's immediate next sibling. Written that
   * way deliberately: the composer only stays put while the reserved height and
   * the greeting share a wrapper with nothing between them, so a later edit that
   * separates the two leaves this locator matching nothing.
   */
  readonly greetingBesideSpacer: Locator;

  constructor(page: Page) {
    this.page = page;
    this.overlay = page.locator(OVERLAY);
    this.hint = page.locator(HINT);
    this.suggestionRows = page.locator(SUGGESTION_ROW);
    this.suggestionSpacer = page.locator(SUGGESTION_SPACER);
    this.greetingBesideSpacer = page.locator(`${SUGGESTION_SPACER} + [data-reading]`);
  }

  async expectHintVisible(): Promise<void> {
    await expect(this.hint).toBeVisible();
  }

  async expectHintHidden(): Promise<void> {
    await expect(this.hint).toBeHidden();
  }

  /**
   * The continuation currently on screen. Read as `textContent`, never
   * `innerText`: a completion legitimately opens with the space that separates
   * it from the typed text, and innerText would collapse it away.
   */
  async hintText(): Promise<string> {
    await this.expectHintVisible();
    const text = await this.hint.textContent();
    if (text === null || text === '') throw new Error('the prediction hint rendered no text');
    return text;
  }

  /** Waits for the candidate list to offer rows, which it does only from two up. */
  async expectListOpen(): Promise<void> {
    await expect(this.suggestionRows.first()).toBeVisible();
    await expect.poll(() => this.suggestionRows.count()).toBeGreaterThanOrEqual(2);
  }

  async expectListClosed(): Promise<void> {
    await expect(this.suggestionRows).toHaveCount(0);
  }

  async boxOf(locator: Locator, what: string): Promise<Box> {
    return requireBox(await locator.boundingBox(), what);
  }

  /**
   * Reads two elements' boxes from one synchronous browser-side read.
   * `boundingBox()` is its own round trip per call, so two sequential calls can
   * straddle a reflow still settling between them and report a gap neither
   * element actually held at any single instant — use this instead whenever
   * the two boxes are compared against each other.
   */
  async boxesOf(a: Locator, b: Locator, what: string): Promise<readonly [Box, Box]> {
    const [handleA, handleB] = await Promise.all([a.elementHandle(), b.elementHandle()]);
    if (handleA === null || handleB === null) {
      throw new Error(`${what} has no bounding box — it is not rendered`);
    }
    return this.page.evaluate(
      ([elA, elB]) => {
        const rectA = elA.getBoundingClientRect();
        const rectB = elB.getBoundingClientRect();
        return [
          { x: rectA.x, y: rectA.y, width: rectA.width, height: rectA.height },
          { x: rectB.x, y: rectB.y, width: rectB.width, height: rectB.height },
        ] as const;
      },
      [handleA, handleB] as const
    );
  }

  /**
   * How far the hint's first glyph sits from the end of the mirrored typed text.
   * Both edges come from the same laid-out line box, so a non-zero reading means
   * the browser put the prediction somewhere other than where the caret is.
   */
  async hintOffsetFromTypedText(): Promise<HintOffset> {
    return this.overlay.evaluate(
      (overlay, selectors) => {
        const prefix = overlay.querySelector(selectors.prefix);
        const hint = overlay.querySelector(selectors.hint);
        if (prefix === null || hint === null) {
          throw new Error('the mirror is missing its typed-text prefix or its hint');
        }
        const prefixRects = [...prefix.getClientRects()];
        const typedEnd = prefixRects.at(-1);
        const [hintStart] = hint.getClientRects();
        if (typedEnd === undefined || hintStart === undefined) {
          throw new Error('the mirror laid out no line boxes to compare');
        }
        return { dx: hintStart.left - typedEnd.right, dy: hintStart.top - typedEnd.top };
      },
      { prefix: MIRROR_PREFIX, hint: HINT }
    );
  }

  /** The layout-deciding computed style of one element. */
  async layoutPropertiesOf(locator: Locator): Promise<LayoutProperties> {
    return locator.evaluate((element, properties) => {
      const computed = globalThis.getComputedStyle(element);
      const read: Record<string, string> = {};
      // Indexed rather than read through `getPropertyValue`, which takes a CSS
      // property name: handed a camelCase one it returns the empty string for
      // every property, and comparing two such readings holds whatever the page
      // is doing.
      for (const property of properties) read[property] = computed[property];
      return read as LayoutProperties;
    }, LAYOUT_PROPERTIES);
  }

  /** Whether the composer has grown past its maximum height and scrolls its own text. */
  async composerScrollsInternally(composer: Locator): Promise<boolean> {
    return composer.evaluate(
      (element) => (element as HTMLTextAreaElement).scrollHeight > element.clientHeight
    );
  }

  /**
   * Grows the document's root font size by `factor`, the way the accessibility
   * widget's font-scale tiers do — those are nothing but a percentage on
   * `html`, and every type utility in the app derives from it in `rem`. Applied
   * to the live page rather than seeded before load, so the composer and its
   * mirror have to re-measure a scale change that arrives under them.
   */
  async growRootFontSize(factor: number): Promise<number> {
    return this.page.evaluate((multiplier) => {
      const root = document.documentElement;
      const current = Number.parseFloat(globalThis.getComputedStyle(root).fontSize);
      const grown = current * multiplier;
      root.style.fontSize = `${String(grown)}px`;
      return grown;
    }, factor);
  }

  /** The composer's resolved font size, in pixels. */
  async fontSizeOf(locator: Locator): Promise<number> {
    return locator.evaluate((element) =>
      Number.parseFloat(globalThis.getComputedStyle(element).fontSize)
    );
  }
}
