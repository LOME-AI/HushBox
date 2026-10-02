import { describe, it, expect } from 'vitest';
import { linesInView } from './visible-lines';

describe('linesInView', () => {
  it('counts every line when the box ends below the last of them', () => {
    expect(linesInView([20, 40, 60], 100)).toBe(3);
  });

  it('stops at the first line whose foot falls past the edge of the box', () => {
    expect(linesInView([20, 40, 60, 80], 65)).toBe(3);
  });

  it('counts a line whose foot lands exactly on the edge', () => {
    expect(linesInView([20, 40, 60], 60)).toBe(3);
  });

  it('counts nothing when the box ends above the first line', () => {
    expect(linesInView([20, 40, 60], 10)).toBe(0);
  });

  it('counts every line where nothing was laid out at all', () => {
    expect(linesInView([0, 0, 0], 0)).toBe(3);
  });

  it('counts nothing where there is nothing painted', () => {
    expect(linesInView([], 100)).toBe(0);
  });
});
