import { describe, it, expect, afterEach, vi } from 'vitest';
import { observeTextMetrics } from './observe-text-metrics';

/** Lets the mutation observers deliver their records. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** A font set standing in for the document's, which a test DOM does not have. */
function fontSet(): EventTarget {
  const fonts = new EventTarget();
  Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
  return fonts;
}

const releases: (() => void)[] = [];

function observe(onChange: () => void): () => void {
  const release = observeTextMetrics(onChange);
  releases.push(release);
  return release;
}

afterEach(() => {
  for (const release of releases.splice(0)) release();
  Reflect.deleteProperty(document, 'fonts');
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('style');
});

describe('observeTextMetrics', () => {
  it('runs the callback when fonts finish loading', () => {
    const fonts = fontSet();
    const onChange = vi.fn();
    observe(onChange);

    fonts.dispatchEvent(new Event('loadingdone'));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("runs the callback when the root's classes change", async () => {
    const onChange = vi.fn();
    observe(onChange);

    document.documentElement.classList.add('a11y-font-scale-141');
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("runs the callback when the root's style changes", async () => {
    const onChange = vi.fn();
    observe(onChange);

    document.documentElement.style.setProperty('--a11y-font-family', '"lexend"');
    await settle();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('runs the callback when the window resizes', () => {
    const onChange = vi.fn();
    observe(onChange);

    globalThis.dispatchEvent(new Event('resize'));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores a root attribute other than class and style', async () => {
    const onChange = vi.fn();
    observe(onChange);

    document.documentElement.setAttribute('lang', 'fr');
    await settle();
    document.documentElement.removeAttribute('lang');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('runs the callback for none of the triggers once released', async () => {
    const fonts = fontSet();
    const onChange = vi.fn();
    const release = observe(onChange);

    release();
    fonts.dispatchEvent(new Event('loadingdone'));
    document.documentElement.classList.add('a11y-font-scale-141');
    document.documentElement.style.setProperty('--a11y-font-family', '"lexend"');
    globalThis.dispatchEvent(new Event('resize'));
    await settle();

    expect(onChange).not.toHaveBeenCalled();
  });

  it('observes the other triggers in a document without a font set', () => {
    const onChange = vi.fn();
    const release = observe(onChange);

    globalThis.dispatchEvent(new Event('resize'));
    release();

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
