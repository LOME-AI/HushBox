import { describe, it, expect, expectTypeOf } from 'vitest';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '@hushbox/shared';
import {
  A11Y_CLASS_RULES,
  A11Y_FONT_OVERRIDE_CLASS,
  fieldDomain,
  ruleValues,
  type A11yClassRule,
  type BooleanSchema,
} from './class-toggles';

describe('A11Y_CLASS_RULES', () => {
  it('names every class exactly once', () => {
    const names = A11Y_CLASS_RULES.map((rule) => rule.className);
    expect(new Set(names).size).toBe(names.length);
  });

  it('drives a rule for every value of every field it references', () => {
    for (const rule of A11Y_CLASS_RULES) {
      expect(ruleValues(rule).length).toBeGreaterThan(0);
    }
  });

  it('gives the custom-font class the whole fontFamily enum bar the default', () => {
    const rule = A11Y_CLASS_RULES.find((r) => r.className === A11Y_FONT_OVERRIDE_CLASS);
    expect(rule).toBeDefined();
    expect(ruleValues(rule!)).toEqual(['atkinson', 'open-dyslexic', 'lexend']);
  });

  it('turns an off-by-default focus ring into every non-off width', () => {
    const rule = A11Y_CLASS_RULES.find((r) => r.className === 'a11y-focus-strong');
    expect(rule).toBeDefined();
    expect(ruleValues(rule!)).toEqual(['2', '4', '6']);
  });

  it('leaves an explicit value set alone', () => {
    const rule = A11Y_CLASS_RULES.find((r) => r.className === 'a11y-contrast-high');
    expect(rule).toBeDefined();
    expect(ruleValues(rule!)).toEqual(['high']);
  });

  it('adds no line-height class at Normal line spacing', () => {
    const lineHeightValues = A11Y_CLASS_RULES.filter((r) => r.field === 'lineHeight').flatMap((r) =>
      ruleValues(r)
    );
    expect(lineHeightValues).not.toContain('1.5');
  });

  it('tightens line spacing with a11y-line-height-tight at Tight', () => {
    const rule = A11Y_CLASS_RULES.find((r) => r.className === 'a11y-line-height-tight');
    expect(rule).toBeDefined();
    expect(ruleValues(rule!)).toEqual(['1.0']);
  });

  it('widens line spacing with a11y-line-height-double at Wide', () => {
    const rule = A11Y_CLASS_RULES.find((r) => r.className === 'a11y-line-height-double');
    expect(rule).toBeDefined();
    expect(ruleValues(rule!)).toEqual(['2.0']);
  });
});

describe('fieldDomain', () => {
  it('reads an enum fields options from the schema', () => {
    expect(fieldDomain('contrast').allowed).toEqual(['normal', 'increased', 'high', 'low']);
  });

  it('gives a boolean field both values', () => {
    expect(fieldDomain('focusHalo').allowed).toEqual([true, false]);
  });

  it('takes the fallback from the schema defaults', () => {
    expect(fieldDomain('lineHeight').fallback).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.lineHeight);
  });

  it('throws for a field that is neither an enum nor a boolean', () => {
    expect(() => fieldDomain('version')).toThrow(/version/);
  });
});

describe('rule typing', () => {
  it('accepts a value the field enum carries', () => {
    expectTypeOf<{
      className: string;
      field: 'contrast';
      when: readonly ['high'];
    }>().toExtend<A11yClassRule>();
  });

  it('rejects a field the schema does not carry', () => {
    expectTypeOf<{
      className: string;
      field: 'contrastLevel';
      when: readonly ['high'];
    }>().not.toExtend<A11yClassRule>();
  });

  it('rejects a value outside the field own enum', () => {
    expectTypeOf<{
      className: string;
      field: 'contrast';
      when: readonly ['brighter'];
    }>().not.toExtend<A11yClassRule>();
  });

  it('accepts a boolean field schema as the non-enum case', () => {
    expectTypeOf<{ def: { type: 'boolean' } }>().toExtend<BooleanSchema>();
  });

  it('refuses a field schema that is neither an enum nor a boolean', () => {
    expectTypeOf<{ def: { type: 'number' } }>().not.toExtend<BooleanSchema>();
  });

  it('rejects an excluded value outside the field own enum', () => {
    expectTypeOf<{
      className: string;
      field: 'fontFamily';
      except: 'serif';
    }>().not.toExtend<A11yClassRule>();
  });
});
