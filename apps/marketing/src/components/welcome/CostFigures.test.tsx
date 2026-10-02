import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { SMART_MODEL_ID, TEST_SIGNALS } from '@hushbox/shared';
import { calculateMonthlyCost } from '../../lib/calculate-cost';
import { CostFigures } from './CostFigures';
import type { Model, ModelsListResponse } from '@hushbox/shared';

function makeModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'openai/gpt-test',
    name: 'GPT Test',
    provider: 'OpenAI',
    modality: 'text',
    contextLength: 128_000,
    pricing: { inputPerToken: '10000', outputPerToken: '20000' },
    description: 'A test model',
    supportedParameters: ['temperature'],
    ...overrides,
  };
}

const PRICED = makeModel();
const SECOND = makeModel({
  id: 'anthropic/claude-test',
  name: 'Claude Test',
  provider: 'Anthropic',
});
const SMART = makeModel({ id: SMART_MODEL_ID, name: 'Smart Model', provider: 'HushBox' });

const CATALOG: ModelsListResponse = { models: [PRICED, SECOND, SMART], premiumModelIds: [] };
const EXPECTED_COST = calculateMonthlyCost([PRICED, SECOND]).monthlyCost;

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) }))
  );
}

function neverRespond(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
}

function hushboxRow(container: HTMLElement): HTMLElement {
  const rows = [...container.querySelectorAll<HTMLElement>('[data-cost-row]')];
  const row = rows.at(-1);
  if (row === undefined) throw new Error('no cost rows rendered');
  return row;
}

function hushboxFill(container: HTMLElement): HTMLElement | null {
  return hushboxRow(container).querySelector<HTMLElement>('[data-cost-fill]');
}

function list(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-cost-list]');
  if (element === null) throw new Error('no cost list rendered');
  return element;
}

// Every element carrying `marker`, as its class list.
function classesOf(container: HTMLElement, marker: string): string[][] {
  return [...container.querySelectorAll(`[${marker}]`)].map((element) => [...element.classList]);
}

async function renderSettled(): Promise<HTMLElement> {
  const { container } = render(<CostFigures />);
  await waitFor(() => {
    expect(list(container)).toHaveAttribute(TEST_SIGNALS.costSettled, 'true');
  });
  return container;
}

describe('CostFigures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('while the catalog loads', () => {
    it('shows no HushBox figure', () => {
      neverRespond();
      const { container } = render(<CostFigures />);
      expect(hushboxRow(container).textContent).not.toMatch(/\d/);
    });

    it('draws no HushBox fill', () => {
      neverRespond();
      const { container } = render(<CostFigures />);
      expect(hushboxFill(container)).toBeNull();
    });

    it('marks the list busy', () => {
      neverRespond();
      const { container } = render(<CostFigures />);
      expect(list(container)).toHaveAttribute('aria-busy', 'true');
    });

    it('shows the subscription prices, which are fixed facts', () => {
      neverRespond();
      const { container } = render(<CostFigures />);
      expect(container.textContent).toContain('$20/mo · GPT only');
      expect(container.textContent).toContain('$20/mo · Claude only');
      expect(container.textContent).toContain('$20/mo · Gemini only');
    });

    it('carries no settled signal', () => {
      neverRespond();
      const { container } = render(<CostFigures />);
      expect(list(container)).not.toHaveAttribute(TEST_SIGNALS.costSettled);
    });
  });

  describe('with a priced catalog', () => {
    it('shows the monthly figure and the count of real models, leaving out the Smart Model', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      expect(hushboxRow(container).textContent).toContain(
        `$${EXPECTED_COST.toFixed(2)}/mo · ALL 2+ models`
      );
    });

    it('fills the HushBox bar in proportion to a $20 subscription, from a 5% floor', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      expect(hushboxFill(container)?.style.width).toBe(
        `${String(Math.max((EXPECTED_COST / 20) * 100, 5))}%`
      );
    });

    it('marks the figures ready and no longer busy', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      expect(list(container)).toHaveAttribute(TEST_SIGNALS.costReady);
      expect(list(container)).not.toHaveAttribute('aria-busy');
    });

    it("sets the HushBox figure's text on the bar's own paint, so the fill never shows under a glyph", async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      const ground = hushboxRow(container).querySelector('[data-cost-ground]');
      expect(ground).toHaveClass('bg-background');
      expect(ground?.firstElementChild).toHaveClass('bg-muted/40');
    });
  });

  describe.each([
    [
      'the request fails',
      (): void => {
        vi.stubGlobal(
          'fetch',
          vi.fn(() => Promise.reject(new Error('offline')))
        );
      },
    ],
    [
      'the API answers an error',
      (): void => {
        respondWith({}, 503);
      },
    ],
    [
      'the body fails the models schema',
      (): void => {
        respondWith({ models: 'nope' });
      },
    ],
    [
      'the catalog prices nothing',
      (): void => {
        respondWith({ models: [SMART], premiumModelIds: [] });
      },
    ],
  ])('when %s', (_case, arrange) => {
    it('says live pricing is unavailable', async () => {
      arrange();
      const container = await renderSettled();
      expect(hushboxRow(container).textContent).toContain('Live pricing is unavailable right now.');
    });

    it('shows no HushBox number', async () => {
      arrange();
      const container = await renderSettled();
      expect(hushboxRow(container).textContent).not.toMatch(/\d/);
    });

    it('draws no HushBox fill', async () => {
      arrange();
      const container = await renderSettled();
      expect(hushboxFill(container)).toBeNull();
    });

    it('is settled but never ready', async () => {
      arrange();
      const container = await renderSettled();
      expect(list(container)).not.toHaveAttribute(TEST_SIGNALS.costReady);
    });
  });

  describe('layout', () => {
    it('adds no link or button', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      expect(container.querySelectorAll('a, button')).toHaveLength(0);
    });

    it('writes no long dash', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      expect(container.textContent).not.toMatch(/[–—]/);
    });

    it('sizes the name column fluidly between 7rem and 9rem', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      const names = classesOf(container, 'data-cost-name');
      expect(names).toHaveLength(4);
      for (const name of names) expect(name).toContain('w-[clamp(7rem,5.6rem+3vw,9rem)]');
    });

    it('measures the rows by the width of the list that holds them', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      expect(list(container)).toHaveClass('@container');
    });

    it('wraps a row only below the cost-stack width, closing up to the name-to-bar gap', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      const rows = classesOf(container, 'data-cost-row');
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row).toEqual(
          expect.arrayContaining([
            'flex',
            '@max-mkt-cost-stack:flex-wrap',
            'gap-4',
            '@max-mkt-cost-stack:gap-1.5',
          ])
        );
        expect(row).not.toContain('flex-wrap');
      }
    });

    it('gives a wrapped name the full row, so its bar drops beneath it', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      for (const name of classesOf(container, 'data-cost-name')) {
        expect(name).toEqual(expect.arrayContaining(['shrink-0', '@max-mkt-cost-stack:w-full']));
      }
    });

    it('grows a bar to fit a wrapped figure from a 2rem floor, tinted with the colour the ground repeats', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      const tracks = classesOf(container, 'data-cost-track');
      expect(tracks).toHaveLength(4);
      for (const track of tracks) {
        expect(track).toEqual(
          expect.arrayContaining(['min-h-8', 'bg-muted/40', 'flex', 'items-center', 'justify-end'])
        );
        expect(track).not.toContain('h-8');
      }
    });

    it('holds a figure at the right end of its bar, inset from that end only, free to wrap', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      const values = classesOf(container, 'data-cost-value');
      expect(values).toHaveLength(4);
      for (const value of values) {
        expect(value).toEqual(expect.arrayContaining(['relative', 'text-right', 'pr-3']));
        expect(value.filter((token) => /^(?:p|px|pl|ps)-/.test(token))).toStrictEqual([]);
        expect(value).not.toContain('whitespace-nowrap');
        expect(value).not.toContain('absolute');
      }
    });

    it('lays each fill under its figure without taking room from it', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      const fills = classesOf(container, 'data-cost-fill');
      expect(fills).toHaveLength(4);
      for (const fill of fills) {
        expect(fill).toEqual(expect.arrayContaining(['absolute', 'inset-y-0', 'left-0']));
      }
    });
  });
});
