import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SMART_MODEL_ID, TEST_SIGNALS } from '@hushbox/shared';
import { CostFigures } from './CostFigures';
import { ProviderStrip } from './ProviderStrip';
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

const SMART = makeModel({ id: SMART_MODEL_ID, name: 'Smart Model', provider: 'HushBox' });
const CATALOG: ModelsListResponse = {
  models: [
    makeModel({ id: 'zeta/one', name: 'Zeta One', provider: 'Zeta' }),
    makeModel(),
    makeModel({ id: 'anthropic/claude-test', name: 'Claude Test', provider: 'Anthropic' }),
    SMART,
  ],
  premiumModelIds: [],
};

function respondWith(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function strip(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-provider-strip]');
  if (element === null) throw new Error('no provider strip rendered');
  return element;
}

async function renderSettled(): Promise<HTMLElement> {
  const { container } = render(<ProviderStrip />);
  await waitFor(() => {
    expect(strip(container)).toHaveAttribute(TEST_SIGNALS.costSettled, 'true');
  });
  return container;
}

describe('ProviderStrip', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('while the catalog loads', () => {
    it('shows no provider and no count', () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {}))
      );
      const { container } = render(<ProviderStrip />);
      expect(strip(container).textContent).toBe('');
    });

    it('marks itself busy', () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {}))
      );
      const { container } = render(<ProviderStrip />);
      expect(strip(container)).toHaveAttribute('aria-busy', 'true');
    });
  });

  describe('with a priced catalog', () => {
    it('names the providers, the leading labs first, then the rest alphabetically', async () => {
      respondWith(CATALOG);
      await renderSettled();
      expect(screen.getAllByText(/^(OpenAI|Anthropic|Zeta)$/).map((el) => el.textContent)).toEqual([
        'OpenAI',
        'Anthropic',
        'Zeta',
      ]);
    });

    it('leaves the Smart Model out of the providers', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      expect(container.textContent).not.toContain('HushBox');
    });

    it('counts the real models, leaving out the Smart Model', async () => {
      respondWith(CATALOG);
      await renderSettled();
      expect(screen.getByText('3 models available')).toBeInTheDocument();
    });

    it('marks the strip ready and no longer busy', async () => {
      respondWith(CATALOG);
      const container = await renderSettled();
      expect(strip(container)).toHaveAttribute(TEST_SIGNALS.costReady);
      expect(strip(container)).not.toHaveAttribute('aria-busy');
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
    it('says the model list is unavailable, with no number', async () => {
      arrange();
      const container = await renderSettled();
      expect(strip(container).textContent).toBe('The model list is unavailable right now.');
    });

    it('is settled but never ready', async () => {
      arrange();
      const container = await renderSettled();
      expect(strip(container)).not.toHaveAttribute(TEST_SIGNALS.costReady);
    });
  });

  it('shares one catalog request with the cost figures', async () => {
    const fetchMock = respondWith(CATALOG);
    render(
      <>
        <CostFigures />
        <ProviderStrip />
      </>
    );
    await waitFor(() => {
      expect(screen.getByText('3 models available')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('adds no link, no button and no reveal of its own', async () => {
    respondWith(CATALOG);
    const container = await renderSettled();
    expect(container.querySelectorAll('a, button, [data-reveal]')).toHaveLength(0);
  });
});
