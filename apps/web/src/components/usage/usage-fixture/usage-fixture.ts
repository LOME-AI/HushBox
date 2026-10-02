import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-instants';
import type { ReactNode } from 'react';
import type { ModelsData } from '@/hooks/models/models';

/**
 * What the usage page's real-browser fixtures share: the catalog their stubs serve, the colour
 * behind a text, and the page mount.
 *
 * Test infrastructure, not shipped runtime: it is served to a real browser and never imported
 * by the Node test process, so `apps/web/vitest.config.ts` excludes `src/**\/*-fixture/**` from
 * the coverage gate. It imports the catalog's type alone: a fixture's stub stands in for that
 * module, so a value import from it would resolve to the stub.
 */

/** The catalog query's result for the given `[id, name]` pairs, read without a network. */
export function fixtureCatalog(names: readonly (readonly [string, string])[]): {
  data: ModelsData;
} {
  return {
    data: {
      models: names.map(([id, name]) => ({
        id,
        name,
        provider: 'Fictional',
        description: 'Text generation model.',
        modality: 'text',
        supportedParameters: [],
        contextLength: 128_000,
        created: OLD_RELEASE_SECONDS,
        maxOutputTokens: 4096,
        pricing: { inputPerToken: '10000', outputPerToken: '30000' },
      })),
      premiumIds: new Set(),
    },
  };
}

/** The first colour behind an element that is not see-through, as the engine computes it. */
export function backgroundBehind(element: Element): string {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const colour = getComputedStyle(node).backgroundColor;
    if (colour !== 'transparent' && colour !== 'rgba(0, 0, 0, 0)') return colour;
  }
  return getComputedStyle(document.documentElement).backgroundColor;
}

/** Renders the fixture's page into its `#root`, laid out before this returns. */
export function renderFixture(page: ReactNode): void {
  const container = document.querySelector('#root');
  if (container === null) throw new Error('missing #root');
  const reactRoot = createRoot(container);
  flushSync(() => {
    reactRoot.render(page);
  });
}
