import { describe, expect, it } from 'vitest';
import countries110m from '../../../public/geo/countries-110m.json';
import statesAlbers10m from '../../../public/geo/states-albers-10m.json';
import { ISO_NUMERIC_TO_ALPHA2, alpha2ForGeometryId } from './iso-numeric-to-alpha2.js';
import { FIPS_TO_USPS, uspsForGeometryId } from './fips-to-usps.js';

/**
 * The tables exist to be applied to the vendored geometry, so the geometry is
 * what they are checked against: a table that drifts from the files beside it
 * leaves regions permanently unshaded, which looks like an absence of visitors
 * rather than a missing row.
 */
function geometryIds(topology: unknown, layer: string): readonly string[] {
  const objects = (topology as { objects: Record<string, { geometries: { id?: string }[] }> })
    .objects;
  const geometries = objects[layer]?.geometries ?? [];
  return geometries.flatMap((geometry) => (geometry.id === undefined ? [] : [geometry.id]));
}

describe('ISO_NUMERIC_TO_ALPHA2', () => {
  it('covers every country the vendored world geometry gives an id', () => {
    const unmapped = geometryIds(countries110m, 'countries').filter(
      (id) => ISO_NUMERIC_TO_ALPHA2[id] === undefined
    );
    expect(unmapped).toEqual([]);
  });

  it('maps every entry to a two-letter uppercase code', () => {
    const malformed = Object.values(ISO_NUMERIC_TO_ALPHA2).filter(
      (code) => !/^[A-Z]{2}$/.test(code)
    );
    expect(malformed).toEqual([]);
  });

  it('gives each country a distinct code', () => {
    const codes = Object.values(ISO_NUMERIC_TO_ALPHA2);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('alpha2ForGeometryId', () => {
  it('resolves a known numeric id to its alpha-2 code', () => {
    expect(alpha2ForGeometryId('840')).toBe('US');
  });

  it('returns nothing for a geometry the table does not name', () => {
    expect(alpha2ForGeometryId('999')).toBeNull();
  });
});

describe('FIPS_TO_USPS', () => {
  it('covers every state the vendored US geometry draws', () => {
    const unmapped = geometryIds(statesAlbers10m, 'states').filter(
      (id) => FIPS_TO_USPS[id] === undefined
    );
    expect(unmapped).toEqual([]);
  });

  it('names no state the geometry cannot draw', () => {
    const drawn = new Set(geometryIds(statesAlbers10m, 'states'));
    const undrawable = Object.keys(FIPS_TO_USPS).filter((id) => !drawn.has(id));
    expect(undrawable).toEqual([]);
  });

  it('maps every entry to a two-letter uppercase code', () => {
    const malformed = Object.values(FIPS_TO_USPS).filter((code) => !/^[A-Z]{2}$/.test(code));
    expect(malformed).toEqual([]);
  });

  it('gives each state a distinct code', () => {
    const codes = Object.values(FIPS_TO_USPS);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('uspsForGeometryId', () => {
  it('resolves a known FIPS id to its postal abbreviation', () => {
    expect(uspsForGeometryId('06')).toBe('CA');
  });

  it('returns nothing for a geometry the table does not name', () => {
    expect(uspsForGeometryId('72')).toBeNull();
  });
});
