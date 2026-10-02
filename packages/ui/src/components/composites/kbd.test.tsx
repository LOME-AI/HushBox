import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Kbd, formatHotkey } from './kbd';

const STYLESHEET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../config/tailwind/index.css'
);

/** The selector the shared stylesheet hides keys with on phone widths and touch pointers. */
function phoneHidingSelector(): string {
  const css = readFileSync(STYLESHEET, 'utf8').replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const selector = /@media \(width < 48rem\), \(pointer: coarse\) \{\s*([^{]+?)\s*\{/.exec(
    css
  )?.[1];
  if (selector === undefined) {
    throw new Error('the stylesheet has no phone and touch key-hiding rule');
  }
  return selector;
}

function stubApplePlatform(): void {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
}

function stubOtherPlatform(): void {
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
}

function kbdOf(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-slot="kbd"]');
  if (element === null) {
    throw new Error('no kbd rendered');
  }
  return element;
}

function capsOf(element: HTMLElement): string[] {
  return [...element.children].map((cap) => cap.textContent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formatHotkey', () => {
  it('renders mod as the command glyph on Apple platforms', () => {
    expect(formatHotkey('mod+k', { apple: true })).toBe('⌘K');
  });

  it('renders mod as Ctrl elsewhere', () => {
    expect(formatHotkey('mod+k', { apple: false })).toBe('Ctrl+K');
  });

  it('renders every modifier as a glyph on Apple platforms', () => {
    expect(formatHotkey('ctrl+alt+shift+n', { apple: true })).toBe('⌃⌥⇧N');
  });

  it('renders every modifier as a word elsewhere', () => {
    expect(formatHotkey('ctrl+alt+shift+n', { apple: false })).toBe('Ctrl+Alt+Shift+N');
  });

  it('renders meta as the command glyph on Apple platforms and as Meta elsewhere', () => {
    expect(formatHotkey('meta+s', { apple: true })).toBe('⌘S');
    expect(formatHotkey('meta+s', { apple: false })).toBe('Meta+S');
  });

  it('capitalizes a modifier it does not recognize', () => {
    expect(formatHotkey('super+k', { apple: false })).toBe('Super+K');
  });

  it('capitalizes a named key and leaves a symbol key alone', () => {
    expect(formatHotkey('escape', { apple: false })).toBe('Escape');
    expect(formatHotkey('shift+?', { apple: false })).toBe('Shift+?');
  });
});

describe('Kbd', () => {
  it('renders a real kbd element with the glyphs as its only content', () => {
    stubApplePlatform();
    render(<Kbd combo="mod+k" />);

    const element = screen.getByText('⌘K');
    expect(element.tagName).toBe('KBD');
    // The accessibility font carve-out matches `kbd` by element name with no
    // descendant term, so a nested wrapper would lose the monospace override.
    expect(element.children).toHaveLength(0);
  });

  it('falls back to the word form when the platform is not Apple', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    render(<Kbd combo="mod+k" />);

    expect(screen.getByText('Ctrl+K')).toBeInTheDocument();
  });

  it('renders the word form when there is no navigator', () => {
    const original = globalThis.navigator;
    Reflect.deleteProperty(globalThis, 'navigator');
    try {
      expect(renderToStaticMarkup(<Kbd combo="shift+n" />)).toContain('Shift+N');
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  it('hides below the 768 band', () => {
    stubApplePlatform();
    render(<Kbd combo="mod+k" />);

    expect(screen.getByText('⌘K')).toHaveClass('max-md:hidden');
  });

  it('hides on a coarse pointer', () => {
    stubApplePlatform();
    render(<Kbd combo="mod+k" />);

    expect(screen.getByText('⌘K')).toHaveClass('pointer-coarse:hidden');
  });

  it('stays shown at every width and pointer when it is always visible', () => {
    stubApplePlatform();
    render(<Kbd combo="mod+k" alwaysVisible />);

    const element = screen.getByText('⌘K');
    expect(element).not.toHaveClass('max-md:hidden');
    expect(element).not.toHaveClass('pointer-coarse:hidden');
  });

  it("is hidden by the stylesheet's phone and touch rule by default", () => {
    stubApplePlatform();
    render(<Kbd combo="mod+k" />);

    expect(screen.getByText('⌘K').matches(phoneHidingSelector())).toBe(true);
  });

  it("escapes the stylesheet's phone and touch rule when it is always visible", () => {
    stubApplePlatform();
    render(<Kbd combo="mod+k" alwaysVisible />);

    expect(screen.getByText('⌘K').matches(phoneHidingSelector())).toBe(false);
  });

  it('draws a 1px border on a transparent fill', () => {
    stubApplePlatform();
    render(<Kbd combo="mod+k" />);

    const element = screen.getByText('⌘K');
    expect(element).toHaveClass('border', 'border-border', 'bg-transparent');
    expect(element).not.toHaveClass('bg-muted');
  });

  it('sets the combination in muted mono at 0.75rem on a one-line box', () => {
    stubApplePlatform();
    render(<Kbd combo="mod+k" />);

    expect(screen.getByText('⌘K')).toHaveClass(
      'font-mono',
      'text-xs',
      'leading-none',
      'text-muted-foreground'
    );
  });

  it('merges a consumer className after its own', () => {
    stubApplePlatform();
    render(<Kbd combo="escape" className="ml-2" />);

    expect(screen.getByText('Escape')).toHaveClass('ml-2');
  });

  it('passes through arbitrary kbd attributes', () => {
    stubApplePlatform();
    render(<Kbd combo="escape" aria-label="Escape key" />);

    expect(screen.getByLabelText('Escape key')).toBeInTheDocument();
  });

  it('renders the joined form when no form is given', () => {
    stubOtherPlatform();
    const { container } = render(<Kbd combo="mod+shift+o" />);

    expect(kbdOf(container)).toHaveTextContent(/^Ctrl\+Shift\+O$/);
  });

  it('renders the joined form when asked for it', () => {
    stubOtherPlatform();
    const { container } = render(<Kbd combo="mod+shift+o" form="joined" />);

    expect(kbdOf(container)).toHaveTextContent(/^Ctrl\+Shift\+O$/);
  });

  describe('text form', () => {
    it.each([
      ['mod+shift+o', 'Ctrl ⇧ O'],
      ['mod+k', 'Ctrl K'],
      ['mod+,', 'Ctrl ,'],
      ['ctrl+alt+n', 'Ctrl Alt N'],
      ['meta+s', 'Meta S'],
      ['escape', 'Escape'],
    ])('writes %s as "%s" off Apple platforms', (combo, expected) => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo={combo} form="text" />);

      expect(kbdOf(container).textContent).toBe(expected);
    });

    it.each([
      ['mod+shift+o', '⌘⇧O'],
      ['mod+k', '⌘K'],
      ['mod+,', '⌘,'],
    ])('keeps the glyphs for %s on Apple platforms', (combo, expected) => {
      stubApplePlatform();
      const { container } = render(<Kbd combo={combo} form="text" />);

      expect(kbdOf(container).textContent).toBe(expected);
    });

    it('draws one box with no nested element', () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+k" form="text" />);

      const element = kbdOf(container);
      expect(element.tagName).toBe('KBD');
      expect(element.children).toHaveLength(0);
      expect(element).toHaveClass('border', 'border-border', 'font-mono', 'max-md:hidden');
    });
  });

  describe('keycaps form', () => {
    it('draws one cap per key off Apple platforms', () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+shift+o" form="keycaps" />);

      expect(capsOf(kbdOf(container))).toEqual(['Ctrl', '⇧', 'O']);
    });

    it('draws the glyph caps on Apple platforms', () => {
      stubApplePlatform();
      const { container } = render(<Kbd combo="mod+shift+o" form="keycaps" />);

      expect(capsOf(kbdOf(container))).toEqual(['⌘', '⇧', 'O']);
    });

    it('draws a single key as one cap', () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+," form="keycaps" />);

      expect(capsOf(kbdOf(container))).toEqual(['Ctrl', ',']);
    });

    it('nests each cap as a kbd inside the combination kbd', () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+k" form="keycaps" />);

      const combination = kbdOf(container);
      expect(combination.tagName).toBe('KBD');
      expect(combination.children).toHaveLength(2);
      for (const cap of combination.children) {
        expect(cap.tagName).toBe('KBD');
        expect(cap.children).toHaveLength(0);
      }
    });

    it('boxes each cap and not the combination', () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+k" form="keycaps" />);

      const combination = kbdOf(container);
      expect(combination).not.toHaveClass('border');
      expect(combination.children).toHaveLength(2);
      for (const cap of combination.children) {
        expect(cap).toHaveClass(
          'border',
          'border-border',
          'bg-transparent',
          'font-mono',
          'text-xs',
          'leading-none',
          'text-muted-foreground'
        );
      }
    });

    it('spaces the caps the way the palette row spaces its meta', () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+k" form="keycaps" />);

      expect(kbdOf(container)).toHaveClass('inline-flex', 'items-center', 'gap-1.5');
    });

    it('hides the combination below the 768 band and on a coarse pointer', () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+k" form="keycaps" />);

      expect(kbdOf(container)).toHaveClass('max-md:hidden', 'pointer-coarse:hidden');
    });

    it('keeps the combination shown at every width and pointer when it is always visible', () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+k" form="keycaps" alwaysVisible />);

      const combination = kbdOf(container);
      expect(combination).not.toHaveClass('max-md:hidden');
      expect(combination).not.toHaveClass('pointer-coarse:hidden');
    });

    it("escapes the stylesheet's phone and touch rule when it is always visible", () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+k" form="keycaps" alwaysVisible />);

      expect(kbdOf(container).matches(phoneHidingSelector())).toBe(false);
    });

    it("keeps every cap out of the stylesheet's phone and touch rule when it is always visible", () => {
      stubOtherPlatform();
      const { container } = render(<Kbd combo="mod+k" form="keycaps" alwaysVisible />);

      const caps = [...kbdOf(container).children];
      expect(caps).toHaveLength(2);
      for (const cap of caps) {
        expect(cap.matches(phoneHidingSelector())).toBe(false);
      }
    });

    it('puts a consumer className and attributes on the combination', () => {
      stubOtherPlatform();
      const { container } = render(
        <Kbd combo="mod+k" form="keycaps" className="ml-2" aria-label="Control K" />
      );

      const combination = kbdOf(container);
      expect(combination).toHaveClass('ml-2');
      expect(combination).toHaveAttribute('aria-label', 'Control K');
    });
  });
});
