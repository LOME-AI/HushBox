import { describe, it, expect } from 'vitest';
import { COLORBLIND_MATRICES, type ColorblindType } from './colorblind-matrices';

describe('COLORBLIND_MATRICES', () => {
  const expectedKeys: ColorblindType[] = ['protan', 'deutan', 'tritan', 'achroma', 'achromatomaly'];

  it('exposes the five expected colorblind transform keys', () => {
    const compare = (a: string, b: string): number => a.localeCompare(b);
    expect(Object.keys(COLORBLIND_MATRICES).toSorted(compare)).toEqual(
      [...expectedKeys].toSorted(compare)
    );
  });

  it.each(expectedKeys)('matrix %s has 20 numeric entries (4x5)', (key) => {
    const matrix = COLORBLIND_MATRICES[key];
    const tokens = matrix
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    expect(tokens).toHaveLength(20);
    for (const token of tokens) {
      expect(Number.isFinite(Number(token))).toBe(true);
    }
  });

  it('protan matrix starts with the canonical 0.567 red coefficient', () => {
    const tokens = COLORBLIND_MATRICES.protan.split(/\s+/).filter((token) => token.length > 0);
    expect(tokens[0]).toBe('0.567');
    expect(tokens[1]).toBe('0.433');
  });

  it('deutan matrix uses the canonical 0.625/0.375 first row', () => {
    const tokens = COLORBLIND_MATRICES.deutan.split(/\s+/).filter((token) => token.length > 0);
    expect(tokens[0]).toBe('0.625');
    expect(tokens[1]).toBe('0.375');
  });

  it('tritan matrix uses the canonical 0.95/0.05 first row', () => {
    const tokens = COLORBLIND_MATRICES.tritan.split(/\s+/).filter((token) => token.length > 0);
    expect(tokens[0]).toBe('0.95');
    expect(tokens[1]).toBe('0.05');
  });

  it('achroma matrix has identical RGB rows (luminance projection)', () => {
    const tokens = COLORBLIND_MATRICES.achroma.split(/\s+/).filter((token) => token.length > 0);
    // Rows are 5 tokens each; first three rows must be identical.
    const rowR = tokens.slice(0, 5);
    const rowG = tokens.slice(5, 10);
    const rowB = tokens.slice(10, 15);
    expect(rowR).toEqual(['0.299', '0.587', '0.114', '0', '0']);
    expect(rowG).toEqual(rowR);
    expect(rowB).toEqual(rowR);
  });

  it('achromatomaly matrix is a partial luminance projection', () => {
    const tokens = COLORBLIND_MATRICES.achromatomaly
      .split(/\s+/)
      .filter((token) => token.length > 0);
    expect(tokens[0]).toBe('0.618');
    expect(tokens[1]).toBe('0.320');
    expect(tokens[2]).toBe('0.062');
  });

  it('every matrix preserves alpha (fourth row 0 0 0 1 0)', () => {
    for (const key of expectedKeys) {
      const tokens = COLORBLIND_MATRICES[key].split(/\s+/).filter((token) => token.length > 0);
      const alphaRow = tokens.slice(15, 20);
      expect(alphaRow).toEqual(['0', '0', '0', '1', '0']);
    }
  });
});
