import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { triggerViewTransition } from './trigger-view-transition';

describe('triggerViewTransition', () => {
  let originalStartViewTransition: unknown;

  function getDocumentRecord(): Record<string, unknown> {
    return document as unknown as Record<string, unknown>;
  }

  beforeEach(() => {
    originalStartViewTransition = getDocumentRecord()['startViewTransition'];
    // Clean up any CSS custom properties
    document.documentElement.style.removeProperty('--transition-x');
    document.documentElement.style.removeProperty('--transition-y');
    document.documentElement.style.removeProperty('--transition-radius');
  });

  afterEach(() => {
    if (originalStartViewTransition) {
      getDocumentRecord()['startViewTransition'] = originalStartViewTransition;
    } else {
      delete getDocumentRecord()['startViewTransition'];
    }
    document.documentElement.style.removeProperty('--transition-x');
    document.documentElement.style.removeProperty('--transition-y');
    document.documentElement.style.removeProperty('--transition-radius');
  });

  it('calls applyChange directly when startViewTransition is not available', () => {
    delete getDocumentRecord()['startViewTransition'];
    const applyChange = vi.fn();

    triggerViewTransition({ x: 100, y: 200 }, applyChange);

    expect(applyChange).toHaveBeenCalledOnce();
  });

  it('calls startViewTransition when available', () => {
    const finishedPromise = Promise.resolve();
    const mockTransition = { finished: finishedPromise };
    const mockStartViewTransition = vi.fn(() => mockTransition);
    getDocumentRecord()['startViewTransition'] = mockStartViewTransition;
    const applyChange = vi.fn();

    triggerViewTransition({ x: 50, y: 75 }, applyChange);

    expect(mockStartViewTransition).toHaveBeenCalledOnce();
    expect(mockStartViewTransition).toHaveBeenCalledWith(applyChange);
  });

  it('sets CSS custom properties before transition', () => {
    const finishedPromise = Promise.resolve();
    const mockTransition = { finished: finishedPromise };
    getDocumentRecord()['startViewTransition'] = vi.fn(() => mockTransition);

    triggerViewTransition({ x: 100, y: 200 }, vi.fn());

    expect(document.documentElement.style.getPropertyValue('--transition-x')).toBe('100px');
    expect(document.documentElement.style.getPropertyValue('--transition-y')).toBe('200px');
    expect(document.documentElement.style.getPropertyValue('--transition-radius')).not.toBe('');
  });

  it('calculates max radius with 1.15 buffer', () => {
    const finishedPromise = Promise.resolve();
    const mockTransition = { finished: finishedPromise };
    getDocumentRecord()['startViewTransition'] = vi.fn(() => mockTransition);

    // Use origin at (0, 0) so max radius = hypot(innerWidth, innerHeight) * 1.15
    triggerViewTransition({ x: 0, y: 0 }, vi.fn());

    const radius = document.documentElement.style.getPropertyValue('--transition-radius');
    const expectedMaxHypot = Math.hypot(window.innerWidth, window.innerHeight);
    const expectedRadius = `${String(expectedMaxHypot * 1.15)}px`;
    expect(radius).toBe(expectedRadius);
  });

  it('cleans up CSS custom properties after transition finishes', async () => {
    const finishedPromise = Promise.resolve();
    const mockTransition = { finished: finishedPromise };
    getDocumentRecord()['startViewTransition'] = vi.fn(() => mockTransition);

    triggerViewTransition({ x: 100, y: 200 }, vi.fn());

    // Properties are set initially
    expect(document.documentElement.style.getPropertyValue('--transition-x')).toBe('100px');

    // Wait for cleanup
    await finishedPromise;
    // Allow microtask to complete
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(document.documentElement.style.getPropertyValue('--transition-x')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--transition-y')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--transition-radius')).toBe('');
  });

  it('cleans up CSS custom properties even when transition is aborted', async () => {
    const finishedPromise = Promise.reject(new Error('aborted'));
    const mockTransition = { finished: finishedPromise };
    getDocumentRecord()['startViewTransition'] = vi.fn(() => mockTransition);

    triggerViewTransition({ x: 50, y: 75 }, vi.fn());

    // Wait for cleanup after rejection
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    expect(document.documentElement.style.getPropertyValue('--transition-x')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--transition-y')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--transition-radius')).toBe('');
  });
});
