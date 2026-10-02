import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the bars are asserted against their source.
const source = readFileSync(path.resolve(__dirname, './CostComparison.astro'), 'utf8');

// Every opening tag carrying `marker`, as its class list.
function classesOf(marker: string): string[][] {
  const tags = source.matchAll(new RegExp(String.raw`<div\b[^>]*\b${marker}\b[^>]*>`, 'g'));
  return [...tags].map(([tag]) => (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(/\s+/));
}

describe('CostComparison', () => {
  it('writes no long dash', () => {
    expect(source).not.toContain('&mdash;');
  });

  it('steps at no viewport width', () => {
    expect(source).not.toMatch(/\bsm:/);
  });

  it("separates a subscription's price from its reach with a middle dot", () => {
    expect(source).toContain('${c.price}/mo · {c.note}');
  });

  it('reads the HushBox figure and model count from the catalog it is given', () => {
    expect(source).toContain('${formattedCost}/mo · ALL {modelCount}+ models');
  });

  it('sizes the name column fluidly between 7rem and 9rem', () => {
    const names = classesOf('data-cost-name');
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toContain('w-[clamp(7rem,5.6rem+3vw,9rem)]');
  });

  it('measures the rows by the width of the list that holds them', () => {
    expect(classesOf('data-cost-list')).toStrictEqual([expect.arrayContaining(['@container'])]);
  });

  it('wraps a row only below the cost-stack width', () => {
    const rows = classesOf('data-cost-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual(expect.arrayContaining(['flex', '@max-mkt-cost-stack:flex-wrap']));
      expect(row).not.toContain('flex-wrap');
    }
  });

  it('closes a wrapped row up to the gap between a name and its bar', () => {
    const rows = classesOf('data-cost-row');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual(expect.arrayContaining(['gap-4', '@max-mkt-cost-stack:gap-1.5']));
    }
  });

  it('gives a wrapped name the full row, so its bar drops beneath it', () => {
    const names = classesOf('data-cost-name');
    expect(names).toHaveLength(2);
    for (const name of names) {
      expect(name).toEqual(expect.arrayContaining(['shrink-0', '@max-mkt-cost-stack:w-full']));
    }
  });

  it('lets a figure wrap inside its bar rather than run past it', () => {
    const values = classesOf('data-cost-value');
    expect(values).toHaveLength(2);
    for (const value of values) {
      expect(value).not.toContain('whitespace-nowrap');
      expect(value).not.toContain('absolute');
    }
  });

  it('grows a bar to fit a wrapped figure from a 2rem floor', () => {
    const tracks = classesOf('data-cost-track');
    expect(tracks).toHaveLength(2);
    for (const track of tracks) {
      expect(track).toContain('min-h-8');
      expect(track).not.toContain('h-8');
    }
  });

  it('holds the figure at the right end of its bar, centred on its height', () => {
    for (const track of classesOf('data-cost-track')) {
      expect(track).toEqual(expect.arrayContaining(['flex', 'items-center', 'justify-end']));
    }
    for (const value of classesOf('data-cost-value')) {
      expect(value).toEqual(expect.arrayContaining(['relative', 'text-right', 'pr-3']));
    }
  });

  it('insets a figure from the right end of its bar only, so its line keeps the full width to the left', () => {
    const values = classesOf('data-cost-value');
    expect(values).toHaveLength(2);
    for (const value of values) {
      expect(value.filter((token) => /^(?:p|px|pl|ps)-/.test(token))).toStrictEqual([]);
    }
  });

  it("sets the HushBox figure's text on the bar's own paint, with no inset, so the fill never shows under a glyph", () => {
    expect(source).toMatch(
      /<span class="bg-background" data-cost-ground>\s*<span class="bg-muted\/40">\s*\$\{formattedCost\}\/mo · ALL \{modelCount\}\+ models\s*<\/span\s*>\s*<\/span\s*>/
    );
  });

  it('tints every bar with the colour the ground repeats', () => {
    const tracks = classesOf('data-cost-track');
    expect(tracks).toHaveLength(2);
    for (const track of tracks) expect(track).toContain('bg-muted/40');
  });

  it('lays each fill under its figure without taking room from it', () => {
    const fills = classesOf('data-cost-fill');
    expect(fills).toHaveLength(2);
    for (const fill of fills)
      expect(fill).toEqual(expect.arrayContaining(['absolute', 'inset-y-0', 'left-0']));
  });
});
