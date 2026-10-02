import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

vi.mock('./lib/tts-engine', () => ({
  TTS_VOICES: [{ id: 'af_heart', displayName: 'Heart', accent: 'American', gender: 'female' }],
  getTtsService: () => ({
    load: vi.fn(),
    isLoaded: vi.fn().mockReturnValue(false),
    preloadVoice: vi.fn(),
    speak: vi.fn(),
    stop: vi.fn(),
    unlockAudio: vi.fn(),
  }),
}));

vi.mock('./lib/font-loader', () => ({
  activateFont: vi.fn().mockResolvedValue(true),
}));

import { AccessibilityPanel } from './accessibility-panel';

/** The sections whose controls sit in a grid, quick starts included. */
const GRID_SECTIONS = ['Quick starts', 'Visual', 'Text', 'Reading helpers', 'Pointer & focus'];

/** The grid a named section lays its controls out in. */
function sectionGrid(name: string): Element {
  const grid = screen.getByRole('region', { name }).querySelector(':scope > div');
  if (grid === null) throw new Error(`the ${name} section holds no grid`);
  return grid;
}

function settingCard(title: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${title}:`) });
}

function resetButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Reset all to defaults' });
}

describe('AccessibilityPanel', () => {
  it('renders every section heading', () => {
    render(<AccessibilityPanel host="app" />);
    expect(screen.getByText('Quick starts')).not.toBeNull();
    expect(screen.getByText('Visual')).not.toBeNull();
    expect(screen.getByText('Text')).not.toBeNull();
    expect(screen.getByText('Reading helpers')).not.toBeNull();
    expect(screen.getByText('Sound')).not.toBeNull();
    expect(screen.getByText('Motion')).not.toBeNull();
    expect(screen.getByRole('heading', { name: /Pointer/ })).not.toBeNull();
  });

  it('renders the reset-to-defaults button', () => {
    render(<AccessibilityPanel host="app" />);
    expect(screen.getByRole('button', { name: /Reset all to defaults/ })).not.toBeNull();
  });

  it('requires a host', () => {
    // @ts-expect-error -- the host decides how the grids find their columns, so it has no default
    const panel = <AccessibilityPanel />;
    expect(panel).toBeDefined();
  });

  describe('in the app', () => {
    it('measures its own width, so its grids follow the space it is given', () => {
      const { container } = render(<AccessibilityPanel host="app" />);
      expect(container.firstElementChild).toHaveClass('@container');
    });

    it.each(GRID_SECTIONS)('lays the %s grid out in two columns from its own width', (name) => {
      render(<AccessibilityPanel host="app" />);
      const grid = sectionGrid(name);
      expect(grid).toHaveClass('grid', '@a11y-two-col:grid-cols-2');
      expect(grid).not.toHaveClass('sm:grid-cols-2');
    });

    it.each(['Color-blindness filter', 'Font'])(
      'spans the %s card across both columns from its own width',
      (title) => {
        render(<AccessibilityPanel host="app" />);
        const card = settingCard(title);
        expect(card).toHaveClass('@a11y-two-col:col-span-2');
        expect(card).not.toHaveClass('sm:col-span-2');
      }
    );

    it('draws Reset as an outline block button', () => {
      render(<AccessibilityPanel host="app" />);
      const reset = resetButton();
      expect(reset).toHaveAttribute('data-block');
      expect(reset).toHaveAttribute('data-variant', 'outline');
    });
  });

  describe('on the site', () => {
    it('measures no width of its own', () => {
      const { container } = render(<AccessibilityPanel host="site" />);
      expect(container.firstElementChild).not.toHaveClass('@container');
    });

    it.each(GRID_SECTIONS.filter((name) => name !== 'Quick starts'))(
      'keeps the %s grid on the viewport step',
      (name) => {
        render(<AccessibilityPanel host="site" />);
        const grid = sectionGrid(name);
        expect(grid).toHaveClass('grid', 'sm:grid-cols-2');
        expect(grid).not.toHaveClass('@a11y-two-col:grid-cols-2');
      }
    );

    it('keeps the quick starts in one column', () => {
      render(<AccessibilityPanel host="site" />);
      expect(sectionGrid('Quick starts')).toHaveClass('flex', 'flex-col');
    });

    it.each(['Color-blindness filter', 'Font'])(
      'spans the %s card on the viewport step',
      (title) => {
        render(<AccessibilityPanel host="site" />);
        expect(settingCard(title)).toHaveClass('sm:col-span-2');
      }
    );

    it('keeps Reset as the plain full-width button', () => {
      render(<AccessibilityPanel host="site" />);
      const reset = resetButton();
      expect(reset).not.toHaveAttribute('data-block');
      expect(reset).toHaveClass('border-2', 'border-foreground/20');
    });
  });
});
