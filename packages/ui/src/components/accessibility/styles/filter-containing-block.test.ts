import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const filterCss = [
  readFileSync(path.join(stylesDir, 'contrast.css'), 'utf8'),
  readFileSync(path.join(stylesDir, 'colorblind.css'), 'utf8'),
].join('\n');

/**
 * Per CSS Filter Effects 1, an element with a computed `filter` other than
 * `none` becomes the containing block for every `position: fixed` descendant
 * unless that element is the document root. The root is the only exempt
 * element, so the whole question is which element the declaration lands on —
 * and that is a computed value, identical in source text either way.
 */
const FILTER_MODES = [
  { className: 'a11y-saturate-0', declared: 'saturate(0)' },
  { className: 'a11y-saturate-50', declared: 'saturate(0.5)' },
  { className: 'a11y-saturate-150', declared: 'saturate(1.5)' },
  { className: 'a11y-cb-protan', declared: 'url(#a11y-cb-protan)' },
  { className: 'a11y-cb-deutan', declared: 'url(#a11y-cb-deutan)' },
  { className: 'a11y-cb-tritan', declared: 'url(#a11y-cb-tritan)' },
  { className: 'a11y-cb-achroma', declared: 'url(#a11y-cb-achroma)' },
  { className: 'a11y-cb-achromatomaly', declared: 'url(#a11y-cb-achromatomaly)' },
];

function mount(className: string): void {
  const style = document.createElement('style');
  style.textContent = filterCss;
  document.head.append(style);
  document.documentElement.classList.add(className);
  document.body.innerHTML = '<div id="overlay"></div>';
}

function computedFilter(element: Element): string {
  return globalThis.getComputedStyle(element).filter;
}

function isFiltered(element: Element): boolean {
  const value = computedFilter(element);
  return value !== '' && value !== 'none';
}

function reset(): void {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.className = '';
}

beforeEach(reset);
afterEach(reset);

describe('accessibility colour filters', () => {
  it.each(FILTER_MODES)('$className filters the document root', ({ className, declared }) => {
    mount(className);

    expect(computedFilter(document.documentElement)).toBe(declared);
  });

  it.each(FILTER_MODES)(
    '$className leaves body unfiltered, so fixed descendants keep the viewport as their containing block',
    ({ className }) => {
      mount(className);

      expect(isFiltered(document.body)).toBe(false);
      expect(isFiltered(document.querySelector('#overlay')!)).toBe(false);
    }
  );
});
