import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { ComposerBar } from '@/components/chat/input/composer-bar';

function slotButton(name: string): React.JSX.Element {
  return <button type="button">{name}</button>;
}

function renderFullBar(): void {
  render(
    <ComposerBar
      modeControl={slotButton('Mode')}
      searchControl={slotButton('Search')}
      effortControl={slotButton('Effort')}
      modelControl={slotButton('Model')}
      estimate={slotButton('Estimate')}
      send={slotButton('Send')}
    />
  );
}

function namesIn(group: HTMLElement | null): string[] {
  if (group === null) return [];
  return [...group.querySelectorAll('button')].map((button) => button.textContent);
}

function group(slot: 'composer-left' | 'composer-right'): HTMLElement | null {
  return document.querySelector(`[data-slot="${slot}"]`);
}

describe('ComposerBar', () => {
  it('holds the mode, Search and Effort slots on the left, in that order', () => {
    renderFullBar();

    expect(namesIn(group('composer-left'))).toEqual(['Mode', 'Search', 'Effort']);
  });

  it('holds the model chip slot, the estimate slot and Send on the right, in that order', () => {
    renderFullBar();

    expect(namesIn(group('composer-right'))).toEqual(['Model', 'Estimate', 'Send']);
  });

  it('puts the left group before the right group', () => {
    renderFullBar();

    const left = group('composer-left');
    const right = group('composer-right');
    expect(left).not.toBeNull();
    expect(right).not.toBeNull();
    expect(left!.compareDocumentPosition(right!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders only Send when no other slot is filled', () => {
    render(<ComposerBar send={slotButton('Send')} />);

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Send']);
  });

  it('leaves an unfilled slot without a box of its own, so it opens no gap in its row', () => {
    render(<ComposerBar send={slotButton('Send')} />);

    for (const slot of ['mode', 'search', 'effort', 'model', 'estimate']) {
      const wrapper = document.querySelector(`[data-slot="composer-${slot}"]`);
      expect(wrapper, slot).not.toBeNull();
      expect(wrapper, slot).toBeEmptyDOMElement();
      expect(wrapper, slot).toHaveClass('contents');
    }
  });

  it('hides an empty control a slot is handed, so it opens no gap either', () => {
    render(<ComposerBar searchControl={<div data-probe="" />} send={slotButton('Send')} />);

    const slot = document.querySelector('[data-slot="composer-search"]');
    expect(slot).toHaveClass('*:empty:hidden');
    expect(slot).toContainElement(document.querySelector<HTMLElement>('[data-probe]'));
  });

  it('keeps the left group whole', () => {
    renderFullBar();

    expect(group('composer-left')).toHaveClass('flex-none');
  });

  it('grows the right group from nothing, so it squeezes before the bar wraps', () => {
    renderFullBar();

    expect(group('composer-right')).toHaveClass('flex-1', 'justify-end-safe');
  });

  it('floors the right group at its smallest content rather than at nothing', () => {
    renderFullBar();

    expect(group('composer-right')).not.toHaveClass('min-w-0');
  });

  it('sizes the model chip from nothing up to its own width, so its name truncates first', () => {
    renderFullBar();

    expect(document.querySelector('[data-slot="composer-model"]')).toHaveClass(
      '*:w-0',
      '*:grow',
      '*:max-w-max'
    );
  });

  it('caps the left group at the bar width and wraps its controls there, so none leaves the field', () => {
    renderFullBar();

    expect(group('composer-left')).toHaveClass('max-w-full', 'flex-wrap');
  });

  it('wraps the right group onto its own line once even its smallest form leaves no room', () => {
    renderFullBar();

    expect(document.querySelector('[data-slot="composer-bar"]')).toHaveClass('flex-wrap');
  });

  describe("compaction by the composer's own width", () => {
    function slot(name: string): HTMLElement | null {
      return document.querySelector(`[data-slot="composer-${name}"]`);
    }

    it("tightens the bar's spacing below a 34rem composer", () => {
      renderFullBar();

      expect(slot('bar')).toHaveClass(
        '@max-composer-compact/composer:gap-1',
        '@max-composer-compact/composer:px-1.5'
      );
    });

    it('tightens the gap inside each group below a 34rem composer', () => {
      renderFullBar();

      expect(group('composer-left')).toHaveClass('@max-composer-compact/composer:gap-1');
      expect(group('composer-right')).toHaveClass('@max-composer-compact/composer:gap-1');
    });

    it('takes the estimate out of the bar below a 34rem composer', () => {
      renderFullBar();

      expect(slot('estimate')).toHaveClass('@max-composer-compact/composer:hidden');
    });

    it("shows the Search chip's label to readers only, in a 2rem square, below a 34rem composer", () => {
      renderFullBar();

      expect(slot('search')).toHaveClass(
        '@max-composer-compact/composer:[&_button>span]:sr-only',
        '@max-composer-compact/composer:[&_button:has(>span)]:w-8',
        '@max-composer-compact/composer:[&_button:has(>span)]:px-0',
        '@max-composer-compact/composer:[&_button:has(>span)]:justify-center'
      );
    });

    it("shows the mode chip's label to readers only, in a 2rem square, below a 20.5rem composer", () => {
      renderFullBar();

      expect(slot('mode')).toHaveClass(
        '@max-composer-mode-icon/composer:[&_button>span]:sr-only',
        '@max-composer-mode-icon/composer:[&_button:has(>span)]:w-8',
        '@max-composer-mode-icon/composer:[&_button:has(>span)]:px-0',
        '@max-composer-mode-icon/composer:[&_button:has(>span)]:justify-center'
      );
    });

    it('hides the Search slot below a 20rem composer', () => {
      renderFullBar();

      expect(slot('search')).toHaveClass('@max-composer-minimal/composer:hidden');
    });

    it('hides the Effort slot below a 20rem composer', () => {
      renderFullBar();

      expect(slot('effort')).toHaveClass('@max-composer-minimal/composer:hidden');
    });

    it('never hides the mode slot', () => {
      renderFullBar();

      expect(slot('mode')?.className).not.toContain('/composer:hidden');
    });

    it("leaves the model slot's short name to the model chip, which switches on the same width", () => {
      renderFullBar();

      expect(slot('model')?.className).not.toContain('@max-');
    });
  });
});
