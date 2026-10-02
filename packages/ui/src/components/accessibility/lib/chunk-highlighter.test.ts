import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { contrastRatio, parseCssColor } from '@hushbox/shared/color/contrast';

import { createChunkHighlighter } from './chunk-highlighter';
import { normalizeForSpeech } from './text-normalizer';
import { useA11yStore } from '../store';

const HIGHLIGHT_NAME = 'tts-reading';
const BLOCK_CLASS = 'tts-reading-block';

const libraryDir = path.dirname(fileURLToPath(import.meta.url));

/** A stand-in for the browser's Highlight: a set of ranges the registry holds. */
class FakeHighlight {
  readonly ranges: readonly Range[];
  constructor(...ranges: Range[]) {
    this.ranges = ranges;
  }
}

/**
 * Install a fake CSS Custom Highlight API for the duration of a test. happy-dom
 * ships no `CSS.highlights`/`Highlight`, so the highlighter's feature detection
 * falls to the block-class path unless we inject these. Cleared by
 * `vi.unstubAllGlobals()` in afterEach.
 */
function installHighlightApi(): Map<string, FakeHighlight> {
  const registry = new Map<string, FakeHighlight>();
  vi.stubGlobal('CSS', { highlights: registry });
  vi.stubGlobal('Highlight', FakeHighlight);
  return registry;
}

function registeredRange(registry: Map<string, FakeHighlight>): Range {
  const entry = registry.get(HIGHLIGHT_NAME);
  if (entry === undefined) throw new Error('no highlight registered');
  const range = entry.ranges.at(0);
  if (range === undefined) throw new Error('highlight has no range');
  return range;
}

/** Render `html` inside a container and return the container plus a block picker. */
function mount(html: string): { container: HTMLElement; block: (selector: string) => HTMLElement } {
  document.body.innerHTML = `<article data-reading>${html}</article>`;
  const container = document.body.querySelector('article');
  if (container === null) throw new Error('no container');
  return {
    container,
    block: (selector) => {
      const el = container.querySelector<HTMLElement>(selector);
      if (el === null) throw new Error(`no block: ${selector}`);
      return el;
    },
  };
}

/** Offsets of a normalized piece within a block, exactly as the reader emits them. */
function spanOf(block: HTMLElement, piece: string): { startOffset: number; endOffset: number } {
  const startOffset = normalizeForSpeech(block.textContent).indexOf(piece);
  return { startOffset, endOffset: startOffset + piece.length };
}

function setViewportRect(el: HTMLElement, top: number, bottom: number): void {
  el.getBoundingClientRect = (): DOMRect =>
    ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top }) as DOMRect;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  useA11yStore.setState({ stopAnimations: false });
});

describe('createChunkHighlighter — block-class fallback (no Highlight API)', () => {
  it('adds the reading block class to the highlighted block', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(p.classList.contains(BLOCK_CLASS)).toBe(true);
  });

  it('clear() removes the block class', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);
    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    hl.clear();

    expect(p.classList.contains(BLOCK_CLASS)).toBe(false);
  });

  it('moves the highlight off the previous block when a new block is highlighted', () => {
    const { container, block } = mount('<p id="a">First one.</p><p id="b">Second one.</p>');
    const first = block('#a');
    const second = block('#b');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: first, ...spanOf(first, 'First one.') });
    hl.highlight({ blockEl: second, ...spanOf(second, 'Second one.') });

    expect(first.classList.contains(BLOCK_CLASS)).toBe(false);
    expect(second.classList.contains(BLOCK_CLASS)).toBe(true);
  });
});

describe('createChunkHighlighter — CSS Custom Highlight API path', () => {
  it('builds a Range covering exactly the chunk span across inline elements', () => {
    const registry = installHighlightApi();
    const { container, block } = mount(
      '<p id="a">Hello <a href="#">world</a> and <code>foo</code> bar.</p>'
    );
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'world and foo') });

    expect(registeredRange(registry).toString()).toBe('world and foo');
  });

  it('maps a span onto raw text nodes even when normalization collapsed whitespace', () => {
    const registry = installHighlightApi();
    // The source HTML wraps an inline link with newlines + indentation, so the
    // block's raw textContent has runs of whitespace the normalizer collapses.
    const { container, block } = mount(
      '<p id="a">Hello\n  <a href="#">world</a>\n  again now.</p>'
    );
    const p = block('#a');
    // The normalizer joins the block's collapsed lines with newlines, so the
    // span is taken directly from the normalized text (significant content
    // "world again now.").
    const norm = normalizeForSpeech(p.textContent);
    const startOffset = norm.indexOf('world');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset, endOffset: norm.length });

    const range = registeredRange(registry);
    // toString returns the RAW text (with un-collapsed whitespace); its
    // significant content must be exactly the mapped span.
    expect(range.toString().replaceAll(/\s+/g, ' ')).toBe('world again now.');
    expect(range.toString().startsWith('world')).toBe(true);
  });

  it('clear() removes the registered highlight', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);
    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });
    expect(registry.has(HIGHLIGHT_NAME)).toBe(true);

    hl.clear();

    expect(registry.has(HIGHLIGHT_NAME)).toBe(false);
  });

  it('replaces the previous highlight when a new chunk is highlighted', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">First. Second sentence here.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'First.') });
    hl.highlight({ blockEl: p, ...spanOf(p, 'Second sentence here.') });

    expect(registry.size).toBe(1);
    expect(registeredRange(registry).toString()).toBe('Second sentence here.');
  });
});

describe('createChunkHighlighter — match-failure degradation', () => {
  it('highlights the whole block when the span cannot map (URL normalized to "link")', () => {
    const registry = installHighlightApi();
    // textContent has a raw URL; normalizeForSpeech turns it into "link", so the
    // normalized offsets do not map onto the raw text nodes.
    const { container, block } = mount('<p id="a">See https://example.com/page now.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    expect(() => {
      hl.highlight({ blockEl: p, ...spanOf(p, 'link') });
    }).not.toThrow();

    expect(registeredRange(registry).toString()).toBe('See https://example.com/page now.');
  });

  it('falls back to a whole-block range for inverted offsets', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset: 5, endOffset: 5 });

    expect(registeredRange(registry).toString()).toBe('Hello world.');
  });

  it('falls back to a whole-block range for a negative start offset', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset: -1, endOffset: 5 });

    expect(registeredRange(registry).toString()).toBe('Hello world.');
  });

  it('falls back to a whole-block range when the end offset exceeds the text', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset: 0, endOffset: 999 });

    expect(registeredRange(registry).toString()).toBe('Hello world.');
  });

  it('falls back to a whole-block range when the span is whitespace only', () => {
    const registry = installHighlightApi();
    const { container, block } = mount('<p id="a">Hi there.</p>');
    const p = block('#a');
    // The single space between the two words is a whitespace-only span.
    const spaceIndex = normalizeForSpeech(p.textContent).indexOf(' ');
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, startOffset: spaceIndex, endOffset: spaceIndex + 1 });

    expect(registeredRange(registry).toString()).toBe('Hi there.');
  });

  it('never throws and degrades to the block class if the Highlight registry errors', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    vi.stubGlobal('CSS', {
      highlights: {
        set: (): never => {
          throw new Error('registry boom');
        },
        delete: (): void => {},
      },
    });
    vi.stubGlobal('Highlight', FakeHighlight);
    const hl = createChunkHighlighter(container);

    expect(() => {
      hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });
    }).not.toThrow();
    expect(p.classList.contains(BLOCK_CLASS)).toBe(true);
  });
});

describe('createChunkHighlighter — auto-scroll', () => {
  it('scrolls the block into view when it is below the viewport', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    setViewportRect(p, 1000, 1040);
    const scrollIntoView = vi.fn();
    p.scrollIntoView = scrollIntoView;
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('scrolls the block into view when it is above the viewport', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    setViewportRect(p, -80, -40);
    const scrollIntoView = vi.fn();
    p.scrollIntoView = scrollIntoView;
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(scrollIntoView).toHaveBeenCalledOnce();
  });

  it('does not scroll when the block is already in the viewport', () => {
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    setViewportRect(p, 100, 140);
    const scrollIntoView = vi.fn();
    p.scrollIntoView = scrollIntoView;
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls instantly when reduced motion is requested (stop-animations)', () => {
    useA11yStore.setState({ stopAnimations: true });
    const { container, block } = mount('<p id="a">Hello world.</p>');
    const p = block('#a');
    setViewportRect(p, 1000, 1040);
    const scrollIntoView = vi.fn();
    p.scrollIntoView = scrollIntoView;
    const hl = createChunkHighlighter(container);

    hl.highlight({ blockEl: p, ...spanOf(p, 'Hello world.') });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'instant' });
  });
});

/**
 * The reading highlight is two marks made of one brand colour, and which mark
 * carries which obligation is the whole contract.
 *
 * The underline is the indicator. It is solid --brand-red, sits beside the text
 * rather than under it, and clears 3:1 against the canvas in every tier — the
 * WCAG 1.4.11 non-text bound. Nothing may weaken it: thinning it, tinting it, or
 * dropping the line is a conformance regression, which is why its colour and its
 * ratio are both asserted below.
 *
 * The wash is aesthetic. It is the same brand colour at --reading-highlight-strength,
 * an alpha the contrast tiers redefine, and it exists to make the read line feel
 * marked rather than to carry contrast. It sits under the text, so the one bound
 * it is held to is the text on top of it: 7:1 in every tier. It does not meet 3:1
 * against the canvas at any tier and is not intended to — reaching that with a
 * mid-dark red would take a near-solid bar, and the underline already carries the
 * obligation the bar would have been for.
 *
 * The colour is a token no tier redefines, so the mark stays brand red at every
 * setting; the alpha is a token the tiers do redefine. Both halves are pinned so
 * that swapping either is a decision someone takes rather than one that drifts in.
 */

/** Read text keeps at least this ratio against the wash it sits on, in every tier. */
const READ_TEXT_FLOOR = 7;
/** WCAG 1.4.11: the underline keeps at least this ratio against the canvas. */
const NON_TEXT_FLOOR = 3;

const STRENGTH_TOKEN = '--reading-highlight-strength';

/** Every custom property `styles/contrast.css` redefines in one of its tiers. */
const tierRedefinedTokens: ReadonlySet<string> = new Set(
  [
    ...readFileSync(path.join(libraryDir, '../styles/contrast.css'), 'utf8').matchAll(
      /html\.a11y-contrast-[\w.-]+\s*{([^}]*)}/g
    ),
  ].flatMap(([, body]) => [...body!.matchAll(/(--[\w-]+)\s*:/g)].map(([, token]) => token!))
);

const tailwindCss = readFileSync(
  path.join(libraryDir, '../../../../../config/tailwind/index.css'),
  'utf8'
);
const contrastCss = readFileSync(path.join(libraryDir, '../styles/contrast.css'), 'utf8');
const highlightCss = readFileSync(path.join(libraryDir, '../styles/reading-highlight.css'), 'utf8');

/** Every custom property the reading highlight references, in source order. */
const paintedTokens: readonly string[] = [
  ...new Set([...highlightCss.matchAll(/var\(\s*(--[\w-]+)/g)].map(([, token]) => token!)),
];

/** The two rules that paint the aid: the highlight pseudo and its block fallback. */
const paintRules: readonly string[] = [
  ...highlightCss.matchAll(/(?:::highlight\([\w-]+\)|\.[\w-]+)\s*\{([^}]*)\}/g),
].map(([, body]) => body!.replaceAll(/\s+/g, ' '));

/** The sole custom property named once by a regex over the whole stylesheet. */
function soleTokenMatching(pattern: RegExp, what: string): string {
  const found = [...new Set([...highlightCss.matchAll(pattern)].map(([, token]) => token!))];
  if (found.length !== 1) throw new Error(`expected one ${what}, found ${String(found.length)}`);
  return found[0]!;
}

/** The colour the underline is drawn in. */
const underlineColorToken = soleTokenMatching(
  /text-decoration-color:\s*var\(\s*(--[\w-]+)\s*\)/g,
  'underline colour'
);

/** The `color-mix(in srgb, var(--colour) var(--strength), transparent)` the wash paints. */
const wash = ((): { colorToken: string; strengthToken: string } => {
  // Prettier reflows a long color-mix() across lines; normalising to the single-line
  // form keeps the match independent of where it chose to break.
  const oneLine = highlightCss.replaceAll(/\s+/g, ' ').replaceAll('( ', '(').replaceAll(' )', ')');
  const mixes = [
    ...new Set(
      [
        ...oneLine.matchAll(
          /color-mix\(in srgb, var\((--[\w-]+)\) var\((--[\w-]+)\), transparent\)/g
        ),
      ].map(([, colorToken, strengthToken]) => `${colorToken!} ${strengthToken!}`)
    ),
  ];
  if (mixes.length !== 1) {
    throw new Error(`expected one wash expression, found ${String(mixes.length)}`);
  }
  const [colorToken, strengthToken] = mixes[0]!.split(' ') as [string, string];
  return { colorToken, strengthToken };
})();

/** The literal colours the base token stylesheet gives `name`, one per theme block. */
function baseColorDefinitions(name: string): readonly string[] {
  const pattern = new RegExp(String.raw`[\s;{]${name}:\s*(#[0-9a-f]{3,8})\b`, 'gi');
  return [...tailwindCss.matchAll(pattern)].map(([, hex]) => hex!);
}

/** Nth `--name: #rrggbb` in the base token stylesheet: 0 = light `:root`, 1 = dark `.dark`. */
function baseToken(name: string, themeIndex: 0 | 1): string {
  const hex = baseColorDefinitions(name)[themeIndex];
  if (hex === undefined) {
    throw new Error(`base token ${name} not found for theme index ${String(themeIndex)}`);
  }
  return hex;
}

/** Custom-property declarations of one flat rule block, empty when the block is absent. */
function declarationsOf(css: string, selectorPattern: string): ReadonlyMap<string, string> {
  const block = new RegExp(String.raw`(?:^|\n)${selectorPattern}\s*\{([^}]*)\}`).exec(css);
  return new Map(
    [...(block?.[1] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;!]+)/g)].map(([, token, value]) => [
      token!,
      value!.trim(),
    ])
  );
}

/** The tier blocks, `null` where the tier is the un-suffixed `html` default. */
const tierSelectors = {
  neutral: null,
  low: String.raw`html\.a11y-contrast-low`,
  increased: String.raw`html\.a11y-contrast-increased`,
  high: String.raw`html\.a11y-contrast-high`,
} as const;

/**
 * What a browser would compute for the wash's inputs, applying the blocks in the
 * order the cascade does: base tokens, the `html` default and its dark half, then
 * the tier block and its dark half.
 */
function resolveTokens(
  tier: keyof typeof tierSelectors,
  theme: 'light' | 'dark'
): ReadonlyMap<string, string> {
  const themeIndex = theme === 'dark' ? 1 : 0;
  const resolved = new Map([
    ['--foreground', baseToken('--foreground', themeIndex)],
    ['--background', baseToken('--background', themeIndex)],
    [wash.colorToken, baseToken(wash.colorToken, themeIndex)],
    [underlineColorToken, baseToken(underlineColorToken, themeIndex)],
  ]);
  const selectors = ['html', ...(theme === 'dark' ? [String.raw`html\.dark`] : [])];
  const tierSelector = tierSelectors[tier];
  if (tierSelector !== null) {
    selectors.push(tierSelector, ...(theme === 'dark' ? [String.raw`${tierSelector}\.dark`] : []));
  }
  for (const selector of selectors) {
    for (const [token, value] of declarationsOf(contrastCss, selector)) resolved.set(token, value);
  }
  return resolved;
}

/** The declared strength of one cell, as a fraction. */
function washStrength(tokens: ReadonlyMap<string, string>): number {
  const value = tokens.get(wash.strengthToken);
  if (value === undefined || !/^\d+%$/.test(value)) {
    throw new Error(`wash strength is not a whole percentage: ${String(value)}`);
  }
  return Number.parseInt(value, 10) / 100;
}

/** The opaque colour the wash resolves to once composited over the canvas. */
function washOver(color: string, canvas: string, strength: number): [number, number, number] {
  const [tint, bg] = [parseCssColor(color), parseCssColor(canvas)];
  return [0, 1, 2].map(
    (channel) => strength * tint[channel]! + (1 - strength) * bg[channel]!
  ) as unknown as [number, number, number];
}

const tiers = ['neutral', 'low', 'increased', 'high'] as const;
const washCells = tiers.flatMap((tier) =>
  (['light', 'dark'] as const).map((theme) => ({ tier, theme }))
);

describe('reading-highlight stylesheet contract', () => {
  it('index.css imports the reading-highlight stylesheet into the accessibility layer', () => {
    const index = readFileSync(path.join(libraryDir, '../styles/index.css'), 'utf8');
    expect(index).toMatch(/@import\s+'\.\/reading-highlight\.css'\s+layer\(accessibility\)/);
  });

  it('styles the highlight and its block fallback, no border', () => {
    expect(highlightCss).toContain(`::highlight(${HIGHLIGHT_NAME})`);
    expect(highlightCss).toContain(`.${BLOCK_CLASS}`);
    expect(highlightCss).not.toMatch(/\bborder\b/);
  });

  it('references the brand tint and the per-tier strength, and nothing else', () => {
    expect(paintedTokens).toStrictEqual(['--brand-red', STRENGTH_TOKEN]);
  });

  it('draws the underline in the same brand colour the wash is mixed from', () => {
    expect(underlineColorToken).toBe(wash.colorToken);
  });

  it('underlines in both paint rules, so the indicator survives either mechanism', () => {
    expect(paintRules).toHaveLength(2);
    for (const body of paintRules) {
      expect(body).toMatch(/text-decoration-line:\s*underline/);
      expect(body).toMatch(/text-decoration-color:\s*var\(--brand-red\)/);
    }
  });

  it('paints a colour the base stylesheet defines as a literal hex in both themes', () => {
    expect(baseColorDefinitions(wash.colorToken)).toHaveLength(2);
  });

  it('paints a colour outside every token the contrast tiers redefine', () => {
    expect(tierRedefinedTokens.size).toBeGreaterThan(0);
    expect(tierRedefinedTokens.has(wash.colorToken)).toBe(false);
  });

  it('takes its strength from a token the contrast tiers do redefine', () => {
    expect(tierRedefinedTokens.has(wash.strengthToken)).toBe(true);
  });
});

describe('reading-highlight underline', () => {
  it.each(washCells)(
    '$tier tier, $theme: the underline clears 3:1 against the canvas',
    ({ tier, theme }) => {
      const tokens = resolveTokens(tier, theme);

      const ratio = contrastRatio(
        parseCssColor(tokens.get(underlineColorToken)!),
        parseCssColor(tokens.get('--background')!)
      );

      expect(ratio).toBeGreaterThanOrEqual(NON_TEXT_FLOOR);
    }
  );

  it('is drawn solid, never as a fraction of the brand colour', () => {
    for (const body of paintRules) {
      expect(body).not.toMatch(/text-decoration-color:\s*color-mix/);
    }
  });
});

describe('reading-highlight wash strength', () => {
  it.each(washCells)('$tier tier, $theme: declares a strength', ({ tier, theme }) => {
    expect(resolveTokens(tier, theme).get(STRENGTH_TOKEN)).toMatch(/^\d+%$/);
  });

  it.each(washCells)(
    '$tier tier, $theme: read text keeps 7:1 against the wash',
    ({ tier, theme }) => {
      const tokens = resolveTokens(tier, theme);

      const ratio = contrastRatio(
        parseCssColor(tokens.get('--foreground')!),
        washOver(tokens.get(wash.colorToken)!, tokens.get('--background')!, washStrength(tokens))
      );

      expect(ratio).toBeGreaterThanOrEqual(READ_TEXT_FLOOR);
    }
  );

  it.each(washCells)(
    '$tier tier, $theme: never exceeds the chosen neutral strength',
    ({ tier, theme }) => {
      const neutral = washStrength(resolveTokens('neutral', theme));

      expect(washStrength(resolveTokens(tier, theme))).toBeLessThanOrEqual(neutral);
    }
  );
});
