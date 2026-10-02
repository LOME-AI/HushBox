import { describe, it, expect } from 'vitest';
import { isViewMode } from './view-mode';

describe('isViewMode', () => {
  it('recognises a mode the console can show', () => {
    expect(isViewMode('focus')).toBe(true);
  });

  it('rejects a mode the console has no view for', () => {
    expect(isViewMode('zoom')).toBe(false);
  });

  it('rejects a url that carried no mode at all', () => {
    expect(isViewMode(null)).toBe(false);
  });
});
