import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLookPainter } from './painter.driver.js';

import type { LoadedLook } from './contract.js';

/** One `getContext` call a canvas received: the kind asked for and the options beside it. */
interface ContextRequest {
  kind: string;
  options: unknown;
}

/** Stands in for `document`, recording every context request made of the canvases it creates. */
function stubDocument(): ContextRequest[] {
  const requests: ContextRequest[] = [];
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: (kind: string, options: unknown) => {
        requests.push({ kind, options });
        return { reset: () => undefined };
      },
    }),
  });
  return requests;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLookPainter', () => {
  it('asks for a software-rasterised context on a 2D look canvas', () => {
    const requests = stubDocument();
    const look: LoadedLook = { context: '2d', renderFrame: () => [] };

    createLookPainter('fixture', look);

    expect(requests).toEqual([{ kind: '2d', options: { willReadFrequently: true } }]);
  });
});
