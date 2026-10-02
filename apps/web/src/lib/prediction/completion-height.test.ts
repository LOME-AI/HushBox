import { describe, it, expect, vi, afterEach } from 'vitest';

import { measureMirroredHeight } from './completion-height';

function attachedTextarea(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea');
  document.body.append(textarea);
  return textarea;
}

/** Captures the node `measureMirroredHeight` creates before it removes it again. */
function captureReplica(run: () => void): HTMLElement {
  const spy = vi.spyOn(document.body, 'append');
  run();
  const [replica] = spy.mock.calls[0] ?? [];
  spy.mockRestore();
  if (!(replica instanceof HTMLElement)) throw new Error('measureMirroredHeight appended nothing');
  return replica;
}

describe('measureMirroredHeight', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes the given text into the hidden replica', () => {
    const textarea = attachedTextarea();
    const replica = captureReplica(() =>
      measureMirroredHeight(textarea, 'a predicted continuation')
    );
    expect(replica.textContent).toBe('a predicted continuation');
  });

  it("sizes the replica to the textarea's own rendered width", () => {
    const textarea = attachedTextarea();
    vi.spyOn(textarea, 'getBoundingClientRect').mockReturnValue({
      width: 280,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    const replica = captureReplica(() => measureMirroredHeight(textarea, 'x'));
    expect(replica.style.width).toBe('280px');
  });

  it('removes the replica again, leaving the document unchanged', () => {
    const textarea = attachedTextarea();
    const before = document.body.childElementCount;
    measureMirroredHeight(textarea, 'x');
    expect(document.body.childElementCount).toBe(before);
  });

  it('returns the height the replica measured', () => {
    const textarea = attachedTextarea();
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight');
    Object.defineProperty(Element.prototype, 'scrollHeight', {
      configurable: true,
      get: () => 123,
    });
    try {
      expect(measureMirroredHeight(textarea, 'x')).toBe(123);
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollHeight', original);
    }
  });
});
