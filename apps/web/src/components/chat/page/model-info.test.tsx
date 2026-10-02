import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { modelSwatch } from '@/lib/utils/model-color';
import { ModelInfo } from './model-info';
import type { Model } from '@hushbox/shared';

const NO_BREAK_SPACE = '\u00A0';

function buildModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'anthropic/claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    modality: 'text',
    contextLength: 200_000,
    pricing: { inputPerToken: '3450', outputPerToken: '17250' },
    description: 'A capable model.',
    supportedParameters: [],
    ...overrides,
  };
}

function imageModel(): Model {
  return buildModel({
    id: 'bytedance-seed/seedream-4.5',
    name: 'Seedream 4.5',
    provider: 'ByteDance Seed',
    modality: 'image',
    contextLength: 0,
    pricing: { perImage: '46000000', dearestPerImage: '46000000' },
  });
}

interface RenderOptions {
  selectionCount?: number;
  signedIn?: boolean;
}

function renderInfo(
  model?: Model,
  { selectionCount = 1, signedIn = true }: RenderOptions = {}
): HTMLElement | null {
  render(<ModelInfo model={model} selectionCount={selectionCount} signedIn={signedIn} />);
  return screen.queryByTestId(TEST_IDS.modelInfo);
}

function readout(model: Model = buildModel(), options: RenderOptions = {}): HTMLElement {
  const element = renderInfo(model, options);
  if (element === null) throw new Error('no model info rendered');
  return element;
}

function slots(element: HTMLElement, slot: string): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>(`[data-slot="${slot}"]`)];
}

/** The first fact: the model's swatch and name. */
function nameOf(element: HTMLElement): HTMLElement {
  const [name] = slots(element, 'model-info-fact');
  if (name === undefined) throw new Error('no model name');
  return name;
}

describe('ModelInfo', () => {
  it('renders nothing before the model is known', () => {
    expect(renderInfo()).toBeNull();
  });

  it('is one centred paragraph in the UI face, muted, at the small UI step', () => {
    const element = readout();

    expect(element.tagName).toBe('P');
    expect(element).toHaveClass('text-center', 'font-sans', 'text-ui-sm', 'text-muted-foreground');
  });

  describe('the model', () => {
    it('names it', () => {
      expect(nameOf(readout())).toHaveTextContent('Claude Sonnet 4.5');
    });

    it('sets its name in ink, semibold, a step below the sub-greeting', () => {
      expect(nameOf(readout())).toHaveClass('text-title-3', 'text-foreground');
    });

    it("draws the model's own swatch beside its name", () => {
      const model = buildModel();
      const swatch = nameOf(readout(model)).querySelector('[data-slot="swatch"]');

      expect(swatch).toHaveClass(`bg-model-${String(modelSwatch(model.id))}`);
    });

    it('names its maker', () => {
      expect(readout()).toHaveTextContent('Anthropic');
    });

    it('gives the Smart Model its role in place of a maker', () => {
      const smart = buildModel({
        id: 'smart-model',
        name: 'Smart Model',
        provider: 'HushBox',
        isSmartModel: true,
        pricing: {},
      });

      expect(readout(smart)).toHaveTextContent('Auto-picks the best model');
    });
  });

  describe('the rates', () => {
    it('read as Input and Output to a screen reader', () => {
      const element = readout();

      expect(element.textContent).toContain('Input');
      expect(element.textContent).toContain('Output');
    });

    it('label them In and Out on screen, in mono caps', () => {
      const labels = slots(readout(), 'model-info-label');

      expect(labels.map((label) => label.firstChild?.textContent)).toEqual(['In', 'Out']);
      for (const label of labels) {
        expect(label).toHaveClass('font-mono', 'text-caption', 'uppercase');
      }
    });

    it('keep the rest of each label for assistive tech alone', () => {
      const labels = slots(readout(), 'model-info-label');

      for (const label of labels) {
        expect(label.lastElementChild).toHaveClass('sr-only');
      }
    });

    it('set the figures in mono ink with tabular numbers', () => {
      const figures = slots(readout(), 'model-info-figure');

      expect(figures.map((figure) => figure.textContent)).toEqual(['$0.00345/1k', '$0.01725/1k']);
      for (const figure of figures) {
        expect(figure).toHaveClass('font-mono', 'text-caption', 'tabular-nums', 'text-foreground');
      }
    });

    it('show an image model its price per image', () => {
      const figures = slots(readout(imageModel()), 'model-info-figure');

      expect(figures.map((figure) => figure.textContent)).toEqual(['$0.046/image']);
    });

    it('are absent for a visitor', () => {
      const element = readout(buildModel(), { signedIn: false });

      expect(slots(element, 'model-info-figure')).toEqual([]);
      expect(element).toHaveTextContent('Anthropic');
    });
  });

  describe('grouping', () => {
    it('puts the model and its maker in one group and the rates in another', () => {
      const groups = slots(readout(), 'model-info-group');

      expect(groups.map((group) => slots(group, 'model-info-fact').length)).toEqual([2, 2]);
    });

    it('draws one group when there are no rates', () => {
      const groups = slots(readout(buildModel(), { signedIn: false }), 'model-info-group');

      expect(groups).toHaveLength(1);
    });

    it('lets each group and fact keep together while it fits, and wrap inside the column', () => {
      const element = readout();

      for (const part of [
        ...slots(element, 'model-info-group'),
        ...slots(element, 'model-info-fact'),
      ]) {
        expect(part).toHaveClass('max-w-full');
      }
    });
  });

  describe('the separating dots', () => {
    it('follow every fact but the last', () => {
      const facts = slots(readout(), 'model-info-fact');

      expect(facts.map((fact) => slots(fact, 'model-info-dot').length)).toEqual([1, 1, 1, 0]);
    });

    it('close their fact, so a wrapped line ends on a dot and never starts with one', () => {
      for (const dot of slots(readout(), 'model-info-dot')) {
        expect(dot.parentElement?.lastElementChild).toBe(dot);
      }
    });

    it('hang on the text before them by a no-break space', () => {
      for (const dot of slots(readout(), 'model-info-dot')) {
        expect(dot.textContent).toBe(`${NO_BREAK_SPACE}•`);
      }
    });

    it('are hidden from assistive tech', () => {
      for (const dot of slots(readout(), 'model-info-dot')) {
        expect(dot).toHaveAttribute('aria-hidden', 'true');
      }
    });

    it('are absent when the model stands alone', () => {
      const element = readout(buildModel(), { selectionCount: 2 });

      expect(slots(element, 'model-info-dot')).toEqual([]);
    });
  });

  describe('several models', () => {
    it("show the chip's label alone", () => {
      const element = readout(buildModel(), { selectionCount: 3 });

      expect(element).toHaveTextContent(/^Claude Sonnet 4\.5 \+ 2$/);
    });

    it("keep the first model's swatch", () => {
      const model = buildModel();
      const swatch = readout(model, { selectionCount: 3 }).querySelector('[data-slot="swatch"]');

      expect(swatch).toHaveClass(`bg-model-${String(modelSwatch(model.id))}`);
    });
  });
});
