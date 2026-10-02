import { describe, it, expect } from 'vitest';
import { WRAP_LABELS, SEAL_LABELS, DERIVE_LABELS } from './labels.js';

const NAMESPACES = [
  ['wrap', WRAP_LABELS],
  ['seal', SEAL_LABELS],
  ['derive', DERIVE_LABELS],
] as const satisfies readonly (readonly [string, Readonly<Record<string, string>>])[];

describe('label registry', () => {
  it.each(NAMESPACES)('gives every %s label a distinct value', (_namespace, labels) => {
    const values = Object.values(labels);

    expect(new Set(values).size).toBe(values.length);
  });

  it.each(NAMESPACES)('gives every %s label a non-empty value', (_namespace, labels) => {
    const empty = Object.entries(labels).filter(([, value]) => value.length === 0);

    expect(empty).toEqual([]);
  });

  // Labels are composed into info strings as `${label}:${identifier}`
  // (recovery/dummy.ts). Prefix-freeness is what makes that composition
  // injective: if one label prefixed another, two purposes could build the same
  // info string from different identifiers and derive the same key.
  it.each(NAMESPACES)('makes no %s label a prefix of another', (_namespace, labels) => {
    const entries = Object.entries(labels);
    const prefixing = entries.flatMap(([name, value]) =>
      entries
        .filter(([otherName, otherValue]) => otherName !== name && otherValue.startsWith(value))
        .map(([otherName]) => `${name} prefixes ${otherName}`)
    );

    expect(prefixing).toEqual([]);
  });
});
