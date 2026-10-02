import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the section frame is asserted against
// its source.
const FILE = path.resolve(__dirname, './WelcomeSection.astro');
const source = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';

describe('WelcomeSection', () => {
  it('takes an optional id, width and reveal marker', () => {
    expect(source).toMatch(
      /interface Props \{\s*id\?: string;\s*width\?: 'content' \| 'narrow' \| 'none';\s*reveal\?: boolean;\s*\}/
    );
  });

  it('defaults to the content width without the reveal', () => {
    expect(source).toMatch(/const \{ id, width = 'content', reveal = false \} = Astro\.props;/);
  });

  it('pads every section 2.25rem above and below', () => {
    expect(source).toMatch(/<section\b[^>]*class="py-9"/);
  });

  it('holds content in the 64rem container', () => {
    expect(source).toContain("content: 'mx-auto max-w-5xl px-6'");
  });

  it('holds narrow content in the 48rem container', () => {
    expect(source).toContain("narrow: 'mx-auto max-w-3xl px-6'");
  });

  it('adds no container for a section whose content brings its own', () => {
    expect(source).toMatch(/width === 'none' \?/);
  });

  it('marks a section for reveal', () => {
    expect(source).toMatch(/<section\b[^>]*data-reveal=\{reveal \? '' : undefined\}/);
  });

  it('fades a marked section up as it scrolls into view', () => {
    expect(source).toMatch(
      /<script>\s*import \{ initRevealOnScroll \} from '\.\.\/\.\.\/lib\/reveal-on-scroll';\s*initRevealOnScroll\(document\);\s*<\/script>/
    );
  });

  it('renders its content straight into the container', () => {
    expect(source).toMatch(/<div class=\{CONTAINER_CLASS\[width\]\}>\s*<slot \/>\s*<\/div>/);
  });

  it('serves no hidden state, so a page without script shows every section', () => {
    expect(source).not.toContain('data-reveal-state');
  });

  it('passes the id to the section', () => {
    expect(source).toMatch(/<section\b[^>]*\bid=\{id\}/);
  });

  it('steps at no width', () => {
    expect(source).not.toMatch(/\b(?:sm|md|lg|xl|2xl):/);
  });
});
