import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

// No DOM harness renders `.astro` files in this app, so the block is asserted against its source.
const file = path.resolve(__dirname, './WordBlock.astro');
const source = existsSync(file) ? readFileSync(file, 'utf8') : '';

/** The look the block gives one tone, read from its per-tone table. */
function lookOf(tone: 'value' | 'trust'): string {
  return new RegExp(String.raw`\b${tone}: \{([^}]*)\}`).exec(source)?.[1] ?? '';
}

describe('WordBlock', () => {
  it('takes a tone, an icon, a title, a text and a level of two or three', () => {
    expect(source).toMatch(
      /interface Props \{\s*tone: 'value' \| 'trust';\s*icon: IconComponent;\s*title: string;\s*text: string;\s*headingLevel: 2 \| 3;\s*\}/
    );
  });

  it('renders its heading through Heading at the level it is given', () => {
    expect(source).toMatch(/<Heading level=\{headingLevel\} variant=\{look\.heading\}>/);
  });

  it('writes no raw heading element', () => {
    expect(source).not.toMatch(/<h[1-6]\b/);
  });

  it('steps at 768 and at no other width', () => {
    expect(source).not.toMatch(/\b(?:sm|lg|xl|2xl):/);
  });

  it('sets the tile on the heading line, left of the heading, centred on it and 0.75rem apart', () => {
    expect(source).toMatch(
      /<div class="flex items-center gap-3">\s*<span aria-hidden="true" class=\{`[^`]*`\}>\s*<Icon [^>]*\/>\s*<\/span>\s*<div class="min-w-0 wrap-break-word">\s*<Heading /
    );
  });

  it('draws the tile as a fixed rounded square with the glyph at its centre', () => {
    expect(source).toContain(
      '<span aria-hidden="true" class={`grid flex-none place-items-center rounded-xl ${look.tile}`}>'
    );
  });

  it('keeps the words of the heading in the heading, marked for the reveal', () => {
    expect(source).toMatch(/<span data-decrypt>\{title\}<\/span>\s*<\/Heading>/);
  });

  it('loads the script that resolves its heading from cipher glyphs', () => {
    expect(source).toMatch(
      /<script>\s*import \{ initDecryptHeadings \} from '\.\.\/lib\/decrypt-headings';\s*initDecryptHeadings\(document\);\s*<\/script>/
    );
  });

  it('sets the text under the heading line', () => {
    expect(source).toMatch(
      /<\/div>\s*<\/div>\s*<p class=\{`text-foreground mt-3 font-serif leading-relaxed \$\{look\.text\}`\}>\s*\{text\}\s*<\/p>/
    );
  });

  it('frames the block in a two-pixel border at the card radius', () => {
    expect(source).toContain('<div class={`border-border rounded-lg border-2 ${look.block}`}>');
  });

  describe('value tone', () => {
    const look = lookOf('value');

    it('sets the heading in the value role', () => {
      expect(look).toContain("heading: 'site-value'");
    });

    it('draws a 2.5rem red tile', () => {
      expect(look).toContain("tile: 'bg-brand-red-subtle text-brand-red size-10'");
    });

    it('draws the glyph at 1.25rem', () => {
      expect(look).toContain("iconSize: 'lg'");
    });

    it('pads the block fluidly from 1.5rem to 2rem', () => {
      expect(look).toContain("block: 'p-[clamp(1.5rem,1.2rem_+_1vw,2rem)]'");
    });

    it('sets the text fluidly from 0.875rem to 1rem', () => {
      expect(look).toContain("text: 'text-[length:clamp(0.875rem,0.84rem_+_0.2vw,1rem)]'");
    });
  });

  describe('trust tone', () => {
    const look = lookOf('trust');

    it('sets the heading in the trust role', () => {
      expect(look).toContain("heading: 'site-trust'");
    });

    it('draws a 2.25rem green tile', () => {
      expect(look).toContain("tile: 'bg-success/14 text-success size-9'");
    });

    it('draws the glyph at 1.125rem', () => {
      expect(look).toContain("iconSize: 'md-lg'");
    });

    it('pads the block 1.5rem on a subtle wash', () => {
      expect(look).toContain("block: 'bg-muted/30 p-6'");
    });

    it('sets the text at 0.875rem', () => {
      expect(look).toContain("text: 'text-sm'");
    });
  });
});
