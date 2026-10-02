import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useCitationTabStops } from './use-citation-tab-stops';

function appendCitation(): HTMLElement {
  const element = document.createElement('code');
  element.dataset['citationPath'] = 'apps/api/x.ts';
  element.dataset['citationStart'] = '68';
  element.dataset['citationEnd'] = '68';
  document.body.append(element);
  return element;
}

describe('useCitationTabStops', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('puts a citation already on the page into the tab order', () => {
    const citation = appendCitation();

    renderHook(() => {
      useCitationTabStops();
    });

    expect(citation.getAttribute('tabindex')).toBe('0');
  });

  it('leaves an ordinary code span out of the tab order', () => {
    const plain = document.createElement('code');
    document.body.append(plain);

    renderHook(() => {
      useCitationTabStops();
    });

    expect(plain.hasAttribute('tabindex')).toBe(false);
  });

  it('reaches a citation that arrives with the next finding', async () => {
    renderHook(() => {
      useCitationTabStops();
    });

    const citation = appendCitation();

    await waitFor(() => {
      expect(citation.getAttribute('tabindex')).toBe('0');
    });
  });

  it('stops watching once the console is gone', async () => {
    const { unmount } = renderHook(() => {
      useCitationTabStops();
    });
    unmount();

    const citation = appendCitation();
    await Promise.resolve();

    expect(citation.hasAttribute('tabindex')).toBe(false);
  });
});
